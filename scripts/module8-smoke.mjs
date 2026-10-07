import assert from 'node:assert/strict';

const web = process.env.WEB_URL;
assert(web && process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD, 'Web URL and seed admin credentials are required.');
async function call(path, cookie, method = 'GET', body) {
  const response = await fetch(`${web}/api/v1/${path}`, { method, headers: { Origin: web, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
assert.equal((await call('cpanel-accounts')).status, 401);
// Use the web relay's Set-Cookie header without exposing it to output.
const loginResponse = await fetch(`${web}/api/v1/auth/login`, { method: 'POST', headers: { Origin: web, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }) });
assert.equal(loginResponse.status, 200);
const sessionCookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
assert(sessionCookie?.startsWith('umh_session='));
let id;
try {
  const token = `module8-synthetic-${Date.now()}`;
  const created = await call('cpanel-accounts', sessionCookie, 'POST', { name: 'Module 8 smoke', host: 'cpanel.example.test', port: 2083, username: 'cpuser', status: 'DISABLED', apiToken: token });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  id = created.body.id;
  assert.equal(JSON.stringify(created.body).includes(token), false);
  const list = await call('cpanel-accounts', sessionCookie);
  assert.equal(list.status, 200);
  assert(list.body.some(item => item.id === id));
  assert.equal(JSON.stringify(list.body).includes(token), false);
  const detail = await call(`cpanel-accounts/${id}`, sessionCookie);
  assert.equal(detail.status, 200);
  assert.equal('encryptedApiToken' in detail.body, false);
  const rotate = await call(`cpanel-accounts/${id}/token`, sessionCookie, 'POST', { apiToken: `${token}-rotated` });
  assert.equal(rotate.status, 201);
  const discover = await call(`cpanel-accounts/${id}/discover`, sessionCookie, 'POST');
  assert.equal(discover.status, 409);
  const page = await fetch(`${web}/cpanel-accounts`, { headers: { Cookie: sessionCookie } });
  assert.equal(page.status, 200);
  assert((await page.text()).includes('cPanel Accounts'));
  console.log('Module 8 smoke passed: RBAC, encrypted-token API surface, account CRUD, disabled discovery guard, protected page.');
} finally {
  if (id) assert.equal((await call(`cpanel-accounts/${id}`, sessionCookie, 'DELETE')).status, 200);
}
