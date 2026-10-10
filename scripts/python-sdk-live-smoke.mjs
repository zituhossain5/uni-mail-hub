import assert from 'node:assert/strict';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '../packages/database/generated/client/index.js';

const require = createRequire(import.meta.url);
const { ImapFlow } = require('../packages/mail/node_modules/imapflow');
const recipient = 'unimailhubtest@unicodeit.com';
const web = process.env.WEB_URL;
const apiUrl = process.env.API_URL;
const python = process.env.UNI_MAIL_HUB_TEST_PYTHON;
assert(web && apiUrl && python && process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD,
  'WEB_URL, API_URL, test Python executable, and seed admin credentials are required.');
const db = new PrismaClient();
let cookie;
let createdKeyId;

async function call(path, method = 'GET', body) {
  const response = await fetch(`${web}/api/v1/${path}`, {
    method,
    headers: { Origin: web, ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}, ${data.code ?? 'UNKNOWN'}`);
  return data;
}

function runPython(environment) {
  return new Promise((resolveRun, rejectRun) => {
    const script = resolve('clients/python/tests/live_smoke.py');
    const inherited = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
      .filter(name => process.env[name]).map(name => [name, process.env[name]]));
    const child = spawn(python, [script], {
      cwd: dirname(dirname(python)), env: { ...inherited, ...environment },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += value.toString().slice(0, 4096); });
    child.stderr.on('data', value => { stderr += value.toString().slice(0, 4096); });
    child.on('error', () => rejectRun(new Error('Python SDK process could not start.')));
    child.on('close', code => {
      if (code !== 0) rejectRun(new Error(`Python SDK live send failed: ${stderr ? 'Python process error' : stdout.slice(0, 200)}`));
      else { try { resolveRun(JSON.parse(stdout)); } catch { rejectRun(new Error('Python SDK returned an invalid smoke result.')); } }
    });
  });
}

async function readOnlySyntheticReceipt(mailboxId, subject) {
  const mailbox = await db.mailbox.findUnique({ where: { id: mailboxId },
    select: { credential: true, mailServer: true } });
  const credential = mailbox?.credential;
  const server = mailbox?.mailServer;
  if (!credential || !server?.imapHost || !server.imapPort) return false;
  const key = Buffer.from(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('Mailbox encryption key unavailable.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(credential.encryptionIv, 'base64'));
  decipher.setAuthTag(Buffer.from(credential.encryptionAuthTag, 'base64'));
  const password = Buffer.concat([decipher.update(Buffer.from(credential.encryptedPassword, 'base64')), decipher.final()]).toString('utf8');
  const client = new ImapFlow({ host: server.imapHost, port: server.imapPort,
    secure: server.imapSecurity === 'TLS', doSTARTTLS: server.imapSecurity === 'STARTTLS',
    auth: { user: credential.username, pass: password }, logger: false,
    disableAutoIdle: true, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
  try {
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    const matches = await client.search({ subject }, { uid: true });
    return matches !== false && matches.length > 0;
  } finally { try { await client.logout(); } catch { /* Connection may already be closed. */ } }
}

try {
  const mailbox = await db.mailbox.findUnique({ where: { email: recipient },
    select: { id: true, projectId: true, isActive: true, status: true, credential: { select: { id: true } } } });
  assert(mailbox?.isActive && mailbox.status !== 'DISABLED' && mailbox.credential,
    'Dedicated test mailbox must be active with a configured credential.');
  let login;
  for (let attempt = 0; attempt < 8; attempt++) {
    login = await fetch(`${web}/api/v1/auth/login`, { method: 'POST',
      headers: { Origin: web, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }) });
    if (login.status !== 429) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 10000));
  }
  assert.equal(login.status, 200, 'Admin login failed.');
  cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie?.startsWith('umh_session='));
  const runId = randomUUID();
  const created = await call('api-keys', 'POST', {
    projectId: mailbox.projectId, name: `Python SDK synthetic ${runId}`,
    mailboxIds: [mailbox.id], scopes: ['MAIL_SEND'], integration: true,
  });
  createdKeyId = created.id;
  assert(typeof created.rawKey === 'string' && created.rawKey.startsWith('umh_'));
  const result = await runPython({
    UNI_MAIL_HUB_URL: apiUrl, UNI_MAIL_HUB_API_KEY: created.rawKey,
    UNI_MAIL_HUB_MAILBOX_ID: mailbox.id, UNI_MAIL_HUB_TEST_RECIPIENT: recipient,
    UNI_MAIL_HUB_TEST_RUN_ID: runId,
  });
  assert.equal(result.status, 'SMTP_ACCEPTED', `SMTP status was ${result.status}`);
  const outgoing = await db.outgoingMessage.findMany({
    where: { apiKeyId: createdKeyId, idempotencyKey: result.idempotency_key },
    select: { id: true, status: true, fromMailboxId: true, recipients: { select: { email: true, type: true } } },
  });
  assert.equal(outgoing.length, 1, 'Idempotent retry must create one outgoing record.');
  assert.equal(outgoing[0].id, result.message_id);
  assert.equal(outgoing[0].status, 'SMTP_ACCEPTED');
  assert.equal(outgoing[0].fromMailboxId, mailbox.id);
  assert.deepEqual(outgoing[0].recipients, [{ email: recipient, type: 'TO' }]);

  let received = false;
  for (let attempt = 0; attempt < 2 && !received; attempt++) {
    await call(`mailboxes/${mailbox.id}/sync`, 'POST');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      received = Boolean(await db.mailMessage.findFirst({
        where: { mailboxId: mailbox.id, subject: result.subject, folder: { specialUse: 'INBOX' } },
        select: { id: true },
      }));
      if (received) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 2000));
    }
  }
  const directReceipt = received ? false : await readOnlySyntheticReceipt(mailbox.id, result.subject);
  assert(received || directReceipt, 'Synthetic message was not found in the dedicated mailbox Inbox.');
  console.log(`Python SDK live smoke passed: outgoing ${result.message_id} SMTP_ACCEPTED, one idempotent send, Inbox receipt ${received ? 'synchronized' : 'confirmed by read-only IMAP; sync delayed'}.`);
} finally {
  if (createdKeyId) {
    try { await call(`api-keys/${createdKeyId}/revoke`, 'POST'); }
    catch { console.error('Temporary test API key could not be revoked automatically.'); }
  }
  await db.$disconnect();
}
