import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../packages/config/src/index';
import { AuthController } from '../apps/api/dist/auth.js';
import { SecurityAuthController } from '../apps/api/dist/security-auth.js';
import { AuthGuard } from '../apps/api/dist/core.js';
import { safeEmailHtml } from '../apps/api/src/webmail-html';
import { publicWebhookAddress, webhookUrl, pinnedWebhookLookupAnswer } from '../packages/mail/src/webhook';

const requireApi = createRequire(resolve('apps/api/package.json'));
const argon2 = requireApi('argon2') as typeof import('../apps/api/node_modules/argon2');

test('production config rejects local origins and weak secrets without echoing their values', () => {
  const original = process.env.NODE_ENV;
  const secret = process.env.JWT_SECRET;
  try {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'weak-secret-value-that-is-long-enough-for-schema';
    assert.throws(readConfig, error => error instanceof Error && error.message.includes('JWT_SECRET') && !error.message.includes(process.env.JWT_SECRET!));
  } finally { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret; }
});

test('production config permits only the fixed Compose API aliases and legacy endpoint', () => {
  const names = ['NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'WEB_URL', 'UNI_MAIL_HUB_PUBLIC_URL', 'ALLOWED_ORIGINS', 'API_URL', 'MAIL_CREDENTIAL_ENCRYPTION_KEY', 'EXTERNAL_TLS_TERMINATION'] as const;
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@postgres:5432/db', REDIS_URL: 'redis://redis:6379',
      JWT_SECRET: '0123456789abcdef'.repeat(4), WEB_URL: 'https://hub.example.com', UNI_MAIL_HUB_PUBLIC_URL: 'https://hub.example.com',
      ALLOWED_ORIGINS: 'https://hub.example.com', API_URL: 'http://uni-mail-hub-api:4000', MAIL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      EXTERNAL_TLS_TERMINATION: 'true',
    });
    assert.equal(readConfig().API_URL, 'http://uni-mail-hub-api:4000');
    process.env.API_URL = 'http://api:4000';
    assert.throws(readConfig, /API_URL/);
    process.env.EXTERNAL_TLS_TERMINATION = 'false';
    assert.equal(readConfig().API_URL, 'http://api:4000');
    process.env.API_URL = 'http://other.internal:4000';
    assert.throws(readConfig, /API_URL/);
  } finally {
    for (const name of names) if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
  }
});

test('production login needs only the correct password and still creates a session', async () => {
  const password = 'synthetic-admin-password';
  const user = { id: 'user', name: 'Synthetic', email: 'synthetic@example.invalid', role: 'SUPER_ADMIN', isActive: true, passwordHash: await argon2.hash(password) };
  const tx = {
    userSession: { create: async () => ({ id: 'session' }) },
    user: { update: async () => ({}) },
    auditLog: { create: async () => ({}) },
  };
  const db = {
    user: { findUnique: async (query: { include?: unknown }) => { assert.equal(query.include, undefined); return user; } },
    auditLog: { create: async () => ({}) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as ConstructorParameters<typeof AuthController>[0];
  const jwt = { signAsync: async () => 'synthetic-token' } as unknown as ConstructorParameters<typeof AuthController>[1];
  const controller = new AuthController(db, jwt);
  const request = { ip: '127.0.0.1', headers: {} } as Parameters<AuthController['login']>[1];
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = await controller.login({ email: user.email, password }, request);
    assert.equal(result.token, 'synthetic-token');
    assert.deepEqual(result.user, { id: user.id, name: user.name, email: user.email, role: user.role });
    assert.equal('requiresTwoFactor' in result, false);
    await assert.rejects(controller.login({ email: user.email, password: 'incorrect' }, request));
  } finally { if (prior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior; }
});

test('revoked and expired sessions cannot authorize requests', async () => {
  let revokedAt: Date | null = null;
  let expiresAt = new Date(Date.now() + 60_000);
  const db = {
    userSession: { findUnique: async () => ({ userId: 'user', revokedAt, expiresAt, lastUsedAt: new Date() }), updateMany: async () => ({ count: 1 }) },
    user: { findUnique: async () => ({ id: 'user', role: 'SUPER_ADMIN', email: 'synthetic@example.invalid', name: 'Synthetic', isActive: true }) },
  } as unknown as ConstructorParameters<typeof AuthGuard>[2];
  const jwt = { verifyAsync: async () => ({ sub: 'user', sid: 'session' }) } as unknown as ConstructorParameters<typeof AuthGuard>[1];
  const reflector = { getAllAndOverride: () => false } as unknown as ConstructorParameters<typeof AuthGuard>[0];
  const guard = new AuthGuard(reflector, jwt, db);
  const request = { headers: { authorization: 'Bearer synthetic' } } as Record<string, unknown>;
  const context = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => request }) } as unknown as Parameters<AuthGuard['canActivate']>[0];
  assert.equal(await guard.canActivate(context), true);
  revokedAt = new Date();
  await assert.rejects(guard.canActivate(context));
  revokedAt = null; expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(guard.canActivate(context));
});

test('administrator password change verifies the current password and revokes other sessions', async () => {
  const currentPassword = 'synthetic-current-password';
  const user = { id: 'user', passwordHash: await argon2.hash(currentPassword) };
  let revoked = false;
  const tx = {
    user: { updateMany: async () => ({ count: 1 }) },
    userSession: { updateMany: async () => { revoked = true; return { count: 1 }; } },
    auditLog: { create: async () => ({}) },
  };
  const db = {
    user: { findUniqueOrThrow: async () => user },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as ConstructorParameters<typeof SecurityAuthController>[0];
  const controller = new SecurityAuthController(db);
  const request = { user: { id: 'user', role: 'SUPER_ADMIN', sessionId: 'current' }, ip: '127.0.0.1' } as Parameters<SecurityAuthController['changePassword']>[0];
  await assert.rejects(controller.changePassword(request, { currentPassword: 'incorrect', newPassword: 'synthetic-new-password' }));
  assert.equal(revoked, false);
  assert.deepEqual(await controller.changePassword(request, { currentPassword, newPassword: 'synthetic-new-password' }), { success: true });
  assert.equal(revoked, true);
});

test('HTML and outbound webhook targets retain XSS and SSRF protections', () => {
  const result = safeEmailHtml('<script>alert(1)</script><p onclick="alert(1)"><a href="javascript:alert(1)">bad</a><img src="https://example.test/a" onerror="alert(1)"></p>', false);
  assert.doesNotMatch(result.html, /<script|onclick|onerror|javascript:/i);
  assert.doesNotMatch(result.html, /<img/i);
  assert.equal(publicWebhookAddress('127.0.0.1'), false);
  assert.equal(publicWebhookAddress('10.2.3.4'), false);
  assert.throws(() => webhookUrl('http://example.com/hook'));
  assert.deepEqual(pinnedWebhookLookupAnswer({ address: '8.8.8.8', family: 4 }, true), [{ address: '8.8.8.8', family: 4 }]);
});

test('actual structured logger redacts sensitive request fields', () => {
  const script = "const {requestLogger}=require('./apps/api/dist/core.js'); requestLogger.info({password:'synthetic-password-123',apiKey:'synthetic-key-123',secret:'synthetic-webhook-secret',headers:{authorization:'Bearer synthetic-token',cookie:'umh_session=synthetic-cookie'}},'redaction test')";
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  for (const value of ['synthetic-password-123', 'synthetic-key-123', 'synthetic-webhook-secret', 'synthetic-token', 'synthetic-cookie']) assert.ok(!run.stdout.includes(value));
  assert.match(run.stdout, /\[REDACTED\]/);
});
