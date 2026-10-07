import { Controller, Get, HttpException, Inject, Query } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@uni/database';
import { z } from 'zod';
import { Database, SuperAdmin, parse } from './core';
import { safePreview } from './webmail-html';

const id = z.string().cuid();
const folderUse = z.enum(['INBOX', 'SENT', 'DRAFTS', 'TRASH', 'JUNK', 'ARCHIVE', 'OTHER', 'ALL']);
const flag = z.enum(['true', 'false']);
const paramsSchema = z.object({
  q: z.string().trim().max(200).optional(),
  mailboxIds: z.string().max(5000).optional(),
  projectId: id.optional(),
  projectIds: z.string().max(5000).optional(),
  folder: folderUse.default('INBOX'),
  folderId: id.optional(),
  from: z.string().trim().toLowerCase().email().optional(),
  to: z.string().trim().toLowerCase().email().optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  unread: flag.optional(),
  flagged: flag.optional(),
  hasAttachment: flag.optional(),
  cursor: z.string().max(600).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

type Row = {
  id: string; mailboxId: string; folderId: string; threadKey: string; subject: string | null;
  fromName: string | null; fromEmail: string | null; at: Date; messageCount: bigint;
  unread: boolean; flagged: boolean; attachment: boolean; previewText: string | null; previewHtml: string | null;
  matchId: string; matchAt: Date; matchSubject: string | null; matchFromName: string | null; matchFromEmail: string | null;
  matchPreviewText: string | null; matchPreviewHtml: string | null;
  mailboxEmail: string; projectId: string; projectName: string; folderName: string; folderPath: string; folderSpecialUse: string;
};

function cursorValue(raw: string | undefined, scope: string): { at: Date; id: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (value.scope !== scope || !id.safeParse(value.id).success || typeof value.at !== 'string') throw new Error();
    const at = new Date(value.at);
    if (!Number.isFinite(at.getTime())) throw new Error();
    return { at, id: value.id };
  } catch { throw new HttpException({ code: 'INVALID_CURSOR', message: 'Invalid pagination cursor for these filters' }, 400); }
}

function token(at: Date, rowId: string, scope: string): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id: rowId, scope })).toString('base64url');
}

