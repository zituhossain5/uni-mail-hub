import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'reflect-metadata';
import { decodeEncryptionKey, decryptSecret } from '../packages/security/src/index';
import { classifyCpanelError, normalizeEmail, parseDomains, parseForwarders, parseMailboxes, parseUapiResponse, validateCpanelHost } from '../packages/mail/src/cpanel';
import { collectCpanelDiscovery, missingEmails, reconcileMailboxState } from '../apps/worker/src/cpanel-discovery';
import { CpanelController } from '../apps/api/dist/cpanel.js';
import { AuthGuard } from '../apps/api/dist/core.js';

const keyText = process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY!;

test('mocked UAPI responses parse domains, mailbox quotas, suspension, and forwarders', () => {
  const envelope = (data: unknown) => JSON.stringify({ result: { status: 1, data, errors: null } });
  const domains = parseDomains(parseUapiResponse(envelope({ main_domain: 'Example.test', addon_domains: ['other.test'], sub_domains: ['mail.example.test'], parked_domains: ['other.test'] })));
  assert.deepEqual(domains, ['example.test', 'other.test', 'mail.example.test']);
  const mailboxes = parseMailboxes(parseUapiResponse(envelope([
    { email: 'A@example.test', _diskused: '83886080', _diskquota: '104857600', diskquota: 100, suspended_login: 0 },
    { email: 'b@example.test', _diskused: '500', _diskquota: 0, diskquota: 'unlimited', suspended_incoming: 1 },
    { email: 'Main Account', login: 'cpuser' }, { email: 'A@example.test' },
  ])));
  assert.equal(mailboxes.length, 2);
  assert.deepEqual(mailboxes[0], { email: 'a@example.test', domain: 'example.test', usedBytes: 83886080n, quotaBytes: 104857600n, unlimitedQuota: false, suspended: false });
  assert.deepEqual(mailboxes[1], { email: 'b@example.test', domain: 'example.test', usedBytes: 500n, quotaBytes: null, unlimitedQuota: true, suspended: true });
  assert.deepEqual(parseForwarders(parseUapiResponse(envelope([{ dest: 'alias@example.test', forward: 'target@other.test' }])), 'example.test'), [{ domain: 'example.test', source: 'alias@example.test', destination: 'target@other.test' }]);
  assert.equal(normalizeEmail('Main Account'), null);
});

test('UAPI errors are normalized and optional forwarder failure leaves mailbox discovery usable', async () => {
  assert.equal((() => { try { parseUapiResponse(JSON.stringify({ result: { status: 0, errors: ['Permission denied for token SECRET'] } })); } catch (error) { assert.equal(String(error).includes('SECRET'), false); return (error as { code: string }).code; } })(), 'CPANEL_PERMISSION_DENIED');
  assert.equal(classifyCpanelError({ code: 'CERT_HAS_EXPIRED', message: 'secret host' }).code, 'CPANEL_TLS_FAILED');
  const collected = await collectCpanelDiscovery({ listDomains: async () => ['example.test'], listMailboxes: async () => parseMailboxes([{ email: 'x@example.test' }]), listForwarders: async () => { throw new Error('forwarders unavailable'); } });
  assert.deepEqual(collected.domains, ['example.test']);
  assert.equal(collected.mailboxes?.[0]?.email, 'x@example.test');
  assert.equal(collected.forwardersByDomain.size, 0);
  assert.equal(collected.failures.length, 1);
});

test('host validation blocks URL injection and private addresses but permits public VPS IPv4', () => {
  for (const host of ['https://cpanel.example.test', '127.0.0.1', '10.1.1.2', 'metadata.google.internal', 'localhost']) assert.throws(() => validateCpanelHost(host));
  assert.equal(validateCpanelHost('cpanel.example.test'), 'cpanel.example.test');
  assert.equal(validateCpanelHost('8.8.8.8'), '8.8.8.8');
});

test('reconciliation recognizes managed, ignored, duplicate, and missing mailboxes', () => {
  assert.equal(reconcileMailboxState('managed-id', false), 'MANAGED');
  assert.equal(reconcileMailboxState(null, true), 'IGNORED');
  assert.equal(reconcileMailboxState(null, false), 'DISCOVERED');
  assert.deepEqual(missingEmails(['a@example.test', 'b@example.test'], ['A@example.test']), ['b@example.test']);
  assert.equal(parseMailboxes([{ email: 'a@example.test' }, { email: 'A@example.test' }]).length, 1);
});

const accountId = 'c123456789012345678901234';
const mailboxId = 'c123456789012345678901235';
const projectId = 'c123456789012345678901236';
const serverId = 'c123456789012345678901237';
const request = { user: { id: 'admin' }, ip: '127.0.0.1' };
function accountFixture() { return { id: accountId, name: 'Test', host: 'cpanel.example.test', port: 2083, username: 'cpuser', status: 'ACTIVE', connectionStatus: 'UNTESTED' }; }

