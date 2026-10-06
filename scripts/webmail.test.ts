import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '../packages/database/generated/client';
import { headerId, threadKeyFor, type SyncMessage } from '../packages/mail/src/index';
import { saveMessage } from '../apps/worker/src/imap-sync';
import { safeEmailHtml, safePreview } from '../apps/api/src/webmail-html';
import { extraFolders, resolveFolder } from '../apps/web/src/lib/webmail-folders';

test('special-use folder resolution stays within the selected mailbox', () => {
  const folders = [
    { id: 'one-inbox', mailboxId: 'one', specialUse: 'INBOX', isSelectable: true },
    { id: 'two-inbox', mailboxId: 'two', specialUse: 'INBOX', isSelectable: true },
    { id: 'one-sent', mailboxId: 'one', specialUse: 'SENT', isSelectable: true },
    { id: 'one-drafts', mailboxId: 'one', specialUse: 'DRAFTS', isSelectable: true },
    { id: 'one-extra-sent', mailboxId: 'one', specialUse: 'SENT', isSelectable: true },
    { id: 'one-custom', mailboxId: 'one', specialUse: 'OTHER', isSelectable: true },
  ];
  assert.equal(resolveFolder(folders, 'one', 'INBOX')?.id, 'one-inbox');
  assert.equal(resolveFolder(folders, 'one', 'SENT')?.id, 'one-sent');
  assert.equal(resolveFolder(folders, 'one', 'DRAFTS')?.id, 'one-drafts');
  assert.equal(resolveFolder(folders, 'one', 'TRASH'), undefined);
  assert.equal(resolveFolder(folders, 'one', undefined, 'two-inbox'), undefined);
  assert.deepEqual(extraFolders(folders).filter(item => item.mailboxId === 'one').map(item => item.id), ['one-extra-sent', 'one-custom']);
});

test('thread keys use References and In-Reply-To, never subject alone', () => {
  const original = { references: [], inReplyTo: null, messageIdHeader: '<root@example.test>' };
  const reply = { references: ['<root@example.test>'], inReplyTo: '<root@example.test>', messageIdHeader: '<reply@example.test>' };
  assert.equal(headerId(' <ROOT@example.test> '), 'root@example.test');
  assert.equal(threadKeyFor(original, 'folder', 1n), threadKeyFor(reply, 'folder', 2n));
  assert.equal(threadKeyFor({ ...reply, references: [], inReplyTo: '<root@example.test>' }, 'folder', 3n), threadKeyFor(original, 'folder', 1n));
  assert.notEqual(threadKeyFor({ ...original, messageIdHeader: '<unrelated@example.test>' }, 'folder', 4n), threadKeyFor(original, 'folder', 1n));
  assert.notEqual(threadKeyFor({ references: [], inReplyTo: null, messageIdHeader: null }, 'folder', 5n), threadKeyFor({ references: [], inReplyTo: null, messageIdHeader: null }, 'folder', 6n));
  assert.equal(threadKeyFor({ ...reply, references: ['malformed', '<root@example.test>'] }, 'folder', 7n), threadKeyFor(original, 'folder', 1n));
});

test('a duplicate original Message-ID is isolated during persistence', async () => {
  let savedKey = '';
  const tx = { mailMessage: {
    findUnique: async () => null, count: async () => 1,
    create: async (args: { data: { threadKey: string } }) => { savedKey = args.data.threadKey; return { id: 'saved' }; },
  }, mailFolder: { findUniqueOrThrow: async () => ({ highestSyncedUid: 0n }), update: async () => ({}) }, mailRecipient: { createMany: async () => ({}) }, mailAttachment: { createMany: async () => ({}) } };
  const db = { $transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx) } as unknown as PrismaClient;
  const data = { messageIdHeader: '<duplicate@example.test>', references: [], inReplyTo: null, recipients: [], attachments: [] } as unknown as SyncMessage;
  await saveMessage(db, 'box', 'folder', 42n, data, { isSeen: false, isFlagged: false, isAnswered: false, isDraft: false, isDeleted: false });
  assert.equal(savedKey, 'local:folder:42');
});

test('HTML sanitizer removes executable content and blocks remote images by default', () => {
  const source = '<script>alert(1)</script><iframe src="https://evil.test"></iframe><p onclick="alert(1)"><strong>Hello</strong> <a href="javascript:alert(1)">bad</a><a href="https://example.test">good</a><img src="https://track.test/pixel" onerror="alert(1)" alt="photo"><img src="cid:abc" alt="inline"></p><table><tr><td>Cell</td></tr></table>';
  const blocked = safeEmailHtml(source, false);
  assert.equal(blocked.hasRemoteImages, true);
  assert.doesNotMatch(blocked.html, /<script|<iframe|onclick|onerror|javascript:|<img/i);
  assert.match(blocked.html, /<strong>Hello<\/strong>/);
  assert.match(blocked.html, /<table>/);
  assert.match(blocked.html, /https:\/\/example\.test/);
  const loaded = safeEmailHtml(source, true);
  assert.match(loaded.html, /<img src="https:\/\/track\.test\/pixel"/);
  assert.doesNotMatch(loaded.html, /cid:abc|onerror|javascript:/);
  assert.equal(safePreview(null, '<p>Hello <strong>world</strong></p>'), 'Hello world');
});
