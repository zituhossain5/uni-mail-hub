import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpanelMailboxParts, cpanelQuota, cpanelRequestSpec } from '../packages/mail/src/cpanel';
import { generateMailboxPassword } from '../apps/api/dist/cpanel-provisioning.js';
import { CpanelProvisioningController } from '../apps/api/dist/cpanel-provisioning.js';
import { ApiKeysController } from '../apps/api/dist/api-keys.js';
import { ProjectIntegrationController } from '../apps/api/dist/project-integration.js';
import { UniMail, UniMailError } from '../packages/uni-mail-client/src';
import { decodeEncryptionKey, decryptSecret, encryptSecret } from '../packages/security/src';
import { integrationExamples } from '../apps/web/src/lib/integration-examples';

const url = 'https://hub.example.test';
const mailboxId = 'cm12345678901234567890123';
const messageId = 'cm12345678901234567890124';

test('cPanel inputs distinguish finite quota and unlimited, and reject unsafe mailbox names', () => {
  assert.equal(cpanelQuota(null), '0');
  assert.equal(cpanelQuota(2048), '2048');
  assert.throws(() => cpanelQuota(0));
  assert.throws(() => cpanelQuota(-1));
  assert.throws(() => cpanelQuota(1.5));
  assert.deepEqual(cpanelMailboxParts('Contact@Example.com'), { email: 'contact@example.com', local: 'contact', domain: 'example.com' });
  assert.throws(() => cpanelMailboxParts('bad+alias@example.com'));
});

test('provisioning password has high entropy and can be stored encrypted', () => {
  const one = generateMailboxPassword();
  const two = generateMailboxPassword();
  assert.equal(one.length, 64);
  assert.notEqual(one, two);
  assert.match(one, /^[A-Za-z0-9_-]+$/);
  const key = decodeEncryptionKey(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY!);
  const stored = encryptSecret(one, key);
  assert.notEqual(stored.encryptedPassword, one);
  assert.equal(decryptSecret(stored, key), one);
});

test('cPanel password mutations use POST bodies without secrets in request paths', () => {
  const password = 'synthetic-secret-not-for-logs';
  for (const fn of ['add_pop', 'passwd_pop'] as const) {
    const spec = cpanelRequestSpec('Email', fn, { email: 'test@example.test', password }, true);
    assert.equal(spec.method, 'POST');
    assert.equal(spec.path, `/execute/Email/${fn}`);
    assert.equal(new URLSearchParams(spec.body).get('password'), password);
    assert.doesNotMatch(spec.path, /secret|password/);
  }
});

