import { PrismaClient } from '@uni/database';
import { readConfig } from '@uni/config';
import { decryptSecret } from '@uni/security';
import { advanceCursor, classifySyncError, createSyncClient, folderSpecialUse, initialUids, parseSyncMessage, type SyncMessage } from '@uni/mail';
import type pino from 'pino';

type Config = ReturnType<typeof readConfig>;
type Logger = pino.Logger;
type Client = ReturnType<typeof createSyncClient>;

export function uidValidityChanged(previous: string | null, current: string): boolean {
  return previous !== null && previous !== current;
}

export function shouldSyncMailbox(mailbox: { isActive: boolean; status: string; credential: unknown; mailServer: { status: string; imapHost: string | null; imapPort: number | null } | null }): boolean {
  return mailbox.isActive && mailbox.status !== 'DISABLED' && !!mailbox.credential && mailbox.mailServer?.status === 'ACTIVE' && !!mailbox.mailServer.imapHost && !!mailbox.mailServer.imapPort;
}

function flagsOf(flags: Set<string> | undefined) {
  const value = flags ?? new Set<string>();
  return { isSeen: value.has('\\Seen'), isFlagged: value.has('\\Flagged'), isAnswered: value.has('\\Answered'), isDraft: value.has('\\Draft'), isDeleted: value.has('\\Deleted') };
}

export async function saveMessage(db: PrismaClient, mailboxId: string, folderId: string, uid: bigint, data: SyncMessage | null, flags: ReturnType<typeof flagsOf>) {
  return db.$transaction(async tx => {
    const existing = await tx.mailMessage.findUnique({ where: { folderId_imapUid: { folderId, imapUid: uid } }, select: { id: true, isSeen: true, isFlagged: true, isAnswered: true, isDraft: true, isDeleted: true } });
    let changed = false;
    if (existing) {
      changed = Object.entries(flags).some(([key, value]) => existing[key as keyof typeof flags] !== value);
      if (changed) await tx.mailMessage.update({ where: { id: existing.id }, data: flags });
    } else {
      if (!data) throw new Error('SYNC_SOURCE_MISSING');
      const { recipients, attachments, ...fields } = data;
      const record = await tx.mailMessage.create({ data: { mailboxId, folderId, imapUid: uid, ...fields } });
      if (recipients.length) await tx.mailRecipient.createMany({ data: recipients.map(recipient => ({ messageId: record.id, ...recipient })) });
      if (attachments.length) await tx.mailAttachment.createMany({ data: attachments.map(attachment => ({ messageId: record.id, ...attachment })) });
    }
    const folder = await tx.mailFolder.findUniqueOrThrow({ where: { id: folderId }, select: { highestSyncedUid: true } });
    const cursor = advanceCursor(folder.highestSyncedUid, uid, true);
    if (cursor !== folder.highestSyncedUid) await tx.mailFolder.update({ where: { id: folderId }, data: { highestSyncedUid: cursor } });
    return { added: !existing, updated: changed };
  });
}

async function refreshFlags(db: PrismaClient, client: Client, folderId: string, limit: number) {
  if (limit <= 0) return 0;
  const stored = await db.mailMessage.findMany({ where: { folderId }, orderBy: { imapUid: 'desc' }, take: limit, select: { id: true, imapUid: true, isSeen: true, isFlagged: true, isAnswered: true, isDraft: true, isDeleted: true } });
  if (!stored.length) return 0;
  const byUid = new Map(stored.map(item => [item.imapUid.toString(), item]));
  const remote = await client.fetchAll(stored.map(item => Number(item.imapUid)), { uid: true, flags: true }, { uid: true });
  let updated = 0;
  for (const item of remote) {
    const existing = byUid.get(String(item.uid));
    if (!existing) continue;
    const flags = flagsOf(item.flags);
    if (Object.entries(flags).some(([key, value]) => existing[key as keyof typeof flags] !== value)) {
      await db.mailMessage.update({ where: { id: existing.id }, data: flags });
      updated++;
    }
  }
  return updated;
}

