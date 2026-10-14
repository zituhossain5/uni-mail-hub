import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { PrismaClient, UserRole } from '../packages/database/generated/client';

const requireApi = createRequire(resolve('apps/api/package.json'));
const argon2 = requireApi('argon2') as typeof import('../apps/api/node_modules/argon2');
const api = process.env.API_URL!;
const web = process.env.WEB_URL!;
const db = new PrismaClient();
const email = 'security-smoke-' + randomBytes(8).toString('hex') + '@example.invalid';
const password = randomBytes(32).toString('base64url');

async function post(base: string, path: string, body: unknown, token?: string) {
  const response = await fetch(base + '/api/v1/auth/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(base === web ? { Origin: web } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { response, data: await response.json() as Record<string, unknown> };
}

async function main() {
  if (!api.startsWith('http://127.0.0.1:') || !web.startsWith('http://127.0.0.1:')) throw new Error('Security smoke requires loopback local URLs');
  const user = await db.user.create({ data: { email, name: 'Synthetic Security Test', role: UserRole.SUPER_ADMIN, passwordHash: await argon2.hash(password) } });
  try {
    const initial = await post(web, 'login', { email, password });
    assert.equal(initial.response.status, 200);
    const setCookie = initial.response.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /umh_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Max-Age=28800/i);
    const tokenA = /umh_session=([^;]+)/.exec(setCookie)?.[1];
    assert.ok(tokenA);
    for (const path of ['2fa/setup', '2fa/verify', '2fa/recovery-codes', '2fa/disable']) {
      assert.equal((await post(api, path, {}, tokenA)).response.status, 404);
    }
    const status = await fetch(api + '/api/v1/auth/security', { headers: { Authorization: 'Bearer ' + tokenA } });
    const statusBody = await status.json() as Record<string, unknown>;
    assert.equal(status.status, 200);
    assert.ok(Array.isArray(statusBody.sessions));
    assert.equal('twoFactorEnabled' in statusBody, false);
    const missingOrigin = await fetch(web + '/api/v1/auth/logout', { method: 'POST', headers: { Cookie: 'umh_session=' + tokenA } });
    assert.equal(missingOrigin.status, 403);
    const oversized = await fetch(web + '/api/v1/auth/login', { method: 'POST', headers: { Origin: web, 'Content-Type': 'application/json' }, body: 'x'.repeat(2 * 1024 * 1024 + 1) });
    assert.equal(oversized.status, 413);
    const second = await post(api, 'login', { email, password });
    assert.equal(second.response.status, 201);
    const tokenB = second.data.token as string;
    const wrongCurrent = await post(api, 'password/change', { currentPassword: 'incorrect', newPassword: randomBytes(32).toString('base64url') }, tokenA);
    assert.equal(wrongCurrent.response.status, 401);
    const nextPassword = randomBytes(32).toString('base64url');
    const changed = await post(api, 'password/change', { currentPassword: password, newPassword: nextPassword }, tokenA);
    assert.equal(changed.response.status, 201);
    assert.equal((await fetch(api + '/api/v1/auth/me', { headers: { Authorization: 'Bearer ' + tokenB } })).status, 401);
    assert.equal((await post(api, 'login', { email, password })).response.status, 401);
    const third = await post(api, 'login', { email, password: nextPassword });
    assert.equal(third.response.status, 201);
    const tokenC = third.data.token as string;
    const revoke = await post(api, 'sessions/revoke-others', {}, tokenA);
    assert.equal(revoke.response.status, 201);
    assert.equal((await fetch(api + '/api/v1/auth/me', { headers: { Authorization: 'Bearer ' + tokenC } })).status, 401);
    const logout = await fetch(web + '/api/v1/auth/logout', { method: 'POST', headers: { Origin: web, Cookie: 'umh_session=' + tokenA } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /umh_session=;/);
    assert.equal((await fetch(api + '/api/v1/auth/me', { headers: { Authorization: 'Bearer ' + tokenA } })).status, 401);
    const allowed = await fetch(api + '/api/v1/auth/login', { method: 'OPTIONS', headers: { Origin: web, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), web);
    const rejected = await fetch(api + '/api/v1/auth/login', { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
    const webPage = await fetch(web + '/login');
    assert.equal(webPage.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(webPage.headers.get('x-frame-options'), 'DENY');
    assert.doesNotMatch(await webPage.text(), /verification or recovery code/i);
    console.log('Security smoke passed: password login and change, sessions, logout, cookies, CSRF, CORS, headers, body limit');
  } finally {
    await db.auditLog.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
}

main().catch(error => { console.error('Security smoke failed:', error instanceof Error ? error.message : 'unknown error'); process.exitCode = 1; });
