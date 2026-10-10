import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../packages/database/generated/client/index.js';

const web = process.env.WEB_URL;
assert(web && process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD, 'Web URL and seed admin credentials are required.');
const db = new PrismaClient();
let cookie;
let projectId;
let accountId;

async function call(path, method = 'GET', body) {
  const response = await fetch(`${web}/api/v1/${path}`, {
    method,
    headers: { Origin: web, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}

try {
  assert.equal((await call('cpanel-accounts/cm12345678901234567890123/mailboxes/changes')).status, 401);
  let login;
  for (let attempt = 0; attempt < 8; attempt++) {
    login = await fetch(`${web}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: web, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }),
    });
    if (login.status !== 429) break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie?.startsWith('umh_session='));

  const suffix = randomUUID().slice(0, 8);
  const project = await call('projects', 'POST', { name: 'Module 11 synthetic smoke', slug: `module11-${suffix}` });
  assert.equal(project.status, 201);
  projectId = project.data.id;
  const page = await fetch(`${web}/projects/${projectId}?tab=Integration`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert((await page.text()).includes('Integration'));

  const account = await call('cpanel-accounts', 'POST', {
    name: 'Module 11 disabled smoke', host: 'cpanel.example.test', port: 2083,
    username: 'synthetic', status: 'DISABLED', apiToken: `synthetic-${suffix}`,
  });
  assert.equal(account.status, 201);
  accountId = account.data.id;
  const changes = await call(`cpanel-accounts/${accountId}/mailboxes/changes`);
  assert.equal(changes.status, 409);
  assert.equal(changes.data.code, 'CPANEL_ACCOUNT_DISABLED');
  const provision = await call(`cpanel-accounts/${accountId}/mailboxes/provision`, 'POST', {});
  assert.equal(provision.status, 409);
  assert.equal(provision.data.code, 'CPANEL_ACCOUNT_DISABLED');
  console.log('Module 11 smoke passed: protected Integration page and disabled-account provisioning guard.');
} finally {
  if (accountId) assert.equal((await call(`cpanel-accounts/${accountId}`, 'DELETE')).status, 200);
  if (projectId) await db.project.delete({ where: { id: projectId } });
  await db.$disconnect();
}