test('account create encrypts token, omits token from API result and audit; replacement rotates ciphertext', async () => {
  let stored: Record<string, unknown> = {};
  const audits: Record<string, unknown>[] = [];
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    cpanelAccount: {
      create: async ({ data }: { data: Record<string, unknown> }) => { stored = { id: accountId, ...data }; return accountFixture(); },
      findUnique: async () => stored,
      update: async ({ data }: { data: Record<string, unknown> }) => { stored = { ...stored, ...data }; return accountFixture(); },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); } },
  };
  const controller = new CpanelController(db as never, {} as never);
  const original = 'top-secret-cpanel-token';
  const result = await controller.create({ name: 'Test', host: 'cpanel.example.test', port: 2083, username: 'cpuser', status: 'ACTIVE', apiToken: original }, request as never);
  assert.equal(JSON.stringify(result).includes(original), false);
  assert.equal(JSON.stringify(audits).includes(original), false);
  assert.equal(decryptSecret({ encryptedPassword: String(stored.encryptedApiToken), encryptionIv: String(stored.encryptionIv), encryptionAuthTag: String(stored.encryptionAuthTag), encryptionVersion: Number(stored.encryptionVersion) }, decodeEncryptionKey(keyText)), original);
  const oldCiphertext = stored.encryptedApiToken;
  await controller.replaceToken(accountId, { apiToken: 'replacement' }, request as never);
  assert.notEqual(stored.encryptedApiToken, oldCiphertext);
  assert.equal(JSON.stringify(audits).includes('replacement'), false);
});

test('super-admin guard denies other roles', async () => {
  const guard = new AuthGuard({ getAllAndOverride: (key: string) => key === 'superAdmin' } as never, { verifyAsync: async () => ({ sub: 'member' }) } as never, { user: { findUnique: async () => ({ id: 'member', role: 'MEMBER', email: 'm@example.test', name: 'Member', isActive: true }) } } as never);
  const context = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'Bearer test' } }) }) };
  await assert.rejects(guard.canActivate(context as never), { status: 403 });
});

test('import maps existing project, domain and shared server without creating credentials', async () => {
  const created: Record<string, unknown>[] = [];
  const discovered = { id: mailboxId, accountId, email: 'new@example.test', domain: 'example.test', state: 'DISCOVERED' };
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    cpanelAccount: { findUnique: async () => accountFixture() },
    cpanelDiscoveredMailbox: { findFirst: async () => discovered, update: async ({ data }: { data: Record<string, unknown> }) => { created.push({ discovery: data }); } },
    cpanelDiscoveredDomain: { updateMany: async () => ({ count: 1 }) },
    mailbox: { findFirst: async () => null, create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: 'new-id', email: data.email }; } },
    project: { findUnique: async () => ({ id: projectId, name: 'Existing' }) },
    domain: { findFirst: async () => ({ id: 'domain-id', domain: 'example.test', projectId }) },
    mailServer: { findUnique: async () => ({ id: serverId, status: 'ACTIVE' }) },
    auditLog: { create: async () => null },
    mailboxCredential: { create: async () => { throw new Error('Credentials must stay absent'); } },
  };
  const controller = new CpanelController(db as never, {} as never);
  const result = await controller.importMailbox(accountId, mailboxId, { projectId, mailServerId: serverId }, request as never);
  assert.equal(result.credentialConfigured, false);
  assert.equal(created[0]?.projectId, projectId);
  assert.equal(created[0]?.domainId, 'domain-id');
  assert.equal(created[0]?.mailServerId, serverId);
  assert.equal((created[1]?.discovery as { state: string }).state, 'MANAGED');
});

test('import blocks duplicate mailbox and conflicting project/domain mapping', async () => {
  const discovered = { id: mailboxId, accountId, email: 'new@example.test', domain: 'example.test', state: 'DISCOVERED' };
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    cpanelAccount: { findUnique: async () => accountFixture() },
    cpanelDiscoveredMailbox: { findFirst: async () => discovered },
    mailbox: { findFirst: async () => ({ id: 'already-managed' }) },
    project: { findUnique: async () => ({ id: projectId }) },
    domain: { findFirst: async () => ({ id: 'domain-id', projectId: 'different' }) },
  };
  const controller = new CpanelController(db as never, {} as never);
  await assert.rejects(controller.importMailbox(accountId, mailboxId, { projectId, mailServerId: serverId }, request as never), { status: 409 });
  db.mailbox.findFirst = async () => null as never;
  await assert.rejects(controller.importMailbox(accountId, mailboxId, { projectId, mailServerId: serverId }, request as never), { status: 409 });
});
