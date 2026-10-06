import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forwardedBlock, replyRecipients, responseHeaders, responseSubject } from '../packages/mail/src/respond';
import { assertRemoteIdentity, chooseTarget, MailActionsController, safeFilename } from '../apps/api/dist/mail-actions.js';
import { normalizedCid, safeEmailHtml, safeForwardText } from '../apps/api/src/webmail-html';

const source = {
  fromEmail: 'Jane@Example.test', fromName: 'Jane', messageIdHeader: '<root@example.test>', references: ['<earlier@example.test>', '<root@example.test>'],
  subject: 'Changed subject', date: new Date('2026-10-06T10:00:00Z'), textBody: 'Original body',
  recipients: [
    { type: 'REPLY_TO', email: 'replies@example.test', name: 'Reply desk' },
    { type: 'TO', email: 'SELF@example.test', name: null },
    { type: 'TO', email: 'replies@example.test', name: null },
    { type: 'TO', email: 'other@example.test', name: null },
    { type: 'CC', email: 'OTHER@example.test', name: null },
    { type: 'CC', email: 'cc@example.test', name: null },
    { type: 'BCC', email: 'hidden@example.test', name: null },
    { type: 'CC', email: 'invalid address', name: null },
  ],
};

test('reply and reply-all honor Reply-To, remove duplicates and sender, and never reconstruct BCC', () => {
  assert.deepEqual(replyRecipients(source, 'self@example.test', false).to.map(item => item.email), ['replies@example.test']);
  const all = replyRecipients(source, 'self@example.test', true);
  assert.deepEqual(all.to.map(item => item.email), ['replies@example.test', 'other@example.test']);
  assert.deepEqual(all.cc.map(item => item.email), ['cc@example.test']);
  assert.deepEqual(replyRecipients({ fromEmail: 'self@example.test', fromName: null, recipients: [] }, 'self@example.test', false).to.map(item => item.email), ['self@example.test']);
});

test('response threading headers, subject, and forwarded block preserve useful context', () => {
  assert.deepEqual(responseHeaders(source), { inReplyTo: '<root@example.test>', references: ['<earlier@example.test>', '<root@example.test>'] });
  assert.equal(responseSubject('REPLY', source), 'Re: Changed subject');
  assert.equal(responseSubject('FORWARD', { subject: 'Fwd: Existing' }), 'Fwd: Existing');
  assert.match(forwardedBlock(source), /From: Jane <Jane@Example.test>[\s\S]*To: SELF@example.test, replies@example.test, other@example.test[\s\S]*Original body/);
});

test('move targets require actual synchronized selectable special folders', () => {
  const folders = [{ id: 'inbox', specialUse: 'INBOX', isSelectable: true }, { id: 'trash', specialUse: 'TRASH', isSelectable: true }, { id: 'archive', specialUse: 'ARCHIVE', isSelectable: false }];
  assert.equal(chooseTarget('trash', folders, folders[0]!), 'trash');
  assert.equal(chooseTarget('archive', folders, folders[0]!), null);
  assert.equal(chooseTarget('restore', folders, folders[1]!), 'inbox');
});

test('stale UIDVALIDITY, UID, and read-only folders stop writes before any mutation', () => {
  const code = (expected: string) => (error: unknown) => (error as { getResponse: () => { code: string } }).getResponse().code === expected;
  assert.doesNotThrow(() => assertRemoteIdentity({ uidValidity: 42n, readOnly: false }, '42', { uid: 7 }, 7n, false));
  assert.throws(() => assertRemoteIdentity({ uidValidity: 43n, readOnly: false }, '42', { uid: 7 }, 7n, false), code('UIDVALIDITY_CHANGED'));
  assert.throws(() => assertRemoteIdentity({ uidValidity: 42n, readOnly: false }, '42', { uid: 8 }, 7n, false), code('MAILBOX_SYNC_REQUIRED'));
  assert.throws(() => assertRemoteIdentity({ uidValidity: 42n, readOnly: true }, '42', { uid: 7 }, 7n, false), code('IMAP_PERMISSION_DENIED'));
});

test('flag actions use exact UID, confirm remote flags, reconcile local state, and queue sync', async () => {
  const calls: string[] = [];
  const message = { id: 'message', mailboxId: 'box', folderId: 'folder', imapUid: 7n };
  const flags = new Set<string>();
  const client = {
    messageFlagsAdd: async (uid: string, values: string[], options: { uid: boolean }) => { assert.equal(uid, '7'); assert.equal(options.uid, true); values.forEach(value => flags.add(value)); calls.push('add'); return true; },
    messageFlagsRemove: async (uid: string, values: string[], options: { uid: boolean }) => { assert.equal(uid, '7'); assert.equal(options.uid, true); values.forEach(value => flags.delete(value)); calls.push('remove'); return true; },
    fetchOne: async () => ({ uid: 7, flags: new Set(flags) }),
  };
  const db = { $transaction: async (task: (tx: unknown) => Promise<void>) => task({ mailMessage: { updateMany: async ({ data }: { data: { isSeen: boolean; isFlagged: boolean } }) => { calls.push(`local:${data.isSeen}`); } }, auditLog: { create: async () => { calls.push('audit'); } } }) };
  const queue = { enqueue: async () => { calls.push('sync'); } };
  const controller = new MailActionsController(db as never, {} as never, queue as never);
  Object.assign(controller, { stored: async () => message, remote: async (_message: unknown, _readOnly: boolean, task: (client: unknown, remote: unknown, signal: AbortSignal) => Promise<unknown>) => task(client, { uid: 7 }, new AbortController().signal) });
  const request = { user: { id: 'admin' }, ip: '127.0.0.1' } as never;
  assert.equal((await controller.read('box', 'message', request)).isSeen, true);
  assert.equal((await controller.unread('box', 'message', request)).isSeen, false);
  assert.equal((await controller.flagMessage('box', 'message', request)).isFlagged, true);
  assert.equal((await controller.unflagMessage('box', 'message', request)).isFlagged, false);
  assert.deepEqual(calls.filter(item => item === 'add' || item === 'remove'), ['add', 'remove', 'add', 'remove']);
  assert.equal(calls.filter(item => item === 'sync').length, 4);
});

test('safe attachment names and CID mapping never expose paths or remote pixels', () => {
  assert.equal(safeFilename('..\\..\\secret.txt'), 'secret.txt');
  assert.equal(safeFilename('evil\r\nname.png'), 'evil__name.png');
  assert.equal(normalizedCid('<Picture@Example.test>'), 'picture@example.test');
  assert.equal(normalizedCid('<auto_cid_3663739167>'), 'auto_cid_3663739167');
  const html = safeEmailHtml('<img src="cid:Picture@Example.test"><img src="https://tracker.example.test/pixel">', false, { 'picture@example.test': '/api/v1/mailboxes/box/messages/msg/attachments/att?inline=1' });
  assert.match(html.html, /src="\/api\/v1\/mailboxes\/box\/messages\/msg\/attachments\/att\?inline=1"/);
  assert.doesNotMatch(html.html, /tracker.example.test/);
  assert.equal(html.hasRemoteImages, true);
  assert.equal(safeForwardText('<p>Hello <strong>reader</strong></p><script>steal()</script>'), 'Hello reader');
});
