import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../packages/database/generated/client';
import type { FetchMessageObject } from '../packages/mail/node_modules/imapflow/lib/imap-flow';
import { advanceCursor, classifySyncError, folderSpecialUse, initialUids, parseSyncMessage, type SyncMessage } from '../packages/mail/src/index';
import { encryptSecret } from '../packages/security/src/index';
import { processMailboxSync, saveMessage, shouldSyncMailbox, syncFolder, uidValidityChanged } from '../apps/worker/src/imap-sync';
import { withMailboxSyncLease } from '../apps/worker/src/sync-lease';

const metadata = (source: Buffer, extra: object = {}) => ({ seq: 1, uid: 42, size: source.length, flags: new Set(['\\Seen', '\\Flagged']), envelope: { subject: 'Fallback', from: [{ address: 'sender@example.test', name: 'Sender' }], to: [{ address: 'to@example.test' }] }, ...extra }) as FetchMessageObject;
const logger = { info() {}, warn() {}, error() {} } as never;
const config = { NODE_ENV: 'development', MAIL_SYNC_INITIAL_DAYS: 30, MAIL_SYNC_INITIAL_MAX_MESSAGES: 1000, MAIL_SYNC_MAX_MESSAGE_BYTES: 1024 * 1024, MAIL_SYNC_BATCH_SIZE: 250, MAIL_SYNC_FLAG_REFRESH_LIMIT: 0 } as never;

test('UID windows, cursor, and UIDVALIDITY keep folder identities safe', () => {
  assert.deepEqual(initialUids([9, 2, 9, 4, 1], 3), [2, 4, 9]);
  assert.equal(advanceCursor(9n, 10n, false), 9n);
  assert.equal(advanceCursor(9n, 10n, true), 10n);
  assert.equal(advanceCursor(10n, 9n, true), 10n);
  assert.equal(uidValidityChanged('123', '124'), true);
  assert.equal(uidValidityChanged('123', '123'), false);
  assert.equal(uidValidityChanged(null, '123'), false);
  assert.equal(folderSpecialUse({ path: 'INBOX.Sent Items', specialUse: '\\Trash', specialUseSource: 'extension' }), 'TRASH');
  assert.equal(folderSpecialUse({ path: 'INBOX.Spam' }), 'JUNK');
});

test('MIME parser stores Unicode, text, HTML, recipients, and attachment metadata', async () => {
  const source = Buffer.from([
    'From: Sender <sender@example.test>', 'To: Receiver <to@example.test>', 'Cc: cc@example.test', 'Reply-To: reply@example.test',
    'Subject: =?UTF-8?B?5L2g5aW9?=', 'Message-ID: <unique@example.test>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"', '', '--outer', 'Content-Type: multipart/alternative; boundary="inner"', '',
    '--inner', 'Content-Type: text/plain; charset=utf-8', '', 'Plain hello', '--inner', 'Content-Type: text/html; charset=utf-8', '', '<b>HTML hello</b>', '--inner--',
    '--outer', 'Content-Type: text/plain; name="file.txt"', 'Content-Disposition: attachment; filename="file.txt"', 'Content-Transfer-Encoding: base64', '', 'aGVsbG8=', '--outer--', '',
  ].join('\r\n'));
  const parsed = await parseSyncMessage(metadata(source), source, 1024 * 1024);
  assert.equal(parsed.subject, '你好');
  assert.match(parsed.textBody ?? '', /Plain hello/);
  assert.match(parsed.htmlBody ?? '', /HTML hello/);
  assert.deepEqual(parsed.recipients.map(item => item.type).sort(), ['CC', 'REPLY_TO', 'TO']);
  assert.equal(parsed.attachments[0]?.filename, 'file.txt');
  assert.equal(parsed.attachments[0]?.sizeBytes, 5n);
  assert.equal(parsed.isSeen, true);
  assert.equal(parsed.isFlagged, true);
  assert.equal(parsed.contentStatus, 'COMPLETE');
});

test('plain, malformed, and oversized sources do not crash or download unbounded content', async () => {
  const plain = Buffer.from('From: x@example.test\r\nSubject: Plain\r\n\r\nHello');
  assert.equal((await parseSyncMessage(metadata(plain), plain, 1024)).textBody?.trim(), 'Hello');
  const malformed = Buffer.from('From: <invalid>\nBroken-Header\n\nbody');
  assert.ok((await parseSyncMessage(metadata(malformed), malformed, 1024)).contentStatus);
  const large = await parseSyncMessage(metadata(plain, { size: 9999, bodyStructure: { type: 'multipart/mixed', childNodes: [{ type: 'application/pdf', part: '2', size: 2048, disposition: 'attachment', dispositionParameters: { filename: 'large.pdf' } }] } }), undefined, 1024);
  assert.equal(large.contentStatus, 'SKIPPED_TOO_LARGE');
  assert.equal(large.textBody, null);
  assert.equal(large.attachments[0]?.imapPart, '2');
  assert.equal(large.attachments[0]?.filename, 'large.pdf');
});

