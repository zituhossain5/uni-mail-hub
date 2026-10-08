import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../packages/database/generated/client/index.js';

const web = process.env.WEB_URL;
assert(web && process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD, 'WEB_URL and seed admin credentials are required');
const db = new PrismaClient();
let projectId;
let cookie;
async function call(path, method = 'GET', body) {
  const response = await fetch(`${web}/api/v1/${path}`, { method, headers: { Origin: web, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
try {
  assert.equal((await call('admin/projects/cm12345678901234567890123/webhooks')).status, 401);
  let login;
  for (let attempt = 0; attempt < 8; attempt++) {
    login = await fetch(`${web}/api/v1/auth/login`, { method: 'POST', headers: { Origin: web, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }) });
    if (login.status !== 429) break;
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
  const suffix = randomUUID().slice(0, 8);
  const project = await call('projects', 'POST', { name: 'Module 10 synthetic smoke', slug: `module10-${suffix}` });
  assert.equal(project.status, 201, JSON.stringify(project.data)); projectId = project.data.id;
  for (const tab of ['Webhooks', 'Suppressions']) {
    const page = await fetch(`${web}/projects/${projectId}?tab=${tab}`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200, tab);
  }
  const base = `admin/projects/${projectId}`;
  const list = await call(`${base}/webhooks`); assert.equal(list.status, 200); assert.deepEqual(list.data.endpoints, []);
  const blocked = await call(`${base}/webhooks`, 'POST', { name: 'Private URL', url: 'https://127.0.0.1/hook', subscriptions: ['webhook.test'] });
  assert.equal(blocked.status, 400); assert.equal(blocked.data.code, 'WEBHOOK_ENDPOINT_INVALID');
  const email = `blocked-${suffix}@example.test`;
  const added = await call(`${base}/suppressions`, 'POST', { email: email.toUpperCase() });
  assert.equal(added.status, 201, JSON.stringify(added.data)); assert.equal(added.data.email, email);
  assert.equal((await call(`${base}/suppressions`)).data.length, 1);
  assert.equal((await call(`${base}/suppressions/${added.data.id}`, 'DELETE')).status, 200);
  assert.equal((await call(`${base}/suppressions`)).data.length, 0);
  console.log('Module 10 smoke passed: project tabs, authenticated API, private webhook URL rejection, suppression add/list/remove.');
} finally {
  if (projectId) await db.project.delete({ where: { id: projectId } });
  await db.$disconnect();
}