export async function syncFolder(db: PrismaClient, client: Client, mailboxId: string, listed: Awaited<ReturnType<Client['list']>>[number], config: Config, log: Logger, runId: string, signal: AbortSignal) {
  if (signal.aborted) throw new Error('SYNC_LEASE_LOST');
  const selectable = ![...listed.flags].some(flag => flag.toLowerCase() === '\\noselect');
  let folder = await db.mailFolder.upsert({
    where: { mailboxId_path: { mailboxId, path: listed.path } },
    create: { mailboxId, path: listed.path, name: listed.name, delimiter: listed.delimiter || null, specialUse: folderSpecialUse(listed), isSelectable: selectable },
    update: { name: listed.name, delimiter: listed.delimiter || null, specialUse: folderSpecialUse(listed), isSelectable: selectable },
  });
  if (!selectable) return { added: 0, updated: 0 };
  const lock = await client.getMailboxLock(listed.path, { readOnly: true, acquireTimeout: 30000 });
  try {
    const selected = client.mailbox;
    if (!selected || selected.readOnly !== true) throw new Error('IMAP_READ_ONLY_REQUIRED');
    const snapshotUpperUid = BigInt(Math.max(0, selected.uidNext - 1));
    const validity = selected.uidValidity.toString();
    const reset = uidValidityChanged(folder.uidValidity, validity);
    if (reset) {
      await db.$transaction(async tx => {
        await tx.mailMessage.deleteMany({ where: { folderId: folder.id } });
        await tx.mailFolder.update({ where: { id: folder.id }, data: { uidValidity: validity, highestSyncedUid: 0n, lastSyncedAt: null } });
      });
      log.warn({ mailboxId, folderId: folder.id, runId }, 'UIDVALIDITY changed; local folder namespace rebuilt');
      folder = { ...folder, uidValidity: validity, highestSyncedUid: 0n, lastSyncedAt: null };
    } else if (folder.uidValidity !== validity) {
      folder = await db.mailFolder.update({ where: { id: folder.id }, data: { uidValidity: validity } });
    }
    let unseenCount: number | null = null;
    try { unseenCount = (await client.status(listed.path, { unseen: true })).unseen ?? null; } catch { /* count is optional */ }
    await db.mailFolder.update({ where: { id: folder.id }, data: { uidNext: BigInt(selected.uidNext), messageCount: selected.exists, unseenCount } });

    const initial = !folder.lastSyncedAt;
    const initialUidFloor = BigInt(Math.max(1, selected.uidNext - config.MAIL_SYNC_INITIAL_MAX_MESSAGES * 20));
    const searched = initial
      ? snapshotUpperUid > 0n ? await client.search({ since: new Date(Date.now() - config.MAIL_SYNC_INITIAL_DAYS * 86400000), uid: `${initialUidFloor}:${snapshotUpperUid}` }, { uid: true }) : []
      : await client.search({ uid: `${folder.highestSyncedUid + 1n}:*` }, { uid: true });
    const candidates = initial
      ? initialUids((searched || []).filter(uid => BigInt(uid) <= snapshotUpperUid), config.MAIL_SYNC_INITIAL_MAX_MESSAGES)
      : (searched || []).filter(uid => BigInt(uid) > folder.highestSyncedUid).sort((a, b) => a - b).slice(0, config.MAIL_SYNC_BATCH_SIZE);
    let added = 0;
    let updated = 0;
    for (const numberUid of candidates) {
      if (signal.aborted) throw new Error('SYNC_LEASE_LOST');
      const uid = BigInt(numberUid);
      const old = await db.mailMessage.findUnique({ where: { folderId_imapUid: { folderId: folder.id, imapUid: uid } }, select: { id: true } });
      const metadata = await client.fetchOne(String(numberUid), { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true }, { uid: true });
      if (!metadata) continue; // Removed on the server after SEARCH; the next run will search again.
      let parsed: SyncMessage | null = null;
      if (!old) {
        let source: Buffer | undefined;
        if (metadata.size === undefined || metadata.size <= config.MAIL_SYNC_MAX_MESSAGE_BYTES) {
          const fetched = await client.fetchOne(String(numberUid), { source: { maxLength: config.MAIL_SYNC_MAX_MESSAGE_BYTES + 1 } }, { uid: true });
          source = fetched ? fetched.source : undefined;
        }
        parsed = await parseSyncMessage(metadata, source, config.MAIL_SYNC_MAX_MESSAGE_BYTES);
      }
      const result = await saveMessage(db, mailboxId, folder.id, uid, parsed, flagsOf(metadata.flags));
      if (result.added) added++;
      if (result.updated) updated++;
    }
    if (initial) {
      const current = await db.mailFolder.findUniqueOrThrow({ where: { id: folder.id }, select: { highestSyncedUid: true } });
      if (snapshotUpperUid > current.highestSyncedUid) await db.mailFolder.update({ where: { id: folder.id }, data: { highestSyncedUid: snapshotUpperUid } });
    }
    updated += await refreshFlags(db, client, folder.id, config.MAIL_SYNC_FLAG_REFRESH_LIMIT);
    await db.mailFolder.update({ where: { id: folder.id }, data: { lastSyncedAt: new Date(), uidNext: BigInt(selected.uidNext), messageCount: selected.exists, unseenCount } });
    log.info({ mailboxId, folderId: folder.id, runId, added, updated }, 'folder synchronized');
    return { added, updated };
  } finally { lock.release(); }
}