test('message transaction writes dependents before cursor, ignores duplicate UID, and stops on failure', async () => {
  const events: string[] = [];
  let existing: object | null = null;
  let failRecipient = false;
  const tx = {
    mailMessage: {
      findUnique: async () => existing,
      count: async () => 0,
      findMany: async () => [],
      create: async () => { events.push('message'); return { id: 'message-1' }; },
      update: async () => { events.push('flags'); },
    },
    mailRecipient: { createMany: async () => { events.push('recipients'); if (failRecipient) throw new Error('write failed'); } },
    mailAttachment: { createMany: async () => { events.push('attachments'); } },
    mailFolder: { findUniqueOrThrow: async () => ({ highestSyncedUid: 0n }), update: async () => { events.push('cursor'); } },
  };
  const db = { $transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx) } as unknown as PrismaClient;
  const data = { messageIdHeader: '<one@example.test>', references: [], inReplyTo: null, recipients: [{ type: 'TO', name: null, email: 'to@example.test' }], attachments: [{ filename: 'a.txt', contentType: 'text/plain', sizeBytes: 1n, contentId: null, disposition: 'attachment', imapPart: '2' }] } as SyncMessage;
  const flags = { isSeen: false, isFlagged: false, isAnswered: false, isDraft: false, isDeleted: false };
  assert.deepEqual(await saveMessage(db, 'box', 'folder', 1n, data, flags), { added: true, updated: false });
  assert.deepEqual(events, ['message', 'recipients', 'attachments', 'cursor']);
  events.length = 0;
  existing = { id: 'message-1', ...flags };
  assert.deepEqual(await saveMessage(db, 'box', 'folder', 1n, null, flags), { added: false, updated: false });
  assert.deepEqual(events, ['cursor']);
  events.length = 0; existing = null; failRecipient = true;
  await assert.rejects(saveMessage(db, 'box', 'folder', 2n, data, flags));
  assert.equal(events.includes('cursor'), false);
});

test('folder synchronization requires read-only selection and calls no remote write method', async () => {
  let released = false;
  let readOnlyOption: boolean | undefined;
  const folder = { id: 'folder', uidValidity: null, highestSyncedUid: 0n, lastSyncedAt: null };
  const db = { mailFolder: { upsert: async () => folder, update: async () => folder, findUniqueOrThrow: async () => ({ highestSyncedUid: 0n }) }, mailMessage: { findMany: async () => [] } } as unknown as PrismaClient;
  const client = { getMailboxLock: async (_: string, options: { readOnly?: boolean }) => { readOnlyOption = options.readOnly; return { release: () => { released = true; } }; }, mailbox: { readOnly: false, uidValidity: 1n, uidNext: 1, exists: 0 }, status: async () => ({ unseen: 0 }), search: async () => [] };
  const listed = { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set<string>() };
  await assert.rejects(syncFolder(db, client as never, 'box', listed as never, config, logger, 'run', new AbortController().signal), /IMAP_READ_ONLY_REQUIRED/);
  assert.equal(readOnlyOption, true);
  assert.equal(released, true);
  client.mailbox.readOnly = true;
  released = false;
  await syncFolder(db, client as never, 'box', listed as never, config, logger, 'run', new AbortController().signal);
  assert.equal(released, true);
});

test('UIDVALIDITY change clears only the affected local folder before searching', async () => {
  const events: string[] = [];
  const folder = { id: 'folder', uidValidity: '1', highestSyncedUid: 8n, lastSyncedAt: new Date() };
  const transaction = { mailMessage: { deleteMany: async (args: { where: { folderId: string } }) => { assert.equal(args.where.folderId, 'folder'); events.push('delete old namespace'); } }, mailFolder: { update: async () => { events.push('reset cursor'); } } };
  const db = {
    mailFolder: { upsert: async () => folder, update: async () => folder, findUniqueOrThrow: async () => ({ highestSyncedUid: 0n }) },
    mailMessage: { findMany: async () => [] },
    $transaction: async (work: (tx: typeof transaction) => Promise<void>) => work(transaction),
  } as unknown as PrismaClient;
  const client = { getMailboxLock: async () => ({ release() {} }), mailbox: { readOnly: true, uidValidity: 2n, uidNext: 2, exists: 1 }, status: async () => ({ unseen: 0 }), search: async () => { events.push('search new namespace'); return []; } };
  await syncFolder(db, client as never, 'box', { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set() } as never, config, logger, 'run', new AbortController().signal);
  assert.deepEqual(events, ['delete old namespace', 'reset cursor', 'search new namespace']);
});

