import assert from 'node:assert/strict';
import { PrismaClient } from '../packages/database/generated/client/index.js';

const web = process.env.WEB_URL;
const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
assert(web && email && password, 'WEB_URL and seed admin credentials are required');
const db = new PrismaClient();
const suffix = Date.now().toString(36);
const ids = {};
let cookie;
async function json(path, { method = 'GET', body, authenticated = true } = {}) {
  const response = await fetch(`${web}/api/v1/${path}`, { method, headers: { Origin: web, ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
try {
  const login = await fetch(`${web}/api/v1/auth/login`, { method: 'POST', headers: { Origin: web, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  const project = await json('projects', { method: 'POST', body: { name: 'Module 4 smoke', slug: `module4-${suffix}` } });
  assert.equal(project.status, 201, JSON.stringify(project.data)); ids.project = project.data.id;
  const domain = await json('domains', { method: 'POST', body: { projectId: ids.project, domain: `module4-${suffix}.example.test` } });
  assert.equal(domain.status, 201, JSON.stringify(domain.data)); ids.domain = domain.data.id;
  const server = await json('mail-servers', { method: 'POST', body: { name: 'Module 4 test endpoint', providerType: 'GENERIC', imapHost: '127.0.0.1', imapPort: 59993, imapSecurity: 'TLS', smtpHost: null, smtpPort: null, smtpSecurity: 'TLS', smtpAuthMode: 'PASSWORD' } });
  assert.equal(server.status, 201, JSON.stringify(server.data)); ids.server = server.data.id;
  const mailbox = await json('mailboxes', { method: 'POST', body: { projectId: ids.project, domainId: ids.domain, mailServerId: ids.server, email: `sync@module4-${suffix}.example.test` } });
  assert.equal(mailbox.status, 201, JSON.stringify(mailbox.data)); ids.mailbox = mailbox.data.id;
  assert.equal((await json(`mailboxes/${ids.mailbox}/sync-status`, { authenticated: false })).status, 401);
  assert.equal((await json(`mailboxes/${ids.mailbox}/sync`, { method: 'POST', authenticated: false })).status, 401);
  const empty = await json(`mailboxes/${ids.mailbox}/sync-status`);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.folderCount, 0);
  assert.equal(empty.data.messageCount, 0);
  assert.equal((await json(`mailboxes/${ids.mailbox}/sync`, { method: 'POST' })).data.code, 'MAIL_CREDENTIAL_NOT_CONFIGURED');

  const folder = await db.mailFolder.create({ data: { mailboxId: ids.mailbox, path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: 'INBOX', uidValidity: '123', highestSyncedUid: 4294967295n } });
  const message = await db.mailMessage.create({ data: { mailboxId: ids.mailbox, folderId: folder.id, imapUid: 4294967295n, subject: 'Synthetic metadata only', contentStatus: 'SKIPPED_TOO_LARGE', sizeBytes: 30000000n, recipients: { create: [{ type: 'TO', email: 'recipient@example.test' }] }, attachments: { create: [{ filename: 'large.pdf', contentType: 'application/pdf', sizeBytes: 30000000n, imapPart: '2' }] } } });
  await assert.rejects(db.mailMessage.create({ data: { mailboxId: ids.mailbox, folderId: folder.id, imapUid: 4294967295n } }), error => error.code === 'P2002');
  await db.mailSyncRun.create({ data: { mailboxId: ids.mailbox, status: 'SUCCESS', completedAt: new Date(), foldersProcessed: 1, messagesAdded: 1 } });
  const folders = await json(`mailboxes/${ids.mailbox}/folders`);
  assert.equal(folders.status, 200);
  assert.equal(folders.data[0].highestSyncedUid, '4294967295');
  const status = await json(`mailboxes/${ids.mailbox}/sync-status`);
  assert.equal(status.data.folderCount, 1);
  assert.equal(status.data.messageCount, 1);
  assert.equal(status.data.latest.status, 'SUCCESS');
  assert.equal((await json(`mailboxes/${ids.mailbox}/sync-history`)).data[0].messagesAdded, 1);
  assert.equal((await db.mailRecipient.count({ where: { messageId: message.id } })), 1);
  assert.equal((await db.mailAttachment.count({ where: { messageId: message.id } })), 1);
  assert.equal((await fetch(`${web}/mailboxes/${ids.mailbox}`, { headers: { Cookie: cookie } })).status, 200);
  console.log('Module 4 smoke passed: protected endpoints, missing-credential guard, folder/message schema, BigInt UID serialization, duplicate UID prevention, history, and mailbox page.');
} finally {
  if (ids.mailbox) await db.mailbox.deleteMany({ where: { id: ids.mailbox } });
  if (ids.domain) await db.domain.deleteMany({ where: { id: ids.domain } });
  if (ids.project) await db.project.deleteMany({ where: { id: ids.project } });
  if (ids.server) await db.mailServer.deleteMany({ where: { id: ids.server } });
  await db.$disconnect();
}