export async function processMailboxSync(db: PrismaClient, config: Config, key: Buffer, log: Logger, mailboxId: string, signal: AbortSignal, createClient: typeof createSyncClient = createSyncClient) {
  const mailbox = await db.mailbox.findUnique({ where: { id: mailboxId }, include: { credential: true, mailServer: true } });
  if (!mailbox || !mailbox.isActive || mailbox.status === 'DISABLED') {
    log.info({ mailboxId }, 'mailbox sync skipped: mailbox inactive or missing');
    return;
  }
  const run = await db.mailSyncRun.create({ data: { mailboxId } });
  let client: Client | null = null;
  let foldersProcessed = 0;
  let messagesAdded = 0;
  let messagesUpdated = 0;
  let firstError: ReturnType<typeof classifySyncError> | null = null;
  try {
    const server = mailbox.mailServer;
    if (!server || server.status !== 'ACTIVE' || !server.imapHost || !server.imapPort) throw { code: 'MAIL_SERVER_DISABLED' };
    if (!mailbox.credential) throw { code: 'MAIL_CREDENTIAL_NOT_CONFIGURED' };
    if (config.NODE_ENV === 'production' && server.imapSecurity === 'NONE') throw { code: 'INSECURE_MAIL_SERVER' };
    const password = decryptSecret(mailbox.credential, key);
    client = createClient({ host: server.imapHost, port: server.imapPort, security: server.imapSecurity }, mailbox.credential.username, password);
    client.on('error', error => log.warn({ mailboxId, runId: run.id, errorCode: classifySyncError(error).code }, 'IMAP connection error'));
    await client.connect();
    const listed = await client.list();
    for (const folder of listed) {
      if (signal.aborted) throw new Error('SYNC_LEASE_LOST');
      try {
        const result = await syncFolder(db, client, mailboxId, folder, config, log, run.id, signal);
        foldersProcessed++;
        messagesAdded += result.added;
        messagesUpdated += result.updated;
      } catch (error) {
        firstError ??= classifySyncError(error);
        log.warn({ mailboxId, path: folder.path, runId: run.id, errorCode: classifySyncError(error).code }, 'folder synchronization failed');
        if (!client.usable) break;
      }
    }
    const status = firstError ? foldersProcessed ? 'PARTIAL' : 'FAILED' : 'SUCCESS';
    await db.mailSyncRun.update({ where: { id: run.id }, data: { status, completedAt: new Date(), foldersProcessed, messagesAdded, messagesUpdated, errorCode: firstError?.code, errorMessage: firstError?.message } });
    log.info({ mailboxId, runId: run.id, status, foldersProcessed, messagesAdded, messagesUpdated, errorCode: firstError?.code }, 'mailbox sync completed');
    if (firstError?.retryable) throw Object.assign(new Error(firstError.code), { syncRunRecorded: true });
  } catch (error) {
    if ((error as { syncRunRecorded?: boolean })?.syncRunRecorded) throw error;
    const specific = String((error as { code?: string })?.code ?? '');
    const normalized = ['MAIL_SERVER_DISABLED', 'MAIL_CREDENTIAL_NOT_CONFIGURED', 'INSECURE_MAIL_SERVER'].includes(specific)
      ? { code: specific, message: specific.replaceAll('_', ' ').toLowerCase(), retryable: false }
      : classifySyncError(error);
    await db.mailSyncRun.update({ where: { id: run.id }, data: { status: foldersProcessed ? 'PARTIAL' : 'FAILED', completedAt: new Date(), foldersProcessed, messagesAdded, messagesUpdated, errorCode: normalized.code, errorMessage: normalized.message } });
    log.warn({ mailboxId, runId: run.id, errorCode: normalized.code }, 'mailbox sync failed');
    if (normalized.retryable) throw new Error(normalized.code);
  } finally {
    if (client) {
      try { if (client.usable) await client.logout(); } catch { /* remote connection may already be gone */ }
      try { client.close(); } catch { /* socket cleanup is best effort */ }
    }
  }
}
