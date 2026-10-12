import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../packages/config/src/index';
import { decodeEncryptionKey, encryptSecret } from '../packages/security/src/index';
import { consumeSecondFactor } from '../apps/api/dist/security-auth.js';
import { AuthGuard } from '../apps/api/dist/core.js';
import { safeEmailHtml } from '../apps/api/src/webmail-html';
import { publicWebhookAddress, webhookUrl, pinnedWebhookLookupAnswer } from '../packages/mail/src/webhook';

const requireApi = createRequire(resolve('apps/api/package.json'));
const { authenticator } = requireApi('otplib') as typeof import('../apps/api/node_modules/otplib');

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

test('TOTP cannot be replayed and a recovery code can be used only once', async () => {
  const secret = authenticator.generateSecret();
  const encrypted = encryptSecret(secret, decodeEncryptionKey(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY!));
  let lastStep: number | null = null;
  let recoveryAvailable = true;
  const db = {
    userSecurity: { updateMany: async ({ data }: { data: { lastTotpStep: number } }) => {
      if (lastStep !== null && lastStep >= data.lastTotpStep) return { count: 0 };
      lastStep = data.lastTotpStep; return { count: 1 };
    } },
    recoveryCode: { deleteMany: async () => { if (!recoveryAvailable) return { count: 0 }; recoveryAvailable = false; return { count: 1 }; } },
    auditLog: { create: async () => ({}) },
  } as unknown as Parameters<typeof consumeSecondFactor>[0];
  const factor = { totpSecretCiphertext: encrypted.encryptedPassword, totpSecretIv: encrypted.encryptionIv, totpSecretTag: encrypted.encryptionAuthTag, lastTotpStep: null };
  const code = authenticator.generate(secret);
  assert.equal(await consumeSecondFactor(db, 'synthetic-user', code, factor), true);
  assert.equal(await consumeSecondFactor(db, 'synthetic-user', code, factor), false);
  const recovery = randomBytes(12).toString('hex').toUpperCase();
  assert.equal(await consumeSecondFactor(db, 'synthetic-user', recovery, factor), true);
  assert.equal(await consumeSecondFactor(db, 'synthetic-user', recovery, factor), false);
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

test('fresh production admin is limited to 2FA enrollment until enabled', async () => {
  const priorEnv = process.env.NODE_ENV;
  const priorBootstrap = process.env.PRODUCTION_2FA_BOOTSTRAP;
  process.env.NODE_ENV = 'production';
  process.env.PRODUCTION_2FA_BOOTSTRAP = 'true';
  try {
    const db = {
      userSession: { findUnique: async () => ({ userId: 'user', revokedAt: null, expiresAt: new Date(Date.now() + 60_000), lastUsedAt: new Date() }) },
      user: { findUnique: async () => ({ id: 'user', role: 'SUPER_ADMIN', email: 'synthetic@example.invalid', name: 'Synthetic', isActive: true }) },
      userSecurity: { findUnique: async () => ({ totpEnabledAt: null }) },
    } as unknown as ConstructorParameters<typeof AuthGuard>[2];
    const jwt = { verifyAsync: async () => ({ sub: 'user', sid: 'session' }) } as unknown as ConstructorParameters<typeof AuthGuard>[1];
    const reflector = { getAllAndOverride: () => false } as unknown as ConstructorParameters<typeof AuthGuard>[0];
    const guard = new AuthGuard(reflector, jwt, db);
    const request = { headers: { authorization: 'Bearer synthetic' }, path: '/api/v1/dashboard' } as Record<string, unknown>;
    const context = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => request }) } as unknown as Parameters<AuthGuard['canActivate']>[0];
    await assert.rejects(guard.canActivate(context), (error: unknown) => error instanceof Error && error.message.includes('Complete two-factor setup'));
    request.path = '/api/v1/auth/2fa/setup';
    assert.equal(await guard.canActivate(context), true);
  } finally {
    if (priorEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorEnv;
    if (priorBootstrap === undefined) delete process.env.PRODUCTION_2FA_BOOTSTRAP; else process.env.PRODUCTION_2FA_BOOTSTRAP = priorBootstrap;
  }
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