test('disabled mailbox skips and missing credentials is a permanent recorded failure', async () => {
  assert.equal(shouldSyncMailbox({ isActive: false, status: 'UNKNOWN', credential: {}, mailServer: { status: 'ACTIVE', imapHost: 'mail.test', imapPort: 993 } }), false);
  let created = false;
  const disabled = { mailbox: { findUnique: async () => ({ isActive: false, status: 'DISABLED' }) }, mailSyncRun: { create: async () => { created = true; } } } as unknown as PrismaClient;
  await processMailboxSync(disabled, config, Buffer.alloc(32), logger, 'box', new AbortController().signal);
  assert.equal(created, false);
  const updates: object[] = [];
  const missingData = { mailbox: { findUnique: async () => ({ isActive: true, status: 'UNKNOWN', credential: null, mailServer: { status: 'ACTIVE', imapHost: 'mail.test', imapPort: 993 } }) }, mailSyncRun: { create: async () => ({ id: 'run' }), update: async (args: { data: object }) => { updates.push(args.data); } } };
  const missing = { ...missingData, $transaction: async (work: (tx: typeof missingData) => Promise<void>) => work(missingData) } as unknown as PrismaClient;
  await processMailboxSync(missing, config, Buffer.alloc(32), logger, 'box', new AbortController().signal);
  assert.deepEqual(updates[0], { status: 'FAILED', completedAt: (updates[0] as { completedAt: Date }).completedAt, foldersProcessed: 0, messagesAdded: 0, messagesUpdated: 0, errorCode: 'MAIL_CREDENTIAL_NOT_CONFIGURED', errorMessage: 'mail credential not configured' });
});

test('auth failure is normalized and not retried; temporary timeout is retryable', async () => {
  const key = randomBytes(32);
  const credential = { username: 'test', ...encryptSecret('secret', key) };
  const updates: Array<{ data: { errorCode?: string; status?: string } }> = [];
  const dbData = { mailbox: { findUnique: async () => ({ isActive: true, status: 'UNKNOWN', credential, mailServer: { status: 'ACTIVE', imapHost: 'mail.test', imapPort: 993, imapSecurity: 'TLS' } }) }, mailSyncRun: { create: async () => ({ id: 'run' }), update: async (args: { data: { errorCode?: string; status?: string } }) => { updates.push(args); } } };
  const db = { ...dbData, $transaction: async (work: (tx: typeof dbData) => Promise<void>) => work(dbData) } as unknown as PrismaClient;
  const client = { on() { return this; }, connect: async () => { throw { code: 'EAUTH', message: 'private diagnostic' }; }, usable: false, close() {} };
  await processMailboxSync(db, config, key, logger, 'box', new AbortController().signal, (() => client) as never);
  assert.equal(updates[0]?.data.errorCode, 'IMAP_AUTH_FAILED');
  assert.equal(updates[0]?.data.status, 'FAILED');
  assert.equal(classifySyncError({ code: 'ETIMEDOUT', message: 'private diagnostic' }).retryable, true);
  assert.equal(classifySyncError({ code: 'ETIMEDOUT', message: 'private diagnostic' }).message.includes('private'), false);
  const timedOut = { on() { return this; }, connect: async () => { throw { code: 'ETIMEDOUT', message: 'private diagnostic' }; }, usable: false, close() {} };
  await assert.rejects(processMailboxSync(db, config, key, logger, 'box', new AbortController().signal, (() => timedOut) as never), /IMAP_TIMEOUT/);
  assert.equal(updates[1]?.data.errorCode, 'IMAP_TIMEOUT');
});

test('per-mailbox lease skips overlapping work and releases only its own token', async () => {
  let held = false;
  let secondRan = false;
  let releaseFirst: (() => void) | undefined;
  const redis = { set: async () => held ? null : (held = true, 'OK'), eval: async (script: string) => { if (script.includes("'DEL'")) held = false; return 1; } } as never;
  const first = withMailboxSyncLease(redis, 'box', async () => new Promise<void>(resolve => { releaseFirst = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await withMailboxSyncLease(redis, 'box', async () => { secondRan = true; }), false);
  assert.equal(secondRan, false);
  releaseFirst?.();
  assert.equal(await first, true);
  assert.equal(held, false);
});