test('SDK sends the existing API contract with Bearer and automatic idempotency', async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const client = new UniMail({ baseUrl: url, apiKey: 'test-secret', mailboxId, fetch: (async (requestUrl, init) => {
    captured = { url: String(requestUrl), init: init! };
    return new Response(JSON.stringify({ id: messageId, status: 'QUEUED', createdAt: '2026-10-10T00:00:00.000Z' }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch });
  const result = await client.send({ to: 'client@example.com', cc: [{ email: 'copy@example.com', name: 'Copy' }], bcc: 'blind@example.com', replyTo: 'reply@example.com', subject: 'Hello', text: 'Hello', html: '<p>Hello</p>' });
  assert.equal(captured?.url, `${url}/api/v1/messages`);
  assert.equal(captured?.init.method, 'POST');
  const headers = captured?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer test-secret');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.match(headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.equal(result.idempotencyKey, headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(String(captured?.init.body)), {
    fromMailboxId: mailboxId,
    to: [{ email: 'client@example.com' }],
    cc: [{ email: 'copy@example.com', name: 'Copy' }],
    bcc: [{ email: 'blind@example.com' }],
    replyTo: { email: 'reply@example.com' },
    subject: 'Hello', text: 'Hello', html: '<p>Hello</p>',
  });
});

test('SDK preserves explicit retry key and normalizes API and network errors without exposing secrets', async () => {
  const client = new UniMail({ baseUrl: url, apiKey: 'never-print-this-key', mailboxId, fetch: (async () =>
    new Response(JSON.stringify({ code: 'SENDER_NOT_AUTHORIZED', message: 'internal stack and secret' }), { status: 403 })) as typeof fetch });
  await assert.rejects(client.send({ to: 'client@example.com', subject: 'Hello', text: 'Hello' }, { idempotencyKey: 'same-logical-send' }), error => {
    assert(error instanceof UniMailError);
    assert.equal(error.status, 403); assert.equal(error.code, 'SENDER_NOT_AUTHORIZED');
    assert.equal(error.idempotencyKey, 'same-logical-send');
    assert.doesNotMatch(error.message, /secret|stack/);
    return true;
  });
  const offline = new UniMail({ baseUrl: url, apiKey: 'never-print-this-key', mailboxId, fetch: (async () => { throw new Error('secret network detail'); }) as typeof fetch });
  await assert.rejects(offline.send({ to: 'client@example.com', subject: 'Hello', text: 'Hello' }), error => {
    assert(error instanceof UniMailError);
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.match(error.idempotencyKey!, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test('SDK getMessage is scoped to a safe id and uses the client GET route', async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const client = new UniMail({ baseUrl: url, apiKey: 'test-key', mailboxId, fetch: (async (requestUrl, init) => {
    captured = { url: String(requestUrl), init: init! };
    return new Response(JSON.stringify({ id: messageId, status: 'SMTP_ACCEPTED' }), { status: 200 });
  }) as typeof fetch });
  const result = await client.getMessage(messageId);
  assert.equal(result.status, 'SMTP_ACCEPTED');
  assert.equal(captured?.url, `${url}/api/v1/messages/${messageId}`);
  assert.equal(captured?.init.method, 'GET');
  await assert.rejects(client.getMessage('../admin'));
});

test('provisioning rejects an existing managed mailbox before any cPanel call', async () => {
  const accountId = 'c123456789012345678901230';
  const projectId = 'c123456789012345678901231';
  const domainId = 'c123456789012345678901232';
  const serverId = 'c123456789012345678901233';
  const fake = {
    cpanelAccount: { findUnique: async () => ({ id: accountId, status: 'ACTIVE' }) },
    domain: { findUnique: async () => ({ id: domainId, projectId, domain: 'example.test' }) },
    cpanelDiscoveredDomain: { findUnique: async () => null },
    mailbox: { findFirst: async () => ({ id: mailboxId }) },
  };
  const controller = new CpanelProvisioningController(fake as never);
  await assert.rejects(controller.provision(accountId, { projectId, domainId, email: 'taken@example.test', quotaMb: null, mailServerId: serverId }, { user: { id: 'admin' } } as never), error => {
    assert.equal((error as { getResponse: () => { code: string } }).getResponse().code, 'CPANEL_MAILBOX_EXISTS');
    return true;
  });
});

test('completed provisioning associates the selected mail server and commits only encrypted credentials', async () => {
  const accountId = 'c123456789012345678901230';
  const projectId = 'c123456789012345678901231';
  const domainId = 'c123456789012345678901232';
  const serverId = 'c123456789012345678901233';
  const email = 'synthetic@example.test';
  const password = 'synthetic-password-not-for-api-output';
  const encrypted = encryptSecret(password, decodeEncryptionKey(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY!));
  let createdMailbox: Record<string, unknown> | undefined;
  let storedCredential: Record<string, unknown> | undefined;
  let completedChange: Record<string, unknown> | undefined;
  let mailboxLookup = 0;
  const tx = {
    cpanelDiscoveredDomain: { findUnique: async () => null, upsert: async () => ({}) },
    cpanelDiscoveredMailbox: { findUnique: async () => null, upsert: async () => ({}) },
    mailServer: { findUnique: async () => ({ status: 'ACTIVE', providerType: 'CPANEL', imapHost: 'mail.example.test', imapPort: 993, smtpHost: 'mail.example.test', smtpPort: 465 }) },
    mailbox: {
      findUnique: async () => ++mailboxLookup === 1 ? null : { email, isActive: true, mailServer: { status: 'ACTIVE' } },
      create: async ({ data }: { data: Record<string, unknown> }) => { createdMailbox = data; return { id: mailboxId }; },
      update: async () => ({}),
    },
    mailboxCredential: { upsert: async ({ create }: { create: Record<string, unknown> }) => { storedCredential = create; } },
    cpanelMailboxChange: { update: async ({ data }: { data: Record<string, unknown> }) => { completedChange = data; } },
    auditLog: { create: async () => ({}) },
  };
  const controller = new CpanelProvisioningController({ $transaction: async (run: (db: typeof tx) => Promise<unknown>) => run(tx) } as never) as never as Record<string, (...args: never[]) => unknown>;
  const result = await controller.finish({ id: 'change-id', accountId, projectId, domainId, mailServerId: serverId, email, action: 'CREATE', quotaMb: 2048, ...encrypted }, { user: { id: 'admin' } });
  assert.deepEqual(result, { id: mailboxId, email });
  assert.equal(createdMailbox?.mailServerId, serverId);
  assert.equal(storedCredential?.mailboxId, mailboxId);
  assert.equal(decryptSecret(storedCredential as typeof encrypted, decodeEncryptionKey(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY!)), password);
  assert.equal(completedChange?.status, 'COMPLETED');
  assert.equal(completedChange?.encryptedPassword, null);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-password/);
});

test('rotation requires exact mailbox confirmation before changing cPanel or vault', async () => {
  const accountId = 'c123456789012345678901230';
  const fake = {
    cpanelAccount: { findUnique: async () => ({ id: accountId, status: 'ACTIVE' }) },
    mailbox: { findUnique: async () => ({ id: mailboxId, email: 'owner@example.test', projectId: 'project', mailServer: null }) },
    cpanelDiscoveredMailbox: { findFirst: async () => ({ id: 'discovery', state: 'MANAGED' }) },
  };
  const controller = new CpanelProvisioningController(fake as never);
  await assert.rejects(controller.rotate(accountId, mailboxId, { confirmEmail: 'other@example.test' }, { user: { id: 'admin' } } as never), error => {
    assert.equal((error as { getResponse: () => { code: string } }).getResponse().code, 'CONFIRMATION_REQUIRED');
    return true;
  });
});

test('rotation calls cPanel with the staged encrypted password and reports a vault failure as CRITICAL', async () => {
  const accountId = 'c123456789012345678901230';
  const email = 'synthetic@example.test';
  const key = decodeEncryptionKey(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY!);
  let cpanelPassword = '';
  let stagedPassword = '';
  let status = '';
  const fake = {
    cpanelAccount: { findUnique: async () => ({ id: accountId, status: 'ACTIVE' }) },
    mailbox: { findUnique: async () => ({ id: mailboxId, email, projectId: 'project', mailServer: null }) },
    cpanelDiscoveredMailbox: { findFirst: async () => ({ id: 'discovery', state: 'MANAGED' }) },
    cpanelMailboxChange: {
      findFirst: async () => null,
      create: async ({ data }: { data: { encryptedPassword: string; encryptionIv: string; encryptionAuthTag: string; encryptionVersion: number } }) => {
        stagedPassword = decryptSecret(data, key);
        return { id: 'change-id', ...data };
      },
      update: async ({ data }: { data: { status: string } }) => { status = data.status; },
    },
  };
  const controller = new CpanelProvisioningController(fake as never) as never as Record<string, (...args: never[]) => unknown>;
  controller.client = () => ({ changeMailboxPassword: async (_email: string, password: string) => { cpanelPassword = password; } });
  controller.finish = async () => { throw new Error('synthetic local vault outage'); };
  await assert.rejects(controller.rotate(accountId, mailboxId, { confirmEmail: email }, { user: { id: 'admin' } }), error => {
    assert.equal((error as { getResponse: () => { code: string } }).getResponse().code, 'CPANEL_RECOVERY_REQUIRED');
    return true;
  });
  assert.equal(cpanelPassword, stagedPassword);
  assert.equal(status, 'CRITICAL');
});

test('uncertain create recovery requires explicit cPanel review and reuses the escrowed password', async () => {
  const accountId = 'c123456789012345678901230';
  const email = 'synthetic@example.test';
  const password = 'escrowed-synthetic-password';
  const change = { id: 'c123456789012345678901231', accountId, email, action: 'CREATE', status: 'PREPARED', errorCode: null,
    ...encryptSecret(password, decodeEncryptionKey(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY!)) };
  let sentPassword = '';
  const fake = {
    cpanelAccount: { findUnique: async () => ({ id: accountId, status: 'ACTIVE' }) },
    cpanelMailboxChange: { findFirst: async () => change },
  };
  const controller = new CpanelProvisioningController(fake as never) as never as Record<string, (...args: never[]) => unknown>;
  controller.client = () => ({
    listMailboxes: async () => [{ email }],
    changeMailboxPassword: async (_email: string, supplied: string) => { sentPassword = supplied; },
  });
  controller.finish = async () => ({ id: mailboxId, email });
  const request = { user: { id: 'admin' } };
  await assert.rejects(controller.recover(accountId, change.id, { confirmEmail: email }, request), error => {
    assert.equal((error as { getResponse: () => { code: string } }).getResponse().code, 'CPANEL_REVIEW_REQUIRED');
    return true;
  });
  assert.equal(sentPassword, '');
  const result = await controller.recover(accountId, change.id, { confirmEmail: email, confirmRemoteExists: true }, request) as { recovered: boolean };
  assert.equal(sentPassword, password);
  assert.equal(result.recovered, true);
});

test('quota updates reject zero and deletion disables the managed mailbox without deleting history', async () => {
  const accountId = 'c123456789012345678901230';
  const email = 'synthetic@example.test';
  let remoteQuota: number | null | undefined;
  let remoteDelete = false;
  const mailboxWrites: unknown[] = [];
  const fake = {
    cpanelAccount: { findUnique: async () => ({ id: accountId, status: 'ACTIVE' }) },
    mailbox: { findUnique: async () => ({ id: mailboxId, email, projectId: 'project', mailServer: null }) },
    cpanelDiscoveredMailbox: { findFirst: async () => ({ id: 'discovery', state: 'MANAGED' }) },
    cpanelMailboxChange: { findFirst: async () => null },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
      cpanelDiscoveredMailbox: { update: async () => ({}) },
      mailbox: { update: async (input: unknown) => { mailboxWrites.push(input); } },
      auditLog: { create: async () => ({}) },
    }),
  };
  const controller = new CpanelProvisioningController(fake as never) as never as Record<string, (...args: never[]) => unknown>;
  controller.client = () => ({
    changeMailboxQuota: async (_email: string, quota: number | null) => { remoteQuota = quota; },
    deleteMailbox: async () => { remoteDelete = true; },
  });
  const request = { user: { id: 'admin' } };
  await assert.rejects(controller.quota(accountId, mailboxId, { quotaMb: 0 }, request));
  assert.equal(remoteQuota, undefined);
  await controller.quota(accountId, mailboxId, { quotaMb: null }, request);
  assert.equal(remoteQuota, null);
  await controller.quota(accountId, mailboxId, { quotaMb: 2048 }, request);
  assert.equal(remoteQuota, 2048);
  await assert.rejects(controller.remove(accountId, mailboxId, { confirmEmail: 'wrong@example.test' }, request));
  assert.equal(remoteDelete, false);
  await controller.remove(accountId, mailboxId, { confirmEmail: email }, request);
  assert.equal(remoteDelete, true);
  assert.deepEqual(mailboxWrites, [{ where: { id: mailboxId }, data: { isActive: false, status: 'DISABLED', lastError: 'Mailbox deleted from cPanel.' } }]);
});

test('integration examples use the Sending API and contain no real keys or SMTP credentials', () => {
  assert.deepEqual(Object.keys(integrationExamples), ['Node.js', 'Next.js', 'NestJS', 'PHP', 'Laravel', 'WordPress', 'cURL', 'PowerShell']);
  for (const [name, example] of Object.entries(integrationExamples)) {
    assert.match(example, /\/api\/v1\/messages/, name);
    assert.match(example, /Idempotency-Key/, name);
    assert.match(example, /Content-Type/, name);
    assert.doesNotMatch(example, /SMTP_PASSWORD|umh_(?:test|live)_[A-Za-z0-9_-]{20}/, name);
  }
});

test('integration creates a project key with only selected sender grants and audits config generation', async () => {
  const projectId = 'c123456789012345678901231';
  const keyId = 'c123456789012345678901235';
  const actions: string[] = [];
  let grantedIds: string[] = [];
  const saved = { id: keyId, projectId, name: 'Synthetic integration', keyPrefix: 'umh_test', grants: [{ mailbox: { id: mailboxId } }] };
  const tx = {
    apiKey: { create: async ({ data }: { data: { grants: { create: Array<{ mailboxId: string }> } } }) => { grantedIds = data.grants.create.map(item => item.mailboxId); return saved; } },
    auditLog: { create: async ({ data }: { data: { action: string } }) => { actions.push(data.action); } },
  };
  const db = {
    project: { findUnique: async () => ({ id: projectId }) },
    mailbox: { count: async () => 1 },
    apiKey: { findMany: async () => [saved] },
    apiKeyMailboxGrant: { findFirst: async () => ({ id: 'grant' }) },
    auditLog: tx.auditLog,
    $transaction: async (run: (value: typeof tx) => Promise<unknown>) => run(tx),
  };
  const request = { user: { id: 'admin' } };
  const keys = new ApiKeysController(db as never);
  const created = await keys.create({ projectId, name: 'Synthetic integration', mailboxIds: [mailboxId], scopes: ['MAIL_SEND'], integration: true }, request as never);
  assert.equal(grantedIds.length, 1);
  assert.equal(grantedIds[0], mailboxId);
  assert.match(created.rawKey, /^umh_/);
  assert.doesNotMatch(JSON.stringify(await keys.list()), new RegExp(created.rawKey));
  const integration = new ProjectIntegrationController(db as never);
  assert.deepEqual(await integration.configGenerated(projectId, { apiKeyId: keyId, mailboxId }, request as never), { recorded: true });
  assert.deepEqual(actions, ['API_KEY_CREATED', 'PROJECT_INTEGRATION_KEY_CREATED', 'PROJECT_INTEGRATION_CONFIG_GENERATED']);
});
