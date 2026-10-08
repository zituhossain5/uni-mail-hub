import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '../packages/database/generated/client/index.js';
import argon2 from '../packages/database/node_modules/argon2/argon2.cjs';

const web = process.env.WEB_URL;
const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
assert(web && email && password, 'WEB_URL and seed admin credentials are required');
const db = new PrismaClient();
const suffix = Date.now().toString(36);
const ids = {};
let cookie;
async function call(path, { method = 'GET', body, authenticated = true, key } = {}) {
  const response = await fetch(`${web}/api/v1/${path}`, { method, headers: { Origin: web, ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
const threadKey = value => `h:${createHash('md5').update(value).digest('hex')}`;
try {
  let login;
  for (let attempt = 0; attempt < 8; attempt++) {
    login = await fetch(`${web}/api/v1/auth/login`, { method: 'POST', headers: { Origin: web, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (login.status !== 429) break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
  const project = await call('projects', { method: 'POST', body: { name: 'Module 5 smoke', slug: `module5-${suffix}` } });
  assert.equal(project.status, 201, JSON.stringify(project.data)); ids.project = project.data.id;
  const domain = await call('domains', { method: 'POST', body: { projectId: ids.project, domain: `module5-${suffix}.example.test` } });
  assert.equal(domain.status, 201, JSON.stringify(domain.data)); ids.domain = domain.data.id;
  const server = await call('mail-servers', { method: 'POST', body: { name: 'Module 5 Mailpit', providerType: 'GENERIC', imapHost: null, imapPort: null, imapSecurity: 'TLS', smtpHost: '127.0.0.1', smtpPort: 51025, smtpSecurity: 'NONE', smtpAuthMode: 'NONE' } });
  assert.equal(server.status, 201, JSON.stringify(server.data)); ids.server = server.data.id;
  const box = await call('mailboxes', { method: 'POST', body: { projectId: ids.project, domainId: ids.domain, mailServerId: ids.server, email: `reader@module5-${suffix}.example.test` } });
  assert.equal(box.status, 201, JSON.stringify(box.data)); ids.mailbox = box.data.id;
  const other = await call('mailboxes', { method: 'POST', body: { projectId: ids.project, domainId: ids.domain, mailServerId: ids.server, email: `other@module5-${suffix}.example.test` } });
  assert.equal(other.status, 201, JSON.stringify(other.data)); ids.other = other.data.id;
  const inbox = await db.mailFolder.create({ data: { mailboxId: ids.mailbox, path: 'INBOX', name: 'INBOX', specialUse: 'INBOX', messageCount: 58, unseenCount: 2, lastSyncedAt: new Date() } });
  const sent = await db.mailFolder.create({ data: { mailboxId: ids.mailbox, path: 'INBOX.Sent Items', name: 'Sent Items', specialUse: 'SENT', lastSyncedAt: new Date() } });
  const drafts = await db.mailFolder.create({ data: { mailboxId: ids.mailbox, path: 'INBOX.Drafts', name: 'Drafts', specialUse: 'DRAFTS', lastSyncedAt: new Date() } });
  const root = `root-${suffix}@example.test`;
  const base = Date.now() - 86400000;
  await db.mailMessage.createMany({ data: Array.from({ length: 55 }, (_, index) => ({ mailboxId: ids.mailbox, folderId: inbox.id, imapUid: BigInt(index + 1), messageIdHeader: `<solo-${index}-${suffix}@example.test>`, threadKey: threadKey(`solo-${index}-${suffix}@example.test`), subject: `Message ${index}`, textBody: `Preview for message ${index}`, fromEmail: `sender${index}@example.test`, internalDate: new Date(base - index * 60000), isSeen: index > 1 })) });
  const original = await db.mailMessage.create({ data: { mailboxId: ids.mailbox, folderId: inbox.id, imapUid: 56n, messageIdHeader: `<${root}>`, threadKey: threadKey(root), subject: 'Project question', textBody: 'Original plain text', fromEmail: 'john@example.test', internalDate: new Date(base + 1000), isSeen: false, recipients: { create: [{ type: 'TO', email: `reader@module5-${suffix}.example.test` }, { type: 'CC', email: `teammate-${suffix}@example.test` }, { type: 'REPLY_TO', email: `replydesk-${suffix}@example.test` }, { type: 'BCC', email: `hidden-${suffix}@example.test` }] } } });
  await db.mailMessage.create({ data: { mailboxId: ids.mailbox, folderId: inbox.id, imapUid: 57n, messageIdHeader: `<reply-${suffix}@example.test>`, inReplyTo: `<${root}>`, references: [`<${root}>`], threadKey: threadKey(root), subject: 'Re: Project question', textBody: 'Unicode reply 你好', fromEmail: 'jane@example.test', internalDate: new Date(base + 2000), isSeen: true } });
  const html = await db.mailMessage.create({ data: { mailboxId: ids.mailbox, folderId: inbox.id, imapUid: 58n, messageIdHeader: `<html-${suffix}@example.test>`, inReplyTo: `<${root}>`, references: [`<${root}>`], threadKey: threadKey(root), subject: 'Re: Project question', htmlBody: '<p onclick="alert(1)"><strong>Safe HTML</strong><script>alert(1)</script><img src="https://tracker.example.test/pixel" onerror="alert(1)"></p>', fromEmail: 'reader@example.test', internalDate: new Date(base + 3000), attachments: { create: [{ filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 425000n, imapPart: '2' }, { filename: 'large.bin', contentType: 'application/octet-stream', sizeBytes: 20000000n, imapPart: '3' }, { filename: 'bad.bin', contentType: 'application/octet-stream', sizeBytes: 10n, imapPart: '../' }] } } });
  await db.mailMessage.create({ data: { mailboxId: ids.mailbox, folderId: inbox.id, imapUid: 59n, messageIdHeader: `<unrelated-${suffix}@example.test>`, threadKey: threadKey(`unrelated-${suffix}@example.test`), subject: 'Project question', fromEmail: 'other@example.test', internalDate: new Date(base + 4000) } });
  await db.mailMessage.create({ data: { mailboxId: ids.mailbox, folderId: inbox.id, imapUid: 60n, threadKey: `local:${inbox.id}:60`, subject: 'No Message-ID', internalDate: new Date(base + 5000) } });
  assert.equal((await call('webmail/mailboxes', { authenticated: false })).status, 401);
  assert.equal((await call(`mailboxes/${ids.mailbox}/folders/${inbox.id}/threads`, { authenticated: false })).status, 401);
  const memberPassword = randomUUID();
  const member = await db.user.create({ data: { name: 'Module 5 member', email: `member-${suffix}@example.test`, passwordHash: await argon2.hash(memberPassword), role: 'MEMBER' } }); ids.member = member.id;
  const memberLogin = await fetch(`${web}/api/v1/auth/login`, { method: 'POST', headers: { Origin: web, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: member.email, password: memberPassword }) });
  assert.equal(memberLogin.status, 200);
  const memberCookie = memberLogin.headers.get('set-cookie')?.split(';')[0]; assert(memberCookie);
  for (const path of ['webmail/mailboxes', `mailboxes/${ids.mailbox}/folders/${inbox.id}/threads`, `mailboxes/${ids.mailbox}/messages/${original.id}`]) {
    assert.equal((await fetch(`${web}/api/v1/${path}`, { headers: { Cookie: memberCookie } })).status, 403);
  }
  const contexts = await call('webmail/mailboxes'); assert.equal(contexts.status, 200); assert(contexts.data.some(item => item.id === ids.mailbox));
  const folders = await call(`mailboxes/${ids.mailbox}/folders`); assert.equal(folders.status, 200);
  assert.equal(folders.data.find(item => item.id === sent.id).specialUse, 'SENT');
  assert.equal(folders.data.find(item => item.id === drafts.id).specialUse, 'DRAFTS');
  assert.equal((await call(`mailboxes/${ids.other}/folders/${inbox.id}/threads`)).status, 404);
  assert.equal((await call(`mailboxes/${ids.other}/messages/${original.id}`)).status, 404);
  const first = await call(`mailboxes/${ids.mailbox}/folders/${inbox.id}/threads`); assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.items.length, 50); assert(first.data.nextCursor);
  const second = await call(`mailboxes/${ids.mailbox}/folders/${inbox.id}/threads?cursor=${encodeURIComponent(first.data.nextCursor)}`);
  assert.equal(second.status, 200); assert.equal(second.data.items.length, 8); assert.equal(second.data.nextCursor, null);
  assert.equal(new Set([...first.data.items, ...second.data.items].map(item => item.threadKey)).size, 58);
  const conversation = first.data.items.find(item => item.threadKey === threadKey(root));
  assert.equal(conversation.messageCount, 3); assert.equal(conversation.unread, true); assert.equal(conversation.attachment, true);
  const detail = await call(`mailboxes/${ids.mailbox}/folders/${inbox.id}/threads/${conversation.threadKey}`); assert.equal(detail.status, 200);
  assert.equal(detail.data.items.length, 3); assert.equal(detail.data.items[0].id, original.id);
  assert.equal(detail.data.items[0].bodyLoaded, false);
  assert.equal(detail.data.items[1].bodyLoaded, false);
  assert.equal(detail.data.items[1].textBody, null);
  assert.match(detail.data.items[1].snippet, /\u4f60\u597d/);
  assert.equal(detail.data.items[2].bodyLoaded, true);
  const reply = await call(`mailboxes/${ids.mailbox}/messages/${detail.data.items[1].id}`);
  assert.equal(reply.status, 200);
  assert.match(reply.data.textBody, /\u4f60\u597d/);
  assert.doesNotMatch(detail.data.items[2].htmlBody, /<script|onclick|onerror|<img/);
  assert.equal(detail.data.items[2].hasRemoteImages, true);
  assert(detail.data.items[2].attachments.some(item => item.filename === 'invoice.pdf'));
  const remote = await call(`mailboxes/${ids.mailbox}/messages/${html.id}?remoteImages=true`); assert.equal(remote.status, 200); assert.match(remote.data.htmlBody, /<img src="https:\/\/tracker/);
  assert.equal((await call(`mailboxes/${ids.mailbox}/folders/${inbox.id}/threads?cursor=bad`)).status, 400);
  assert.equal((await fetch(`${web}/inbox?mailbox=${ids.mailbox}`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${web}/sent?mailbox=${ids.mailbox}`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${web}/drafts?mailbox=${ids.mailbox}`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${web}/mailboxes/${ids.mailbox}/folders/${inbox.id}/threads/${conversation.threadKey}`, { headers: { Cookie: cookie } })).status, 200);
  const sendKey = randomUUID();
  const outgoing = await call('admin/compose', { method: 'POST', key: sendKey, body: { fromMailboxId: ids.mailbox, to: [{ email: `destination-${suffix}@example.test` }], subject: `Module 5 compose ${suffix}`, text: 'Queued from webmail' } });
  assert.equal(outgoing.status, 202, JSON.stringify(outgoing.data)); ids.outgoing = outgoing.data.id;
  const duplicate = await call('admin/compose', { method: 'POST', key: sendKey, body: { fromMailboxId: ids.mailbox, to: [{ email: `destination-${suffix}@example.test` }], subject: `Module 5 compose ${suffix}`, text: 'Queued from webmail' } });
  assert.equal(duplicate.data.id, ids.outgoing);
  assert.equal((await db.outgoingMessage.findUniqueOrThrow({ where: { id: ids.outgoing }, select: { apiKeyId: true } })).apiKeyId, null);
  assert.equal((await call(`admin/messages/${ids.outgoing}`)).data.apiKey, null);
  let delivered = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await db.outgoingMessage.findUnique({ where: { id: ids.outgoing }, select: { status: true } });
    if (state?.status === 'SMTP_ACCEPTED') { delivered = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(delivered, 'Admin compose was not accepted by local Mailpit');
  assert.equal(await db.mailMessage.count({ where: { folderId: sent.id } }), 0);
  assert.equal((await call(`mailboxes/${ids.other}/messages/${original.id}/read`, { method: 'POST' })).status, 404);
  assert.equal((await call(`mailboxes/${ids.mailbox}/messages/${original.id}/read`, { method: 'POST', authenticated: false })).status, 401);
  const staleAction = await call(`mailboxes/${ids.mailbox}/messages/${original.id}/read`, { method: 'POST' });
  assert.equal(staleAction.status, 409); assert.equal(staleAction.data.code, 'MAILBOX_SYNC_REQUIRED');
  const attachmentByName = name => detail.data.items[2].attachments.find(item => item.filename === name);
  const invoiceId = attachmentByName('invoice.pdf').id;
  assert.equal((await call(`mailboxes/${ids.other}/messages/${html.id}/attachments/${invoiceId}`)).status, 404);
  const unsyncedAttachment = await call(`mailboxes/${ids.mailbox}/messages/${html.id}/attachments/${invoiceId}`);
  assert.equal(unsyncedAttachment.status, 409); assert.equal(unsyncedAttachment.data.code, 'MAILBOX_SYNC_REQUIRED');
  const tooLarge = await call(`mailboxes/${ids.mailbox}/messages/${html.id}/attachments/${attachmentByName('large.bin').id}`);
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.data.code, 'ATTACHMENT_TOO_LARGE');
  assert.equal((await call(`mailboxes/${ids.mailbox}/messages/${html.id}/attachments/${attachmentByName('bad.bin').id}`)).status, 404);
  const replyDraft = await call(`admin/compose/respond/${original.id}?fromMailboxId=${ids.mailbox}&kind=REPLY_ALL`);
  assert.equal(replyDraft.status, 200, JSON.stringify(replyDraft.data));
  assert.deepEqual(replyDraft.data.to.map(item => item.email), [`replydesk-${suffix}@example.test`]);
  assert.deepEqual(replyDraft.data.cc.map(item => item.email), [`teammate-${suffix}@example.test`]);
  assert.equal((await call(`admin/compose/respond/${original.id}?fromMailboxId=${ids.other}&kind=REPLY`)).status, 404);
  const replySend = await call('admin/compose/respond', { method: 'POST', key: randomUUID(), body: { fromMailboxId: ids.mailbox, sourceMessageId: original.id, kind: 'REPLY_ALL', text: 'Controlled reply-all smoke' } });
  assert.equal(replySend.status, 202, JSON.stringify(replySend.data));
  const storedReply = await db.outgoingMessage.findUniqueOrThrow({ where: { id: replySend.data.id }, include: { recipients: true } });
  assert.equal(storedReply.inReplyTo, `<${root}>`);
  assert.deepEqual(storedReply.references, [`<${root}>`]);
  assert.deepEqual(storedReply.recipients.filter(item => item.type === 'TO').map(item => item.email), [`replydesk-${suffix}@example.test`]);
  assert.deepEqual(storedReply.recipients.filter(item => item.type === 'CC').map(item => item.email), [`teammate-${suffix}@example.test`]);
  assert.equal(storedReply.recipients.some(item => item.type === 'BCC'), false);
  const forwardSend = await call('admin/compose/respond', { method: 'POST', key: randomUUID(), body: { fromMailboxId: ids.mailbox, sourceMessageId: original.id, kind: 'FORWARD', to: [{ email: `forward-${suffix}@example.test` }], text: 'Please review.' } });
  assert.equal(forwardSend.status, 202, JSON.stringify(forwardSend.data));
  const storedForward = await db.outgoingMessage.findUniqueOrThrow({ where: { id: forwardSend.data.id } });
  assert.equal(storedForward.inReplyTo, null); assert.match(storedForward.textBody, /Forwarded message[\s\S]*Original plain text/);
  for (const id of [replySend.data.id, forwardSend.data.id]) {
    let accepted = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const state = await db.outgoingMessage.findUnique({ where: { id }, select: { status: true } });
      if (state?.status === 'SMTP_ACCEPTED') { accepted = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(accepted, 'Response was not accepted by local Mailpit');
  }
  console.log('Module 5/6 smoke passed: webmail RBAC and pagination, safe HTML, stale action rejection, attachment ownership, Reply All recipient rules, threading headers, Forward content, and Mailpit SMTP acceptance.');
} finally {
  if (ids.project) {
    await db.webhookDelivery.deleteMany({ where: { event: { projectId: ids.project } } });
    await db.webhookEvent.deleteMany({ where: { projectId: ids.project } });
  }
  if (ids.project) await db.outgoingMessage.deleteMany({ where: { projectId: ids.project } });
  if (ids.mailbox || ids.other) await db.mailbox.deleteMany({ where: { id: { in: [ids.mailbox, ids.other].filter(Boolean) } } });
  if (ids.domain) await db.domain.deleteMany({ where: { id: ids.domain } });
  if (ids.project) await db.project.deleteMany({ where: { id: ids.project } });
  if (ids.server) await db.mailServer.deleteMany({ where: { id: ids.server } });
  if (ids.member) await db.user.deleteMany({ where: { id: ids.member } });
  await db.$disconnect();
}
