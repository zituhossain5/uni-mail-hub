import { Controller, Get, HttpException, Inject, Param, Query } from '@nestjs/common';
import { Prisma } from '@uni/database';
import { z } from 'zod';
import { Database, SuperAdmin, parse } from './core';
import { safeEmailHtml, safePreview } from './webmail-html';

const idSchema = z.string().cuid();
const threadSchema = z.string().regex(/^(h:[a-f0-9]{32}|local:[A-Za-z0-9:_-]+)$/);
const pageSchema = z.object({ cursor: z.string().max(300).optional() });
const detailSchema = z.object({ remoteImages: z.enum(['true', 'false']).optional(), cursor: z.string().max(300).optional() });
const problem = (code: string, message: string, status = 404) => new HttpException({ code, message }, status);

type PageCursor = { at: string; id: string };
function decodeCursor(raw: string | undefined): PageCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as PageCursor;
    if (!value || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) || !idSchema.safeParse(value.id).success) throw new Error('invalid');
    return value;
  } catch { throw problem('INVALID_CURSOR', 'Invalid pagination cursor', 400); }
}
function encodeCursor(at: Date, id: string): string { return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url'); }

type ThreadRow = {
  id: string; threadKey: string; subject: string | null; fromName: string | null; fromEmail: string | null;
  at: Date; count: bigint; unread: boolean; flagged: boolean; attachment: boolean;
  previewText: string | null; previewHtml: string | null;
};

@SuperAdmin()
@Controller('webmail')
export class WebmailContextController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get('mailboxes') async mailboxes() {
    return this.db.mailbox.findMany({ orderBy: [{ project: { name: 'asc' } }, { email: 'asc' }], select: {
      id: true, email: true, displayName: true, projectId: true, project: { select: { name: true } },
      status: true, isActive: true, credential: { select: { id: true } },
      mailServer: { select: { status: true, imapHost: true, imapPort: true } },
      syncRuns: { orderBy: { startedAt: 'desc' }, take: 1, select: { status: true, completedAt: true, errorCode: true, errorMessage: true } },
    } });
  }
}

@SuperAdmin()
@Controller('mailboxes/:id')
export class WebmailMessagesController {
  constructor(@Inject(Database) private readonly db: Database) {}
  private async folder(rawId: string, rawFolder: string) {
    const mailboxId = parse(idSchema, rawId);
    const folderId = parse(idSchema, rawFolder);
    const folder = await this.db.mailFolder.findFirst({ where: { id: folderId, mailboxId }, select: { id: true, mailboxId: true, path: true, specialUse: true } });
    if (!folder) throw problem('FOLDER_NOT_FOUND', 'Folder not found for this mailbox');
    return folder;
  }

  @Get('folders/:folderId/threads') async list(@Param('id') rawId: string, @Param('folderId') rawFolder: string, @Query() rawQuery: unknown) {
    const folder = await this.folder(rawId, rawFolder);
    const cursor = decodeCursor(parse(pageSchema, rawQuery).cursor);
    const page = await this.db.$queryRaw<ThreadRow[]>(Prisma.sql`
      WITH ranked AS (
        SELECT m.id, COALESCE(m."threadKey", 'local:' || m.id) AS "threadKey", m.subject, m."fromName", m."fromEmail",
          COALESCE(m."internalDate", m.date, m."createdAt") AS at,
          COUNT(*) OVER (PARTITION BY COALESCE(m."threadKey", 'local:' || m.id)) AS count,
          BOOL_OR(NOT m."isSeen") OVER (PARTITION BY COALESCE(m."threadKey", 'local:' || m.id)) AS unread,
          BOOL_OR(m."isFlagged") OVER (PARTITION BY COALESCE(m."threadKey", 'local:' || m.id)) AS flagged,
          BOOL_OR(EXISTS (SELECT 1 FROM "MailAttachment" a WHERE a."messageId" = m.id)) OVER (PARTITION BY COALESCE(m."threadKey", 'local:' || m.id)) AS attachment,
          LEFT(m."textBody", 300) AS "previewText", LEFT(m."htmlBody", 1200) AS "previewHtml",
          ROW_NUMBER() OVER (PARTITION BY COALESCE(m."threadKey", 'local:' || m.id) ORDER BY COALESCE(m."internalDate", m.date, m."createdAt") DESC, m.id DESC) AS rank
        FROM "MailMessage" m WHERE m."folderId" = ${folder.id}
      )
      SELECT id, "threadKey", subject, "fromName", "fromEmail", at, count, unread, flagged, attachment, "previewText", "previewHtml"
      FROM ranked WHERE rank = 1 ${cursor ? Prisma.sql`AND (at, id) < (${new Date(cursor.at)}, ${cursor.id})` : Prisma.empty}
      ORDER BY at DESC, id DESC LIMIT 51
    `);
    const hasMore = page.length > 50;
    const items = page.slice(0, 50).map(({ previewText, previewHtml, count, ...row }) => ({ ...row, messageCount: Number(count), snippet: safePreview(previewText, previewHtml) }));
    const last = items.at(-1);
    return { folder, items, nextCursor: hasMore && last ? encodeCursor(last.at, last.id) : null };
  }

