import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { readConfig } from '@uni/config';
import { createSyncClient, withMailboxSyncLease } from '@uni/mail';
import { decodeEncryptionKey, decryptSecret } from '@uni/security';
import { z } from 'zod';
import type { Response } from 'express';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AuthedRequest, Database, RedisConnection, SuperAdmin, parse } from './core';
import { RequirePermission } from './access';
import { ImapSyncQueue } from './imap-sync';
import { normalizedCid } from './webmail-html';

const idSchema = z.string().cuid();
const moveSchema = z.object({ folderId: idSchema }).strict();
const downloadSchema = z.object({ inline: z.enum(['1']).optional() });
const config = readConfig();
const key = decodeEncryptionKey(config.MAIL_CREDENTIAL_ENCRYPTION_KEY);
const problem = (code: string, message: string, status = 409) => new HttpException({ code, message }, status);
type Client = ReturnType<typeof createSyncClient>;
type Remote = Exclude<Awaited<ReturnType<Client['fetchOne']>>, boolean | undefined>;

export function safeFilename(value: string | null): string {
  const leaf = (value ?? 'attachment').replaceAll('\\', '/').split('/').at(-1) ?? 'attachment';
  return [...leaf].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || '"\\/<>:|?*'.includes(char) ? '_' : char).join('').trim().slice(0, 180) || 'attachment';
}

export function chooseTarget(kind: 'archive' | 'trash' | 'restore', folders: Array<{ id: string; specialUse: string; isSelectable: boolean }>, source: { id: string; specialUse: string }): string | null {
  const target = kind === 'archive' ? 'ARCHIVE' : kind === 'trash' ? 'TRASH' : 'INBOX';
  return folders.find(folder => folder.id !== source.id && folder.isSelectable && folder.specialUse === target)?.id ?? null;
}

export function assertRemoteIdentity(selected: { uidValidity: bigint; readOnly?: boolean } | false | undefined, expectedValidity: string, fetched: Remote | boolean | undefined, expectedUid: bigint, readOnly: boolean): asserts fetched is Remote {
  if (!selected || selected.uidValidity.toString() !== expectedValidity) throw problem('UIDVALIDITY_CHANGED', 'This folder changed on the server. Synchronize before trying again.');
  if (!readOnly && selected.readOnly) throw problem('IMAP_PERMISSION_DENIED', 'This folder is read-only.', 403);
  if (!fetched || typeof fetched === 'boolean' || BigInt(fetched.uid) !== expectedUid) throw problem('MAILBOX_SYNC_REQUIRED', 'This message is no longer at its synchronized UID. Synchronize before trying again.');
}

function actionError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  const code = String((error as { code?: string })?.code ?? '').toUpperCase();
  if (['NOPERM', 'PERMISSIONDENIED', 'AUTHORIZATIONFAILED'].includes(code)) return problem('IMAP_PERMISSION_DENIED', 'The mail server denied this action.', 403);
  return problem('IMAP_ACTION_FAILED', 'The mail server could not complete this action. Refresh and try again.', 502);
}

function partMatches(node: { part?: string; type?: string; id?: string; childNodes?: unknown[] } | undefined, part: string, contentType: string, cid: string | null): boolean {
  if (!node) return false;
  if (node.part === part) return node.type?.toLowerCase() === contentType.toLowerCase() && (!cid || normalizedCid(node.id ?? null) === cid);
  return (node.childNodes ?? []).some(child => partMatches(child as typeof node, part, contentType, cid));
}

