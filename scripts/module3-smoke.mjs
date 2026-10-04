import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { PrismaClient } from '../packages/database/generated/client/index.js';

const api = process.env.API_URL;
const adminEmail = process.env.SEED_ADMIN_EMAIL;
const adminPassword = process.env.SEED_ADMIN_PASSWORD;
assert(api && adminEmail && adminPassword, 'API_URL and seed admin credentials are required');
const db = new PrismaClient();
const suffix = Date.now().toString(36);
let jwt; let projectId; let otherProjectId; let domainId; let otherDomainId; let mailboxId; let otherMailboxId; let ungrantedMailboxId; let failureMailboxId; let serverId; let failureServerId; let keyId; let secondKeyId; let messageId; let mockServer;
async function call(path, { method = 'GET', body, bearer, idempotencyKey } = {}) {
  const response = await fetch(`${api}/api/v1/${path}`, { method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function waitForStatus(id, bearer, wanted, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await call(`messages/${id}`, { bearer }); if (wanted.includes(result.data.status)) return result.data; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`Message ${id} did not reach ${wanted.join(', ')}`);
}
try {
  assert.equal((await call('messages', { method: 'POST', body: {} })).status, 401);
  const login = await call('auth/login', { method: 'POST', body: { email: adminEmail, password: adminPassword } });
  assert.equal(login.status, 201); jwt = login.data.token;
  const project = await call('projects', { method: 'POST', bearer: jwt, body: { name: 'Sending smoke', slug: `sending-${suffix}` } }); assert.equal(project.status, 201); projectId = project.data.id;
  const otherProject = await call('projects', { method: 'POST', bearer: jwt, body: { name: 'Other smoke', slug: `other-${suffix}` } }); assert.equal(otherProject.status, 201); otherProjectId = otherProject.data.id;
  const domain = await call('domains', { method: 'POST', bearer: jwt, body: { projectId, domain: `sending-${suffix}.example.com` } }); assert.equal(domain.status, 201); domainId = domain.data.id;
  const otherDomain = await call('domains', { method: 'POST', bearer: jwt, body: { projectId: otherProjectId, domain: `other-${suffix}.example.com` } }); assert.equal(otherDomain.status, 201); otherDomainId = otherDomain.data.id;
  const server = await call('mail-servers', { method: 'POST', bearer: jwt, body: { name: 'Mailpit send smoke', providerType: 'GENERIC', imapHost: null, imapPort: null, imapSecurity: 'TLS', smtpHost: '127.0.0.1', smtpPort: 51025, smtpSecurity: 'NONE', smtpAuthMode: 'NONE' } }); assert.equal(server.status, 201, JSON.stringify(server.data)); serverId = server.data.id;
  const mailbox = await call('mailboxes', { method: 'POST', bearer: jwt, body: { projectId, domainId, mailServerId: serverId, email: `sender@sending-${suffix}.example.com` } }); assert.equal(mailbox.status, 201); mailboxId = mailbox.data.id;
  const ungranted = await call('mailboxes', { method: 'POST', bearer: jwt, body: { projectId, domainId, mailServerId: serverId, email: `ungranted@sending-${suffix}.example.com` } }); assert.equal(ungranted.status, 201); ungrantedMailboxId = ungranted.data.id;
  const otherMailbox = await call('mailboxes', { method: 'POST', bearer: jwt, body: { projectId: otherProjectId, domainId: otherDomainId, mailServerId: serverId, email: `other@other-${suffix}.example.com` } }); assert.equal(otherMailbox.status, 201); otherMailboxId = otherMailbox.data.id;
  const key = await call('api-keys', { method: 'POST', bearer: jwt, body: { projectId, name: 'Website smoke', mailboxIds: [mailboxId] } }); assert.equal(key.status, 201, JSON.stringify(key.data)); keyId = key.data.id;
  const rawKey = key.data.rawKey; assert(rawKey?.startsWith('umh_test_'));
  const stored = await db.apiKey.findUnique({ where: { id: keyId } }); assert(stored && stored.keyHash !== rawKey); assert.equal(JSON.stringify(stored).includes(rawKey), false);
  assert.equal(JSON.stringify((await call(`api-keys/${keyId}`, { bearer: jwt })).data).includes(rawKey), false);
  assert.equal((await call('messages', { method: 'POST', bearer: 'umh_test_wrong', idempotencyKey: 'wrong', body: {} })).data.code, 'API_KEY_INVALID');
  const base = { fromMailboxId: mailboxId, to: [{ email: `recipient-${suffix}@example.test`, name: 'Mailpit recipient' }], bcc: [{ email: `blind-${suffix}@example.test` }], subject: 'Module 3 Mailpit test', text: `Hello from Uni Mail Hub ${suffix}` };
  const cross = await call('messages', { method: 'POST', bearer: rawKey, idempotencyKey: `cross-${suffix}`, body: { ...base, fromMailboxId: otherMailboxId } }); assert.equal(cross.data.code, 'SENDER_NOT_AUTHORIZED');
  const ungrantedResult = await call('messages', { method: 'POST', bearer: rawKey, idempotencyKey: `ungranted-${suffix}`, body: { ...base, fromMailboxId: ungrantedMailboxId } }); assert.equal(ungrantedResult.data.code, 'SENDER_NOT_AUTHORIZED');
  const before = await (await fetch('http://127.0.0.1:8025/api/v1/messages')).json();
  const idem = `send-${suffix}`;
  const sent = await call('messages', { method: 'POST', bearer: rawKey, idempotencyKey: idem, body: base }); assert.equal(sent.status, 202, JSON.stringify(sent.data)); messageId = sent.data.id;
  const completed = await waitForStatus(messageId, rawKey, ['SMTP_ACCEPTED', 'SMTP_ACCEPTED_WITH_REJECTIONS']); assert.equal(completed.status, 'SMTP_ACCEPTED');
  assert.equal(JSON.stringify(completed).includes(`blind-${suffix}`), false, 'client status must omit BCC');
  const again = await call('messages', { method: 'POST', bearer: rawKey, idempotencyKey: idem, body: base }); assert.equal(again.data.id, messageId);
  const changed = await call('messages', { method: 'POST', bearer: rawKey, idempotencyKey: idem, body: { ...base, subject: 'Changed' } }); assert.equal(changed.data.code, 'IDEMPOTENCY_CONFLICT');
  const attempts = await db.smtpAttempt.findMany({ where: { messageId } }); assert.equal(attempts.length, 1); assert.equal(attempts[0].status, 'ACCEPTED');
  const after = await (await fetch('http://127.0.0.1:8025/api/v1/messages')).json(); assert.equal(after.total, before.total + 1);
  const job = await db.outboxEvent.findFirst({ where: { messageId } }); assert(job);
  const admin = await call(`admin/messages/${messageId}`, { bearer: jwt }); assert.equal(admin.status, 200); assert.equal(admin.data.attempts.length, 1);
  let mockMode = 'permanent';
  mockServer = createServer(socket => {
    socket.setEncoding('utf8'); socket.write('220 mock ESMTP\r\n'); let pending = '';
    socket.on('data', chunk => { pending += chunk; while (pending.includes('\n')) { const index = pending.indexOf('\n'); const line = pending.slice(0, index).trim().toUpperCase(); pending = pending.slice(index + 1); if (line.startsWith('EHLO') || line.startsWith('HELO')) socket.write('250-mock\r\n250 PIPELINING\r\n'); else if (line.startsWith('MAIL FROM')) socket.write('250 sender ok\r\n'); else if (line.startsWith('RCPT TO')) socket.write(mockMode === 'permanent' ? '550 recipient rejected\r\n' : '451 temporary failure\r\n'); else if (line.startsWith('QUIT')) socket.end('221 bye\r\n'); else socket.write('250 ok\r\n'); } });
  });
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;
  const failureServer = await call('mail-servers', { method: 'POST', bearer: jwt, body: { name: 'Failure smoke', providerType: 'GENERIC', imapHost: null, imapPort: null, imapSecurity: 'TLS', smtpHost: '127.0.0.1', smtpPort: mockPort, smtpSecurity: 'NONE', smtpAuthMode: 'NONE' } }); assert.equal(failureServer.status, 201); failureServerId = failureServer.data.id;
  const failureMailbox = await call('mailboxes', { method: 'POST', bearer: jwt, body: { projectId, domainId, mailServerId: failureServerId, email: `failure@sending-${suffix}.example.com` } }); assert.equal(failureMailbox.status, 201); failureMailboxId = failureMailbox.data.id;
  const grants = await call(`api-keys/${keyId}/grants`, { method: 'PATCH', bearer: jwt, body: { mailboxIds: [mailboxId, failureMailboxId] } }); assert.equal(grants.status, 200);
  const badGrant = await call(`api-keys/${keyId}/grants`, { method: 'PATCH', bearer: jwt, body: { mailboxIds: [otherMailboxId] } }); assert.equal(badGrant.data.code, 'INVALID_MAILBOX_GRANT');
  const failingBody = { ...base, fromMailboxId: failureMailboxId };
  const permanent = await call('messages', { method: 'POST', bearer: rawKey, idempotencyKey: `permanent-${suffix}`, body: failingBody }); assert.equal(permanent.status, 202, JSON.stringify(permanent.data));
  await waitForStatus(permanent.data.id, rawKey, ['FAILED']);
  const firstFailure = await db.outgoingMessage.findUnique({ where: { id: permanent.data.id }, include: { attempts: true, recipients: true } }); assert.equal(firstFailure.lastErrorCode, 'SMTP_RECIPIENT_REJECTED'); assert.equal(firstFailure.attempts.length, 1); assert(firstFailure.recipients.every(recipient => recipient.smtpStatus === 'REJECTED'));
  const manual = await call(`admin/messages/${permanent.data.id}/retry`, { method: 'POST', bearer: jwt }); assert.equal(manual.status, 201);
  await waitForStatus(permanent.data.id, rawKey, ['FAILED']);
  const retried = await db.outgoingMessage.findUnique({ where: { id: permanent.data.id }, include: { attempts: true } }); assert.equal(retried.attempts.length, 2);
  mockMode = 'temporary';
  const temporary = await call('messages', { method: 'POST', bearer: rawKey, idempotencyKey: `temporary-${suffix}`, body: { ...failingBody, subject: 'Temporary SMTP failure' } }); assert.equal(temporary.status, 202);
  await waitForStatus(temporary.data.id, rawKey, ['RETRY_SCHEDULED']);
  const scheduled = await db.outgoingMessage.findUnique({ where: { id: temporary.data.id }, include: { attempts: true, outboxEvents: true } }); assert.equal(scheduled.lastErrorCode, 'SMTP_TEMPORARY_FAILURE'); assert.equal(scheduled.attempts.length, 1); assert(scheduled.outboxEvents.some(event => event.status === 'READY' && event.availableAt > new Date()));
  const secondKey = await call('api-keys', { method: 'POST', bearer: jwt, body: { projectId, name: 'Second website', mailboxIds: [mailboxId] } }); assert.equal(secondKey.status, 201); secondKeyId = secondKey.data.id;
  const secondSend = await call('messages', { method: 'POST', bearer: secondKey.data.rawKey, idempotencyKey: idem, body: base }); assert.equal(secondSend.status, 202); assert.notEqual(secondSend.data.id, messageId);
  await waitForStatus(secondSend.data.id, secondKey.data.rawKey, ['SMTP_ACCEPTED']);
  const appRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const { Queue } = appRequire('bullmq');
  const redisUrl = new URL(process.env.REDIS_URL);
  const duplicateQueue = new Queue('mail-send', { connection: { host: redisUrl.hostname, port: Number(redisUrl.port) } });
  try { await duplicateQueue.add('send', { messageId }, { jobId: `duplicate-${suffix}` }); await new Promise(resolve => setTimeout(resolve, 300)); } finally { await duplicateQueue.close(); }
  assert.equal((await db.smtpAttempt.count({ where: { messageId } })), 1, 'duplicate BullMQ job must not resend accepted message');
  const afterDuplicate = await (await fetch('http://127.0.0.1:8025/api/v1/messages')).json(); assert.equal(afterDuplicate.total, before.total + 2);
  const dashboard = await call('dashboard', { bearer: jwt });
  assert.equal(dashboard.status, 200);
  assert(dashboard.data.smtpAcceptedToday >= 2 && dashboard.data.failedToday >= 1 && dashboard.data.retryScheduledMessages >= 1, 'dashboard must reflect persisted outgoing states');
  await db.apiKey.update({ where: { id: secondKeyId }, data: { scopes: [] } });
  assert.equal((await call(`messages/${secondSend.data.id}`, { bearer: secondKey.data.rawKey })).data.code, 'API_KEY_SCOPE_DENIED');
  await db.apiKey.update({ where: { id: secondKeyId }, data: { scopes: ['MAIL_SEND'], expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await call(`messages/${secondSend.data.id}`, { bearer: secondKey.data.rawKey })).data.code, 'API_KEY_EXPIRED');
  const Redis = appRequire('ioredis');
  const rateRedis = new Redis(process.env.REDIS_URL);
  const windowSeconds = Number(process.env.MAIL_API_RATE_LIMIT_WINDOW_SECONDS || 60);
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const rateKey = `mail-api-rate:${keyId}:${bucket}`;
  try {
    await rateRedis.set(rateKey, String(Number(process.env.MAIL_API_RATE_LIMIT_MAX || 60)), 'EX', windowSeconds + 1);
    const limited = await call('messages', { method: 'POST', bearer: rawKey, idempotencyKey: `limited-${suffix}`, body: base });
    assert.equal(limited.status, 429); assert.equal(limited.data.code, 'RATE_LIMIT_EXCEEDED');
  } finally { await rateRedis.del(rateKey); await rateRedis.quit(); }
  const revoke = await call(`api-keys/${keyId}/revoke`, { method: 'POST', bearer: jwt }); assert.equal(revoke.status, 201);
  const denied = await call('messages', { method: 'POST', bearer: rawKey, idempotencyKey: `revoked-${suffix}`, body: base }); assert.equal(denied.data.code, 'API_KEY_REVOKED');
  assert.equal(JSON.stringify(admin.data).includes(rawKey), false);
  assert.equal(JSON.stringify(attempts).includes(rawKey), false);
  console.log('Module 3 smoke passed: key security, grants, rate limit, Mailpit delivery, BCC privacy, idempotency, duplicate job, permanent failure, temporary retry, manual retry, dashboard, revoke, admin history.');
} finally {
  if (projectId) await db.outgoingMessage.deleteMany({ where: { projectId } });
  if (keyId) await db.apiKey.deleteMany({ where: { id: keyId } });
  if (secondKeyId) await db.apiKey.deleteMany({ where: { id: secondKeyId } });
  if (mailboxId) await db.mailbox.deleteMany({ where: { id: mailboxId } });
  if (ungrantedMailboxId) await db.mailbox.deleteMany({ where: { id: ungrantedMailboxId } });
  if (otherMailboxId) await db.mailbox.deleteMany({ where: { id: otherMailboxId } });
  if (failureMailboxId) await db.mailbox.deleteMany({ where: { id: failureMailboxId } });
  if (domainId) await db.domain.deleteMany({ where: { id: domainId } });
  if (otherDomainId) await db.domain.deleteMany({ where: { id: otherDomainId } });
  if (serverId) await db.mailServer.deleteMany({ where: { id: serverId } });
  if (failureServerId) await db.mailServer.deleteMany({ where: { id: failureServerId } });
  if (projectId) await db.project.deleteMany({ where: { id: projectId } });
  if (otherProjectId) await db.project.deleteMany({ where: { id: otherProjectId } });
  await db.$disconnect();
  if (mockServer) await new Promise(resolve => mockServer.close(resolve));
}