@SuperAdmin()
@Controller('mail/search')
export class MailSearchController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get() async search(@Query() raw: unknown) {
    const query = parse(paramsSchema, raw);
    const limit = query.limit ?? 50;
    const mailboxIds = query.mailboxIds ? [...new Set(query.mailboxIds.split(',').filter(Boolean))] : [];
    const projectIds = query.projectIds ? [...new Set(query.projectIds.split(',').filter(Boolean))] : [];
    if (mailboxIds.length > 100 || mailboxIds.some(value => !id.safeParse(value).success)) {
      throw new HttpException({ code: 'VALIDATION_ERROR', message: 'Invalid mailbox selection' }, 400);
    }
    if (projectIds.length > 100 || projectIds.some(value => !id.safeParse(value).success)) {
      throw new HttpException({ code: 'VALIDATION_ERROR', message: 'Invalid project selection' }, 400);
    }
    if (query.after && query.before && query.after > query.before) {
      throw new HttpException({ code: 'VALIDATION_ERROR', message: 'Date range is reversed' }, 400);
    }
    // This controller has the same SUPER_ADMIN boundary as existing webmail endpoints.
    // Requested IDs are checked before querying mail, so unknown IDs reveal no mailbox data.
    if (mailboxIds.length) {
      const count = await this.db.mailbox.count({ where: { id: { in: mailboxIds } } });
      if (count !== mailboxIds.length) throw new HttpException({ code: 'MAILBOX_NOT_FOUND', message: 'Mailbox selection unavailable' }, 404);
    }
    if (query.folderId) {
      const folder = await this.db.mailFolder.findFirst({ where: {
        id: query.folderId, ...(mailboxIds.length ? { mailboxId: { in: mailboxIds } } : {}),
      }, select: { id: true } });
      if (!folder) throw new HttpException({ code: 'FOLDER_NOT_FOUND', message: 'Folder selection unavailable' }, 404);
    }
    const scope = createHash('sha256').update(JSON.stringify({ ...query, cursor: undefined, mailboxIds, projectIds })).digest('hex').slice(0, 24);
    const cursor = cursorValue(query.cursor, scope);
    const q = query.q?.trim();
    const pattern = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const searchText = Prisma.sql`COALESCE(m.subject, '') || ' ' || COALESCE(m."fromName", '') || ' ' || COALESCE(m."fromEmail", '') || ' ' || COALESCE(m."textBody", '') || ' ' || COALESCE(m."messageIdHeader", '')`;
    const filters: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (mailboxIds.length) filters.push(Prisma.sql`m."mailboxId" IN (${Prisma.join(mailboxIds)})`);
    if (query.projectId) filters.push(Prisma.sql`b."projectId" = ${query.projectId}`);
    if (projectIds.length) filters.push(Prisma.sql`b."projectId" IN (${Prisma.join(projectIds)})`);
    if (query.folderId) filters.push(Prisma.sql`m."folderId" = ${query.folderId}`);
    else if (query.folder !== 'ALL') filters.push(Prisma.sql`f."specialUse" = ${query.folder}::"MailFolderSpecialUse"`);
    if (q) filters.push(Prisma.sql`(
      to_tsvector('simple', ${searchText}) @@ plainto_tsquery('simple', ${q})
      OR (${searchText}) ILIKE ${pattern} ESCAPE '\'
      OR EXISTS (SELECT 1 FROM "MailRecipient" r WHERE r."messageId" = m.id
        AND (COALESCE(r.name, '') || ' ' || r.email) ILIKE ${pattern} ESCAPE '\')
    )`);
    if (query.from) filters.push(Prisma.sql`LOWER(m."fromEmail") = ${query.from}`);
    if (query.to) filters.push(Prisma.sql`EXISTS (SELECT 1 FROM "MailRecipient" r WHERE r."messageId" = m.id AND r.type = 'TO'::"MailRecipientType" AND LOWER(r.email) = ${query.to})`);
    if (query.after) filters.push(Prisma.sql`COALESCE(m."internalDate", m.date, m."createdAt") >= ${query.after}`);
    if (query.before) {
      const rawBefore = (raw as Record<string, unknown>)?.before;
      if (typeof rawBefore === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawBefore)) {
        filters.push(Prisma.sql`COALESCE(m."internalDate", m.date, m."createdAt") < ${new Date(query.before.getTime() + 86400000)}`);
      } else filters.push(Prisma.sql`COALESCE(m."internalDate", m.date, m."createdAt") <= ${query.before}`);
    }
    if (query.unread === 'true') filters.push(Prisma.sql`NOT m."isSeen"`);
    if (query.unread === 'false') filters.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "MailMessage" x WHERE x."folderId" = m."folderId"
      AND COALESCE(x."threadKey", 'local:' || x.id) = COALESCE(m."threadKey", 'local:' || m.id) AND NOT x."isSeen")`);
    if (query.flagged === 'true') filters.push(Prisma.sql`m."isFlagged"`);
    if (query.flagged === 'false') filters.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "MailMessage" x WHERE x."folderId" = m."folderId"
      AND COALESCE(x."threadKey", 'local:' || x.id) = COALESCE(m."threadKey", 'local:' || m.id) AND x."isFlagged")`);
    if (query.hasAttachment === 'true') filters.push(Prisma.sql`EXISTS (SELECT 1 FROM "MailAttachment" a WHERE a."messageId" = m.id)`);
    if (query.hasAttachment === 'false') filters.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "MailMessage" x JOIN "MailAttachment" a ON a."messageId" = x.id
      WHERE x."folderId" = m."folderId" AND COALESCE(x."threadKey", 'local:' || x.id) = COALESCE(m."threadKey", 'local:' || m.id))`);

    const page = await this.db.$queryRaw<Row[]>(Prisma.sql`
      WITH matched AS (
        SELECT DISTINCT ON (m."mailboxId", m."folderId", COALESCE(m."threadKey", 'local:' || m.id))
          m."mailboxId", m."folderId", COALESCE(m."threadKey", 'local:' || m.id) AS "threadKey",
          m.id AS "matchId", COALESCE(m."internalDate", m.date, m."createdAt") AS "matchAt",
          m.subject AS "matchSubject", m."fromName" AS "matchFromName", m."fromEmail" AS "matchFromEmail",
          LEFT(m."textBody", 300) AS "matchPreviewText", LEFT(m."htmlBody", 1200) AS "matchPreviewHtml"
        FROM "MailMessage" m JOIN "MailFolder" f ON f.id = m."folderId" JOIN "Mailbox" b ON b.id = m."mailboxId"
        WHERE ${Prisma.join(filters, ' AND ')}
        ORDER BY m."mailboxId", m."folderId", COALESCE(m."threadKey", 'local:' || m.id),
          COALESCE(m."internalDate", m.date, m."createdAt") DESC, m.id DESC
      ), ranked AS (
        SELECT m.id, m."mailboxId", m."folderId", matched."threadKey", m.subject, m."fromName", m."fromEmail",
          COALESCE(m."internalDate", m.date, m."createdAt") AS at,
          COUNT(*) OVER (PARTITION BY m."mailboxId", m."folderId", matched."threadKey") AS "messageCount",
          BOOL_OR(NOT m."isSeen") OVER (PARTITION BY m."mailboxId", m."folderId", matched."threadKey") AS unread,
          BOOL_OR(m."isFlagged") OVER (PARTITION BY m."mailboxId", m."folderId", matched."threadKey") AS flagged,
          BOOL_OR(EXISTS (SELECT 1 FROM "MailAttachment" a WHERE a."messageId" = m.id)) OVER (PARTITION BY m."mailboxId", m."folderId", matched."threadKey") AS attachment,
          LEFT(m."textBody", 300) AS "previewText", LEFT(m."htmlBody", 1200) AS "previewHtml",
          matched."matchId", matched."matchAt", matched."matchSubject", matched."matchFromName", matched."matchFromEmail",
          matched."matchPreviewText", matched."matchPreviewHtml",
          ROW_NUMBER() OVER (PARTITION BY m."mailboxId", m."folderId", matched."threadKey"
            ORDER BY COALESCE(m."internalDate", m.date, m."createdAt") DESC, m.id DESC) AS rank
        FROM matched JOIN "MailMessage" m ON m."mailboxId" = matched."mailboxId" AND m."folderId" = matched."folderId"
          AND COALESCE(m."threadKey", 'local:' || m.id) = matched."threadKey"
      )
      SELECT ranked.id, ranked."mailboxId", ranked."folderId", ranked."threadKey", ranked.subject,
        ranked."fromName", ranked."fromEmail", ranked.at, ranked."messageCount", ranked.unread, ranked.flagged,
        ranked.attachment, ranked."previewText", ranked."previewHtml", ranked."matchId", ranked."matchAt",
        ranked."matchSubject", ranked."matchFromName", ranked."matchFromEmail",
        ranked."matchPreviewText", ranked."matchPreviewHtml", b.email AS "mailboxEmail", b."projectId",
        p.name AS "projectName", f.name AS "folderName", f.path AS "folderPath", f."specialUse"::text AS "folderSpecialUse"
      FROM ranked JOIN "Mailbox" b ON b.id = ranked."mailboxId" JOIN "Project" p ON p.id = b."projectId"
        JOIN "MailFolder" f ON f.id = ranked."folderId"
      WHERE ranked.rank = 1 ${cursor ? Prisma.sql`AND (ranked.at, ranked.id) < (${cursor.at}, ${cursor.id})` : Prisma.empty}
      ORDER BY ranked.at DESC, ranked.id DESC LIMIT ${limit + 1}
    `);
    const hasMore = page.length > limit;
    const items = page.slice(0, limit).map(({ previewText, previewHtml, matchPreviewText, matchPreviewHtml, messageCount, ...row }) => ({
      ...row, messageCount: Number(messageCount), snippet: safePreview(previewText, previewHtml),
      matchSnippet: safePreview(matchPreviewText, matchPreviewHtml), matchedOlderMessage: row.matchId !== row.id,
    }));
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? token(last.at, last.id, scope) : null };
  }
}