@SuperAdmin()
@RequirePermission('mail.write')
@Controller('mailboxes/:mailboxId/messages/:messageId')
export class MailActionsController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(RedisConnection) private readonly redis: RedisConnection, @Inject(ImapSyncQueue) private readonly queue: ImapSyncQueue) {}

  private async stored(rawMailboxId: string, rawMessageId: string) {
    const mailboxId = parse(idSchema, rawMailboxId);
    const id = parse(idSchema, rawMessageId);
    const message = await this.db.mailMessage.findFirst({ where: { id, mailboxId }, include: { folder: true, mailbox: { include: { credential: true, mailServer: true } } } });
    if (!message) throw problem('MESSAGE_NOT_FOUND', 'Message not found in this mailbox.', 404);
    return message;
  }

  private async remote<T>(message: Awaited<ReturnType<MailActionsController['stored']>>, readOnly: boolean, task: (client: Client, remote: Remote, signal: AbortSignal) => Promise<T>): Promise<T> {
    let result: T | undefined;
    let completed = false;
    try {
      const operation = async (signal: AbortSignal) => {
        const mailbox = message.mailbox;
        const server = mailbox.mailServer;
        if (!mailbox.isActive || mailbox.status === 'DISABLED' || !mailbox.credential || !server || server.status !== 'ACTIVE' || !server.imapHost || !server.imapPort) throw problem('MAILBOX_SYNC_REQUIRED', 'Configure and synchronize this mailbox before acting on mail.');
        if (config.NODE_ENV === 'production' && server.imapSecurity === 'NONE') throw problem('IMAP_ACTION_FAILED', 'A secure IMAP connection is required.', 409);
        if (!message.folder.uidValidity || !message.folder.isSelectable) throw problem('MAILBOX_SYNC_REQUIRED', 'Synchronize this folder before acting on mail.');
        if (!Number.isSafeInteger(Number(message.imapUid)) || message.imapUid < 1n) throw problem('MAILBOX_SYNC_REQUIRED', 'This message needs a fresh synchronization.');
        const client = createSyncClient({ host: server.imapHost, port: server.imapPort, security: server.imapSecurity }, mailbox.credential.username, decryptSecret(mailbox.credential, key));
        client.on('error', () => { /* the request receives a normalized operation error */ });
        try {
          await client.connect();
          const lock = await client.getMailboxLock(message.folder.path, { readOnly, acquireTimeout: 30000 });
          try {
            const selected = client.mailbox;
            if (!selected || selected.uidValidity.toString() !== message.folder.uidValidity) throw problem('UIDVALIDITY_CHANGED', 'This folder changed on the server. Synchronize before trying again.');
            if (!readOnly && selected.readOnly) throw problem('IMAP_PERMISSION_DENIED', 'This folder is read-only.', 403);
            if (signal.aborted) throw problem('MAILBOX_SYNC_REQUIRED', 'Mailbox lock was lost. Refresh and try again.');
            const fetched = await client.fetchOne(message.imapUid.toString(), { uid: true, flags: true, envelope: true, bodyStructure: true }, { uid: true });
            assertRemoteIdentity(selected, message.folder.uidValidity, fetched, message.imapUid, readOnly);
            result = await task(client, fetched, signal);
            completed = true;
          } finally { lock.release(); }
        } finally {
          try { if (client.usable) await client.logout(); } catch { /* connection may be gone */ }
          try { client.close(); } catch { /* socket cleanup is best effort */ }
        }
      };
      let acquired = false;
      for (let attempt = 0; attempt < (readOnly ? 40 : 1); attempt++) {
        acquired = await withMailboxSyncLease(this.redis.client, message.mailboxId, operation);
        if (acquired) break;
        if (readOnly) await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!acquired) throw problem('MAILBOX_BUSY', 'Mailbox synchronization or another action is running. Try again shortly.');
      if (!completed) throw problem('IMAP_ACTION_FAILED', 'The mail server did not complete this action.', 502);
      return result as T;
    } catch (error) { throw actionError(error); }
  }

  private async flag(rawMailboxId: string, rawMessageId: string, flag: '\\Seen' | '\\Flagged', desired: boolean, request: AuthedRequest) {
    const message = await this.stored(rawMailboxId, rawMessageId);
    const action = flag === '\\Seen' ? desired ? 'MAIL_MARKED_READ' : 'MAIL_MARKED_UNREAD' : desired ? 'MAIL_FLAGGED' : 'MAIL_UNFLAGGED';
    let changed = false;
    try {
      const state = await this.remote(message, false, async (client, _remote, signal) => {
        const applied = desired ? await client.messageFlagsAdd(message.imapUid.toString(), [flag], { uid: true }) : await client.messageFlagsRemove(message.imapUid.toString(), [flag], { uid: true });
        if (!applied) throw problem('IMAP_ACTION_FAILED', 'The mail server rejected the flag change.', 502);
        changed = true;
        if (signal.aborted) throw problem('MAILBOX_SYNC_REQUIRED', 'Mailbox lock was lost. Synchronize before trying again.');
        const after = await client.fetchOne(message.imapUid.toString(), { uid: true, flags: true }, { uid: true });
        if (!after || typeof after === 'boolean' || BigInt(after.uid) !== message.imapUid) throw problem('MAILBOX_SYNC_REQUIRED', 'The message changed on the server. Synchronize before trying again.');
        if (!after.flags || after.flags.has(flag) !== desired) throw problem('IMAP_ACTION_FAILED', 'The server did not confirm the requested flag state.', 502);
        return { isSeen: after.flags?.has('\\Seen') ?? false, isFlagged: after.flags?.has('\\Flagged') ?? false };
      });
      await this.db.$transaction(async tx => {
        await tx.mailMessage.updateMany({ where: { id: message.id, folderId: message.folderId, imapUid: message.imapUid }, data: state });
        await tx.auditLog.create({ data: { userId: request.user.id, action, entityType: 'MailMessage', entityId: message.id, ipAddress: request.ip } });
      });
      return { status: 'success', messageId: message.id, folderId: message.folderId, ...state };
    } finally { if (changed) await this.queue.enqueue(message.mailboxId).catch(() => undefined); }
  }

  @Post('read') read(@Param('mailboxId') box: string, @Param('messageId') id: string, @Req() request: AuthedRequest) { return this.flag(box, id, '\\Seen', true, request); }
  @Post('unread') unread(@Param('mailboxId') box: string, @Param('messageId') id: string, @Req() request: AuthedRequest) { return this.flag(box, id, '\\Seen', false, request); }
  @Post('flag') flagMessage(@Param('mailboxId') box: string, @Param('messageId') id: string, @Req() request: AuthedRequest) { return this.flag(box, id, '\\Flagged', true, request); }
  @Post('unflag') unflagMessage(@Param('mailboxId') box: string, @Param('messageId') id: string, @Req() request: AuthedRequest) { return this.flag(box, id, '\\Flagged', false, request); }

  private async moveMessage(rawMailboxId: string, rawMessageId: string, targetId: string | null, action: string, request: AuthedRequest) {
    const message = await this.stored(rawMailboxId, rawMessageId);
    if (!targetId) throw problem('FOLDER_NOT_FOUND', 'The target folder is not available.', 404);
    const target = await this.db.mailFolder.findFirst({ where: { id: targetId, mailboxId: message.mailboxId, isSelectable: true } });
    if (!target) throw problem('FOLDER_NOT_FOUND', 'The target folder is not selectable in this mailbox.', 404);
    if (target.id === message.folderId) throw problem('FOLDER_NOT_FOUND', 'Choose a different folder.');
    let moved = false;
    try {
      await this.remote(message, false, async (client, _remote, signal) => {
        if (!client.capabilities.has('MOVE')) throw problem('IMAP_PERMISSION_DENIED', 'This server does not support a safe MOVE operation.', 409);
        if (signal.aborted) throw problem('MAILBOX_SYNC_REQUIRED', 'Mailbox lock was lost. Refresh and try again.');
        const result = await client.messageMove(message.imapUid.toString(), target.path, { uid: true });
        if (!result) throw problem('IMAP_ACTION_FAILED', 'The mail server rejected the move.', 502);
        moved = true;
      });
      await this.db.$transaction(async tx => {
        await tx.mailMessage.deleteMany({ where: { id: message.id, folderId: message.folderId, imapUid: message.imapUid } });
        await tx.auditLog.create({ data: { userId: request.user.id, action, entityType: 'MailMessage', entityId: message.id, ipAddress: request.ip } });
      });
      return { status: 'success', messageId: message.id, folderId: target.id };
    } finally { if (moved) await this.queue.enqueue(message.mailboxId).catch(() => undefined); }
  }

  @Post('move') async move(@Param('mailboxId') box: string, @Param('messageId') id: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    return this.moveMessage(box, id, parse(moveSchema, body).folderId, 'MAIL_MOVED', request);
  }
  @Post('trash') async trash(@Param('mailboxId') box: string, @Param('messageId') id: string, @Req() request: AuthedRequest) {
    const message = await this.stored(box, id);
    const folders = await this.db.mailFolder.findMany({ where: { mailboxId: message.mailboxId } });
    return this.moveMessage(box, id, chooseTarget('trash', folders, message.folder), 'MAIL_TRASHED', request);
  }
  @Post('archive') async archive(@Param('mailboxId') box: string, @Param('messageId') id: string, @Req() request: AuthedRequest) {
    const message = await this.stored(box, id);
    const folders = await this.db.mailFolder.findMany({ where: { mailboxId: message.mailboxId } });
    return this.moveMessage(box, id, chooseTarget('archive', folders, message.folder), 'MAIL_ARCHIVED', request);
  }
  @Post('restore') async restore(@Param('mailboxId') box: string, @Param('messageId') id: string, @Req() request: AuthedRequest) {
    const message = await this.stored(box, id);
    if (message.folder.specialUse !== 'TRASH') throw problem('FOLDER_NOT_FOUND', 'Restore is available for Trash messages only.');
    const folders = await this.db.mailFolder.findMany({ where: { mailboxId: message.mailboxId } });
    return this.moveMessage(box, id, chooseTarget('restore', folders, message.folder), 'MAIL_RESTORED', request);
  }

  @Get('attachments/:attachmentId') @RequirePermission('mail.read') async attachment(@Param('mailboxId') box: string, @Param('messageId') id: string, @Param('attachmentId') rawAttachmentId: string, @Query() rawQuery: unknown, @Req() request: AuthedRequest, @Res() response: Response) {
    const message = await this.stored(box, id);
    const attachmentId = parse(idSchema, rawAttachmentId);
    const inline = !!parse(downloadSchema, rawQuery).inline;
    const attachment = await this.db.mailAttachment.findFirst({ where: { id: attachmentId, messageId: message.id } });
    if (!attachment || !attachment.imapPart || !/^\d+(?:\.\d+)*$/.test(attachment.imapPart)) throw problem('ATTACHMENT_NOT_FOUND', 'This attachment is unavailable.', 404);
    if (!attachment.sizeBytes || attachment.sizeBytes > BigInt(config.MAIL_ATTACHMENT_MAX_BYTES)) throw problem('ATTACHMENT_TOO_LARGE', 'This attachment exceeds the configured retrieval limit.', 413);
    const cid = normalizedCid(attachment.contentId);
    if (inline && (!cid || !/^image\/(png|jpeg|gif|webp)$/.test(attachment.contentType.toLowerCase()))) throw problem('ATTACHMENT_NOT_FOUND', 'This inline image is unavailable.', 404);
    const name = safeFilename(attachment.filename);
    const mime = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(attachment.contentType) ? attachment.contentType.toLowerCase() : 'application/octet-stream';
    let downloaded = false;
    try {
      await this.remote(message, true, async (client, remote, signal) => {
        if (!partMatches(remote.bodyStructure, attachment.imapPart!, attachment.contentType, cid)) throw problem('ATTACHMENT_NOT_FOUND', 'Attachment metadata no longer matches the server. Synchronize and try again.', 404);
        if (signal.aborted) throw problem('MAILBOX_SYNC_REQUIRED', 'Mailbox lock was lost. Refresh and try again.');
        const result = await client.download(message.imapUid.toString(), attachment.imapPart!, { uid: true, maxBytes: config.MAIL_ATTACHMENT_MAX_BYTES + 1 });
        if (!result.content) throw problem('ATTACHMENT_NOT_FOUND', 'The attachment is unavailable on the server.', 404);
        let count = 0;
        const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) { count += chunk.length; callback(count > config.MAIL_ATTACHMENT_MAX_BYTES ? problem('ATTACHMENT_TOO_LARGE', 'Attachment retrieval limit exceeded.', 413) : null, chunk); } });
        response.setHeader('Content-Type', mime);
        response.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        await pipeline(result.content, bounded, response);
        downloaded = true;
      });
      if (downloaded) await this.db.auditLog.create({ data: { userId: request.user.id, action: 'ATTACHMENT_DOWNLOADED', entityType: 'MailAttachment', entityId: attachment.id, ipAddress: request.ip } });
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      throw actionError(error);
    }
  }
}
