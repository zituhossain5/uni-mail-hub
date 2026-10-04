import assert from 'node:assert/strict';

const web = process.env.WEB_URL;
const api = process.env.API_URL;
const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
assert(web && api && email && password, 'WEB_URL, API_URL and seed admin credentials are required');

async function json(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${web}/api/v1/${path}`, {
    method,
    headers: { Origin: web, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, data: await response.json() };
}

const health = await fetch(`${api}/api/v1/health`);
assert.equal(health.status, 200, 'health endpoint');
assert.deepEqual(await health.json(), { status: 'ok', database: 'connected', redis: 'connected' });
assert.equal((await json('projects')).response.status, 401, 'registry must be protected');

const redirect = await fetch(`${web}/dashboard`, { redirect: 'manual' });
assert.equal(redirect.status, 307, 'dashboard must redirect anonymous users');
assert.equal(redirect.headers.get('location'), '/login');
const loginPage = await fetch(`${web}/login`);
assert.equal(loginPage.status, 200, 'login page must render');
assert((await loginPage.text()).includes('Sign in to your workspace'));

const login = await json('auth/login', { method: 'POST', body: { email, password } });
assert.equal(login.response.status, 200, 'seed admin must log in');
assert.equal(login.data.user.role, 'SUPER_ADMIN');
assert(!('token' in login.data), 'web relay must not return token in JSON');
const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
assert(cookie?.startsWith('umh_session='), 'login must set session cookie');
const authedDashboard = await fetch(`${web}/dashboard`, { headers: { Cookie: cookie } });
assert.equal(authedDashboard.status, 200, 'authenticated dashboard must render');
assert((await authedDashboard.text()).includes('Mailbox health'));

const baseline = (await json('dashboard', { cookie })).data;
const suffix = Date.now().toString(36);
let projectId, domainId, mailboxId;
try {
  const project = await json('projects', { method: 'POST', cookie, body: { name: 'Smoke test', slug: `smoke-${suffix}`, description: 'Temporary verification record' } });
  assert.equal(project.response.status, 201, JSON.stringify(project.data));
  projectId = project.data.id;
  const projectUpdate = await json(`projects/${projectId}`, { method: 'PATCH', cookie, body: { status: 'INACTIVE' } });
  assert.equal(projectUpdate.data.status, 'INACTIVE');
  assert.equal((await json(`projects/${projectId}`, { cookie })).response.status, 200);
  const projectPage = await fetch(`${web}/projects/${projectId}`, { headers: { Cookie: cookie } });
  assert.equal(projectPage.status, 200, 'project detail page must render');
  assert((await projectPage.text()).includes('Smoke test'));

  const domain = await json('domains', { method: 'POST', cookie, body: { projectId, domain: `smoke-${suffix}.example.com` } });
  assert.equal(domain.response.status, 201, JSON.stringify(domain.data));
  domainId = domain.data.id;
  assert.equal(domain.data.status, 'UNVERIFIED');
  const rejectedDomain = await json(`domains/${domainId}`, { method: 'PATCH', cookie, body: { status: 'ACTIVE' } });
  assert.equal(rejectedDomain.response.status, 400, 'DNS verification cannot be fabricated');
  const domainUpdate = await json(`domains/${domainId}`, { method: 'PATCH', cookie, body: { status: 'DISABLED' } });
  assert.equal(domainUpdate.data.status, 'DISABLED');

  const mailbox = await json('mailboxes', { method: 'POST', cookie, body: { projectId, domainId, email: `contact@smoke-${suffix}.example.com`, displayName: 'Smoke test' } });
  assert.equal(mailbox.response.status, 201, JSON.stringify(mailbox.data));
  mailboxId = mailbox.data.id;
  assert.equal(mailbox.data.status, 'UNKNOWN');
  const rejectedHealth = await json(`mailboxes/${mailboxId}`, { method: 'PATCH', cookie, body: { status: 'HEALTHY' } });
  assert.equal(rejectedHealth.response.status, 400, 'mailbox health cannot be fabricated');
  const mailboxUpdate = await json(`mailboxes/${mailboxId}`, { method: 'PATCH', cookie, body: { isActive: false } });
  assert.equal(mailboxUpdate.data.isActive, false);
  assert.equal((await json('mailboxes', { cookie })).data.some((item) => item.id === mailboxId), true);

  const dashboard = (await json('dashboard', { cookie })).data;
  assert.equal(dashboard.projects, baseline.projects + 1);
  assert.equal(dashboard.domains, baseline.domains + 1);
  assert.equal(dashboard.mailboxes, baseline.mailboxes + 1);
  assert.equal(dashboard.healthyMailboxes, baseline.healthyMailboxes);
  assert(dashboard.recentActivity.length > 0);
} finally {
  if (mailboxId) await json(`mailboxes/${mailboxId}`, { method: 'DELETE', cookie });
  if (domainId) await json(`domains/${domainId}`, { method: 'DELETE', cookie });
  if (projectId) await json(`projects/${projectId}`, { method: 'DELETE', cookie });
}
const logout = await json('auth/logout', { method: 'POST', cookie });
assert.equal(logout.response.status, 200, 'logout must succeed');
assert(logout.response.headers.get('set-cookie')?.includes('umh_session='), 'logout must clear session cookie');
console.log('Smoke test passed: health, login/logout, protected UI, CRUD, status rules, dashboard counts, audit activity.');