  @Get('folders/:folderId/threads/:threadKey') async thread(@Param('id') rawId: string, @Param('folderId') rawFolder: string, @Param('threadKey') rawKey: string, @Query() rawQuery: unknown) {
    const folder = await this.folder(rawId, rawFolder);
    const key = parse(threadSchema, rawKey);
    const query = parse(detailSchema, rawQuery);
    const cursor = decodeCursor(query.cursor);
    const positions = await this.db.$queryRaw<{ id: string; at: Date; previewText: string | null; previewHtml: string | null }[]>(Prisma.sql`
      SELECT id, COALESCE("internalDate", date, "createdAt") AS at, LEFT("textBody", 300) AS "previewText", LEFT("htmlBody", 1200) AS "previewHtml" FROM "MailMessage"
      WHERE "folderId" = ${folder.id} AND ("threadKey" = ${key} ${key.startsWith('local:') ? Prisma.sql`OR ("threadKey" IS NULL AND id = ${key.slice(6)})` : Prisma.empty})
      ${cursor ? Prisma.sql`AND (COALESCE("internalDate", date, "createdAt"), id) < (${new Date(cursor.at)}, ${cursor.id})` : Prisma.empty}
      ORDER BY at DESC, id DESC LIMIT 21
    `);
    const hasMore = positions.length > 20;
    const selected = positions.slice(0, 20);
    const messages = await this.db.mailMessage.findMany({ where: { id: { in: selected.map(item => item.id) }, folderId: folder.id }, select: {
      id: true, subject: true, date: true, internalDate: true, fromName: true, fromEmail: true, contentStatus: true, isSeen: true, isFlagged: true,
      recipients: { select: { type: true, name: true, email: true } }, attachments: { select: { filename: true, contentType: true, sizeBytes: true, disposition: true, contentId: true } },
    } });
    const byId = new Map(messages.map(message => [message.id, message]));
    const newest = !cursor && selected[0] ? await this.db.mailMessage.findFirst({ where: { id: selected[0].id, folderId: folder.id }, include: { recipients: { select: { type: true, name: true, email: true } }, attachments: { select: { filename: true, contentType: true, sizeBytes: true, disposition: true, contentId: true } } } }) : null;
    const items = [...selected].reverse().map(position => {
      const message = byId.get(position.id);
      if (!message) return null;
      const snippet = safePreview(position.previewText, position.previewHtml);
      if (newest?.id === message.id) return { ...this.serialize(newest, query.remoteImages === 'true'), snippet };
      return { ...message, textBody: null, htmlBody: null, hasRemoteImages: false, bodyLoaded: false, snippet, attachments: message.attachments.map(item => ({ ...item, sizeBytes: item.sizeBytes?.toString() ?? null })) };
    }).filter(item => item !== null);
    const oldest = selected.at(-1);
    return { folder, threadKey: key, items, nextCursor: hasMore && oldest ? encodeCursor(oldest.at, oldest.id) : null };
  }

  @Get('messages/:messageId') async message(@Param('id') rawId: string, @Param('messageId') rawMessageId: string, @Query() rawQuery: unknown) {
    const mailboxId = parse(idSchema, rawId);
    const messageId = parse(idSchema, rawMessageId);
    const query = parse(detailSchema, rawQuery);
    const message = await this.db.mailMessage.findFirst({ where: { id: messageId, mailboxId }, include: { recipients: { select: { type: true, name: true, email: true } }, attachments: { select: { filename: true, contentType: true, sizeBytes: true, disposition: true, contentId: true } } } });
    if (!message) throw problem('MESSAGE_NOT_FOUND', 'Message not found for this mailbox');
    return this.serialize(message, query.remoteImages === 'true');
  }

  private serialize<T extends { imapUid: bigint; sizeBytes: bigint | null; htmlBody: string | null; attachments: { sizeBytes: bigint | null }[] }>(message: T, remoteImages: boolean) {
    const sanitized = message.htmlBody ? safeEmailHtml(message.htmlBody, remoteImages) : null;
    return { ...message, imapUid: message.imapUid.toString(), htmlBody: sanitized?.html ?? null, hasRemoteImages: sanitized?.hasRemoteImages ?? false, bodyLoaded: true, sizeBytes: message.sizeBytes?.toString() ?? null, attachments: message.attachments.map(item => ({ ...item, sizeBytes: item.sizeBytes?.toString() ?? null })) };
  }
}
