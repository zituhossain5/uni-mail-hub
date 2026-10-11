import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { databaseSettings, createTemporaryDatabase, dropTemporaryDatabase, temporaryDatabaseUrl, root } from '../ops/db-tools.mjs';

const requireWorker = createRequire(join(root, 'apps/worker/package.json'));
const requireDatabase = createRequire(join(root, 'packages/database/package.json'));
const Redis = requireWorker('ioredis');
const { Queue } = requireWorker('bullmq');
const { PrismaClient } = requireDatabase('./generated/client/index.js');
const argon2 = requireDatabase('argon2');
const stateFile = join(root, '.local-backups', 'module14-state.json');
const apiPort = 4011;

function localSettings() {
  const settings = databaseSettings();
  if (settings.environment !== 'development' || !['127.0.0.1', 'localhost'].includes(settings.host) || settings.port !== '15432' || settings.name !== 'unimailhub' || settings.mode !== 'docker-compose') throw new Error('MODULE14_REQUIRES_LOCAL_COMPOSE_DB');
  const redis = new URL(process.env.REDIS_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(redis.hostname) || redis.port !== '16379' || redis.protocol !== 'redis:') throw new Error('MODULE14_REQUIRES_LOCAL_REDIS');
  return settings;
}

function redisUrl(db) { const url = new URL(process.env.REDIS_URL); url.pathname = '/' + db; return url.toString(); }
async function freeRedisDb() {
  for (let index = 15; index >= 9; index--) {
    const client = new Redis(redisUrl(index), { maxRetriesPerRequest: 1 });
    try { if (await client.dbsize() === 0) return index; }
    finally { client.disconnect(); }
  }
  throw new Error('NO_EMPTY_LOCAL_REDIS_TEST_DB');
}

function migrationEngine() {
  const base = join(root, 'node_modules', '.pnpm');
  const versions = readdirSync(base).filter(name => name.startsWith('@prisma+engines@'));
  for (const version of versions) {
    const file = join(base, version, 'node_modules', '@prisma', 'engines', process.platform === 'win32' ? 'schema-engine-windows.exe' : 'schema-engine');
    if (existsSync(file)) return file;
  }
  throw new Error('LOCAL_PRISMA_ENGINE_MISSING');
}

function migrate(url) {
  const cli = join(root, 'node_modules', 'prisma', 'build', 'index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', join(root, 'packages', 'database', 'prisma', 'schema.prisma')], {
    cwd: root, env: { ...process.env, DATABASE_URL: url, PRISMA_SCHEMA_ENGINE_BINARY: migrationEngine() }, windowsHide: true, stdio: 'ignore', timeout: 120_000,
  });
  if (result.error || result.status !== 0) throw new Error('TEMP_MIGRATION_FAILED');
}

async function cleanState(settings, state) {
  if (state.marker !== 'UNI_MAIL_HUB_MODULE14_SYNTHETIC' || !/^umh_restore_[a-f0-9]{12}$/.test(state.database) || !Number.isInteger(state.redisDb) || state.redisDb < 9 || state.redisDb > 15 || !/^[a-f0-9]{8}$/.test(state.runId)) throw new Error('MODULE14_STATE_INVALID');
  const redis = new Redis(redisUrl(state.redisDb), { maxRetriesPerRequest: 1 });
  try {
    const keys = await redis.keys('*');
    const unexpected = [...new Set(keys.filter(key => !/^(bull:|mail-sync:|monitor:|maintenance:|module14:|umh:)/.test(key)).map(key => key.split(':')[0]))];
    if (unexpected.length) throw new Error(`REDIS_TEST_DB_HAS_UNRELATED_KEY_PREFIXES_${unexpected.join('_')}`);
    if (keys.length) await redis.flushdb();
  } finally { redis.disconnect(); }
  await cleanMailpit(state.runId);
  dropTemporaryDatabase(settings, state.database);
  if (existsSync(stateFile)) unlinkSync(stateFile);
}

async function mailpitRunIds(runId) {
  if (!/^[a-f0-9]{8}$/.test(runId)) throw new Error('MODULE14_RUN_ID_INVALID');
  const prefix = `Module14-${runId}-send-`;
  const ids = new Set();
  for (let start = 0; ; start += 500) {
    const response = await fetch(`http://127.0.0.1:8025/api/v1/messages?start=${start}&limit=500`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('LOCAL_MAILPIT_LIST_FAILED');
    const page = await response.json();
    if (!Array.isArray(page.messages)) throw new Error('LOCAL_MAILPIT_RESPONSE_INVALID');
    for (const message of page.messages) if (typeof message.Subject === 'string' && /^Module14-[a-f0-9]{8}-send-\d+$/.test(message.Subject) && message.Subject.startsWith(prefix) && typeof message.ID === 'string') ids.add(message.ID);
    if (start + page.messages.length >= page.total || page.messages.length === 0) break;
  }
  return ids;
}

async function cleanMailpit(runId) {
  const ids = await mailpitRunIds(runId);
  if (ids.size) {
    const response = await fetch('http://127.0.0.1:8025/api/v1/messages', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [...ids] }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('LOCAL_MAILPIT_CLEANUP_FAILED');
  }
  return ids.size;
}

async function cleanupCommand() {
  const settings = localSettings();
  if (!existsSync(stateFile)) { console.log('No Module 14 test state to clean.'); return; }
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  await cleanState(settings, state);
  console.log(JSON.stringify({ cleanedSyntheticDatabase: state.database, cleanedRedisDb: state.redisDb }));
}

async function seed(db, runId, mailboxCount, messageCount) {
  const password = randomBytes(24).toString('base64url');
  const email = `module14-admin-${runId}@example.test`;
  await db.user.create({ data: { name: 'Module 14 synthetic admin', email, passwordHash: await argon2.hash(password), role: 'SUPER_ADMIN' } });
  const project = await db.project.create({ data: { name: 'Module 14 synthetic load', slug: `module14-${runId}` } });
  const domain = await db.domain.create({ data: { projectId: project.id, domain: `module14-${runId}.test` } });
  const server = await db.mailServer.create({ data: { name: 'Module 14 Mailpit only', smtpHost: '127.0.0.1', smtpPort: 51025, smtpSecurity: 'NONE', smtpAuthMode: 'NONE' } });
  await db.mailbox.createMany({ data: Array.from({ length: mailboxCount }, (_, i) => ({ projectId: project.id, domainId: domain.id, mailServerId: server.id, email: `module14-${runId}-${String(i).padStart(4, '0')}@${domain.domain}`, status: i % 7 === 0 ? 'WARNING' : 'UNKNOWN', isActive: true })) });
  const mailboxes = await db.mailbox.findMany({ where: { projectId: project.id }, orderBy: { email: 'asc' }, select: { id: true, email: true } });
  await db.mailFolder.createMany({ data: mailboxes.map(mailbox => ({ mailboxId: mailbox.id, name: 'Inbox', path: 'INBOX', specialUse: 'INBOX' })) });
  const folders = await db.mailFolder.findMany({ where: { mailboxId: { in: mailboxes.map(item => item.id) } }, select: { id: true, mailboxId: true } });
  const perFolder = Math.ceil(messageCount / folders.length);
  let created = 0;
  for (const folder of folders) {
    const batch = [];
    for (let uid = 1; uid <= perFolder && created < messageCount; uid++, created++) {
      const stamp = new Date(Date.now() - created * 1000);
      batch.push({ mailboxId: folder.mailboxId, folderId: folder.id, imapUid: BigInt(uid), threadKey: `h:${createHash('md5').update(`${folder.id}:${uid}`).digest('hex')}`, subject: `Module14 synthetic ${created % 50 === 0 ? 'alpha' : 'ordinary'} ${created}`, fromEmail: `sender${created % 50}@example.test`, fromName: 'Synthetic sender', textBody: `Module 14 synthetic test body ${created % 50 === 0 ? 'needle' : 'ordinary'}.`, internalDate: stamp, isSeen: created % 3 !== 0, isFlagged: created % 11 === 0 });
    }
    if (batch.length) await db.mailMessage.createMany({ data: batch });
  }
  const samples = await db.mailMessage.findMany({ where: { mailboxId: { in: mailboxes.map(item => item.id) } }, select: { id: true }, orderBy: { internalDate: 'desc' } });
  await db.mailRecipient.createMany({ data: samples.filter((_, i) => i % 10 === 0).map((item, i) => ({ messageId: item.id, type: 'TO', email: `recipient${i % 20}@example.test` })) });
  await db.mailAttachment.createMany({ data: samples.filter((_, i) => i % 20 === 0).map(item => ({ messageId: item.id, filename: 'module14.txt', contentType: 'text/plain', sizeBytes: 128n, imapPart: '2' })) });
  const cpanel = await db.cpanelAccount.create({ data: { name: 'Module 14 synthetic disabled account', host: 'cpanel.example.test', username: 'module14', encryptedApiToken: 'synthetic', encryptionIv: 'synthetic', encryptionAuthTag: 'synthetic', status: 'DISABLED' } });
  await db.cpanelDiscoveredMailbox.createMany({ data: Array.from({ length: 250 }, (_, i) => ({ accountId: cpanel.id, email: `discovered-${String(i).padStart(4, '0')}@${domain.domain}`, domain: domain.domain, state: i % 5 === 0 ? 'IGNORED' : 'DISCOVERED', usedBytes: BigInt(i * 1024), quotaBytes: 1048576n })) });
  await db.monitoringRun.create({ data: { trigger: 'MODULE14_SETUP', status: 'SUCCESS', completedAt: new Date() } });
  return { email, password, project, domain, server, mailboxes, folders, cpanel };
}

function launch(app, env) {
  const file = join(root, 'apps', app, 'src', 'main.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', file], { cwd: join(root, 'apps', app), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.diagnostic = 'NONE';
  child.stderrTail = '';
  const inspect = chunk => {
    const value = String(chunk);
    const code = value.match(/\b(?:P[0-9]{4}|EADDRINUSE|ECONNREFUSED|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM|DATABASE_URL_MISSING|REDIS_URL_MISSING|Invalid environment configuration)\b/)?.[0];
    if (code) child.diagnostic = code;
  };
  child.stdout.on('data', inspect);
  child.stderr.on('data', chunk => { child.stderrTail = (child.stderrTail + String(chunk)).slice(-3000); inspect(chunk); });
  child.on('error', error => { child.diagnostic = error.code ?? 'CHILD_SPAWN_FAILED'; });
  return child;
}

function safeChildError(child) {
  let value = child.stderrTail ?? '';
  for (const [key, secret] of Object.entries(process.env)) {
    if (/PASS|SECRET|TOKEN|KEY|URL/i.test(key) && typeof secret === 'string' && secret.length > 3) value = value.replaceAll(secret, '[REDACTED]');
  }
  value = value.replace(/\b(?:postgres(?:ql)?|redis(?:s)?):\/\/[^\s'"`]+/gi, '[REDACTED_URL]');
  value = value.replace(/(?:password|secret|token|key)\s*[:=]\s*[^\s,}]+/gi, '[REDACTED_FIELD]');
  return value.slice(0, 700).replace(/[\r\n]+/g, ' ');
}

async function waitFor(label, check, timeoutMs = 20_000, child) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`${label}_EXIT_${child.exitCode ?? child.signalCode}_${child.diagnostic}: ${safeChildError(child)}`);
    try { if (await check()) return; } catch { /* dependency may be starting */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`${label}_NOT_READY_${child?.diagnostic ?? 'NONE'}: ${child ? safeChildError(child) : ''}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
}

function processMetrics(pid) {
  if (!pid) return null;
  const command = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{rssMiB=[math]::Round($p.WorkingSet64/1MB,1);cpuSeconds=[math]::Round($p.CPU,2)} | ConvertTo-Json -Compress }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  try { return result.status === 0 && result.stdout.trim() ? JSON.parse(result.stdout) : null; } catch { return null; }
}

async function apiCall(path, token, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`API_${response.status}_${value.code ?? 'ERROR'}`);
  return value;
}

async function measure(path, token, samples = 5) {
  const durations = [];
  let last;
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    last = await apiCall(path, token);
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  return { samples, p50Ms: +durations[Math.floor((samples - 1) * 0.5)].toFixed(1), p95Ms: +durations[Math.ceil(samples * 0.95) - 1].toFixed(1), maxMs: +durations.at(-1).toFixed(1), last };
}

async function seedOutgoing(db, fixture, runId, count, start = 0) {
  assert.equal(fixture.server.smtpHost, '127.0.0.1');
  assert.equal(fixture.server.smtpPort, 51025);
  assert.equal(fixture.server.smtpAuthMode, 'NONE');
  const mailbox = fixture.mailboxes[0];
  const prefix = `Module14-${runId}-send-`;
  await db.outgoingMessage.createMany({ data: Array.from({ length: count }, (_, i) => ({ projectId: fixture.project.id, fromMailboxId: mailbox.id, subject: `${prefix}${start + i}`, textBody: `Synthetic Module 14 Mailpit-only message ${start + i}`, idempotencyKey: `${runId}-${start + i}`, requestHash: createHash('sha256').update(`${runId}-${start + i}`).digest('hex') })) });
  const messages = await db.outgoingMessage.findMany({ where: { projectId: fixture.project.id, subject: { in: Array.from({ length: count }, (_, i) => `${prefix}${start + i}`) } }, select: { id: true } });
  await db.outgoingRecipient.createMany({ data: messages.map((item, i) => ({ messageId: item.id, type: 'TO', email: `module14-recipient-${i}@example.test` })) });
  await db.outboxEvent.createMany({ data: messages.map(item => ({ messageId: item.id })) });
  await db.outboxEvent.create({ data: { messageId: messages[0].id } });
  return { prefix, messages };
}

function compose(service, action) {
  if (!['redis', 'postgres'].includes(service) || !['stop', 'start'].includes(action)) throw new Error('MODULE14_COMPOSE_ACTION_INVALID');
  const result = spawnSync('docker', ['compose', action, service], { cwd: root, windowsHide: true, stdio: 'ignore', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(`LOCAL_${service.toUpperCase()}_${action.toUpperCase()}_FAILED`);
}

async function batchResult(db, batch) {
  const ids = batch.messages.map(item => item.id);
  const rows = await db.outgoingMessage.findMany({ where: { id: { in: ids } }, select: { status: true, lastErrorCode: true } });
  const attempts = await db.smtpAttempt.findMany({ where: { messageId: { in: ids } }, select: { messageId: true } });
  return { accepted: rows.filter(row => row.status === 'SMTP_ACCEPTED').length, uncertain: rows.filter(row => row.lastErrorCode === 'SMTP_OUTCOME_UNKNOWN').length, processing: rows.filter(row => row.status === 'PROCESSING').length, attempts: attempts.length, duplicateAttempts: attempts.length - new Set(attempts.map(item => item.messageId)).size };
}

async function healthStatus() {
  try { return (await fetch(`http://127.0.0.1:${apiPort}/api/v1/health`, { signal: AbortSignal.timeout(7000) })).status; }
  catch { return 0; }
}

async function run() {
  const settings = localSettings();
  if (existsSync(stateFile)) throw new Error('MODULE14_STATE_EXISTS_RUN_PERF_CLEANUP_FIRST');
  const mailboxCount = Number(process.argv.find(arg => arg.startsWith('--mailboxes='))?.split('=')[1] ?? 100);
  const messageCount = Number(process.argv.find(arg => arg.startsWith('--messages='))?.split('=')[1] ?? 10000);
  const sendCount = Number(process.argv.find(arg => arg.startsWith('--sends='))?.split('=')[1] ?? 100);
  if (!Number.isInteger(mailboxCount) || mailboxCount < 100 || mailboxCount > 500 || !Number.isInteger(messageCount) || messageCount < 10000 || messageCount > 50000 || !Number.isInteger(sendCount) || sendCount < 100 || sendCount > 1000) throw new Error('MODULE14_LOAD_SIZE_INVALID');
  const mailpit = await fetch('http://127.0.0.1:8025/api/v1/messages?limit=1', { signal: AbortSignal.timeout(5000) });
  if (!mailpit.ok) throw new Error('LOCAL_MAILPIT_UNAVAILABLE');
  const redisDb = await freeRedisDb();
  const runId = randomBytes(4).toString('hex');
  const database = `umh_restore_${randomBytes(6).toString('hex')}`;
  const state = { marker: 'UNI_MAIL_HUB_MODULE14_SYNTHETIC', database, redisDb, runId, createdAt: new Date().toISOString() };
  let api; let worker; let db; let redis; let queue; let monitoringQueue; let stoppedService;
  createTemporaryDatabase(settings, database);
  mkdirSync(join(root, '.local-backups'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    const url = temporaryDatabaseUrl(settings, database);
    migrate(url);
    db = new PrismaClient({ datasources: { db: { url } } });
    const fixture = await seed(db, runId, mailboxCount, messageCount);
    redis = new Redis(redisUrl(redisDb), { maxRetriesPerRequest: 1 });
    queue = new Queue('mail-send', { connection: redis });
    const childEnv = { ...process.env, DATABASE_URL: url, REDIS_URL: redisUrl(redisDb), API_PORT: String(apiPort), API_URL: `http://127.0.0.1:${apiPort}`, MAIL_SEND_WORKER_CONCURRENCY: '5', MAIL_SYNC_WORKER_CONCURRENCY: '3', MONITORING_INTERVAL_MINUTES: '1440', RETENTION_ENABLED: 'false' };
    api = launch('api', childEnv);
    await waitFor('API', async () => (await fetch(`http://127.0.0.1:${apiPort}/api/v1/health`, { signal: AbortSignal.timeout(1000) })).ok, 20_000, api);
    const login = await apiCall('auth/login', null, 'POST', { email: fixture.email, password: fixture.password });
    assert(login.token);
    const token = login.token;
    const baseline = {
      api: processMetrics(api.pid),
      postgresConnections: Number((await db.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()'))[0].count),
      redisClients: Number((await redis.info('clients')).match(/connected_clients:(\d+)/)?.[1]),
      mailSendQueue: await queue.getJobCounts(),
    };
    const mailboxList = await measure('mailboxes', token);
    assert.equal(mailboxList.last.length, mailboxCount);
    const webmailMailboxes = await measure('webmail/mailboxes', token);
    assert.equal(webmailMailboxes.last.length, mailboxCount);
    const monitoring = await measure('monitoring', token);
    const cpanelPage = await measure(`cpanel-accounts/${fixture.cpanel.id}/discovery?page=1&pageSize=20`, token);
    assert.equal(cpanelPage.last.pagination.totalItems, 250);
    assert.equal(cpanelPage.last.mailboxes.length, 20);
    const cpanelLast = await apiCall(`cpanel-accounts/${fixture.cpanel.id}/discovery?page=13&pageSize=20`, token);
    assert.equal(cpanelLast.mailboxes.length, 10);
    const discoveredIds = new Set(cpanelPage.last.mailboxes.map(item => item.id));
    for (let page = 2; page <= 13; page++) {
      const value = page === 13 ? cpanelLast : await apiCall(`cpanel-accounts/${fixture.cpanel.id}/discovery?page=${page}&pageSize=20`, token);
      for (const item of value.mailboxes) discoveredIds.add(item.id);
    }
    assert.equal(discoveredIds.size, 250);
    const folder = fixture.folders.find(item => item.mailboxId === fixture.mailboxes[0].id);
    const inbox = await measure(`mailboxes/${fixture.mailboxes[0].id}/folders/${folder.id}/threads`, token);
    assert(inbox.last.items.length <= 50 && inbox.last.nextCursor);
    const inboxNext = await apiCall(`mailboxes/${fixture.mailboxes[0].id}/folders/${folder.id}/threads?cursor=${encodeURIComponent(inbox.last.nextCursor)}`, token);
    assert.equal(new Set([...inbox.last.items, ...inboxNext.items].map(item => item.id)).size, inbox.last.items.length + inboxNext.items.length);
    const searches = {};
    for (const [name, query] of Object.entries({ unified: 'folder=ALL', subject: 'q=alpha', sender: 'from=sender0%40example.test', recipient: 'to=recipient0%40example.test', body: 'q=needle', date: `after=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`, mailbox: `mailboxIds=${fixture.mailboxes[0].id}`, attachment: 'hasAttachment=true', unread: 'unread=true', flagged: 'flagged=true' })) {
      const result = await measure(`mail/search?${query}&limit=50`, token, 3);
      searches[name] = { p50Ms: result.p50Ms, p95Ms: result.p95Ms, resultCount: result.last.items.length };
      if (name === 'unified') {
        const first = await apiCall(`mail/search?${query}&limit=100`, token);
        const allIds = new Set(first.items.map(item => item.id));
        let cursor = first.nextCursor;
        let pages = 1;
        while (cursor) {
          await new Promise(resolve => setTimeout(resolve, 750));
          const next = await apiCall(`mail/search?${query}&limit=100&cursor=${encodeURIComponent(cursor)}`, token);
          for (const item of next.items) assert.equal(allIds.has(item.id), false, 'UNIFIED_CURSOR_DUPLICATE');
          for (const item of next.items) allIds.add(item.id);
          cursor = next.nextCursor;
          pages++;
          assert(pages <= Math.ceil(messageCount / 100) + 1, 'UNIFIED_CURSOR_LOOP');
        }
        assert.equal(allIds.size, messageCount);
        searches.unified.cursorPages = pages;
      }
    }
    worker = launch('worker', childEnv);
    await waitFor('WORKER', async () => !!await redis.get('monitor:worker:last'), 20_000, worker);
    baseline.workerBeforeSend = processMetrics(worker.pid);
    const sent = await seedOutgoing(db, fixture, runId, sendCount);
    const drainStart = performance.now();
    let terminal = 0;
    let workerPeakMiB = 0;
    await waitFor('MAIL_QUEUE_DRAIN', async () => {
      terminal = await db.outgoingMessage.count({ where: { id: { in: sent.messages.map(item => item.id) }, status: { in: ['SMTP_ACCEPTED', 'SMTP_ACCEPTED_WITH_REJECTIONS', 'FAILED'] } } });
      workerPeakMiB = Math.max(workerPeakMiB, processMetrics(worker.pid)?.rssMiB ?? 0);
      return terminal === sendCount;
    }, 180_000);
    const drainMinutes = (performance.now() - drainStart) / 60_000;
    const attempts = await db.smtpAttempt.findMany({ where: { messageId: { in: sent.messages.map(item => item.id) } }, select: { messageId: true, status: true, startedAt: true, message: { select: { queuedAt: true } } } });
    const accepted = await db.outgoingMessage.count({ where: { id: { in: sent.messages.map(item => item.id) }, status: 'SMTP_ACCEPTED' } });
    const duplicateAttempts = attempts.length - new Set(attempts.map(item => item.messageId)).size;
    const delays = attempts.map(item => item.startedAt.getTime() - item.message.queuedAt.getTime());
    assert.equal(accepted, sendCount);
    assert.equal(duplicateAttempts, 0);
    assert.equal((await mailpitRunIds(runId)).size, sendCount);
    const after = { api: processMetrics(api.pid), worker: processMetrics(worker.pid), workerPeakMiB, postgresConnections: Number((await db.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()'))[0].count), redisClients: Number((await redis.info('clients')).match(/connected_clients:(\d+)/)?.[1]), mailSendQueue: await queue.getJobCounts() };
    console.log(JSON.stringify({ scope: 'local synthetic temporary database and Mailpit', runId, database, redisDb, mailboxCount, messageCount, discoveredMailboxes: 250, sendCount, baseline, timingsMs: { mailboxList: mailboxList.p95Ms, webmailMailboxes: webmailMailboxes.p95Ms, monitoring: monitoring.p95Ms, cpanelPage: cpanelPage.p95Ms, inbox: inbox.p95Ms, searches }, smtp: { accepted, attempts: attempts.length, duplicateAttempts, throughputPerMinute: Math.round(sendCount / drainMinutes), averageQueueDelayMs: Math.round(delays.reduce((sum, value) => sum + value, 0) / delays.length) }, after }));
    if (process.argv.includes('--recovery')) {
      const recovery = {};
      const firstHeartbeat = JSON.parse(await redis.get('monitor:worker:last'));
      const workerBatch = await seedOutgoing(db, fixture, runId, 20, sendCount);
      await stop(worker);
      worker = launch('worker', childEnv);
      await waitFor('WORKER_RESTART', async () => JSON.parse(await redis.get('monitor:worker:last') ?? '{}').workerId !== firstHeartbeat.workerId, 20000, worker);
      await waitFor('WORKER_RESTART_DRAIN', async () => (await batchResult(db, workerBatch)).accepted === 20, 60000, worker);
      recovery.workerRestart = await batchResult(db, workerBatch);
      const apiBatch = await seedOutgoing(db, fixture, runId, 20, sendCount + 20);
      await stop(api);
      await waitFor('API_RESTART_BACKGROUND_DRAIN', async () => (await batchResult(db, apiBatch)).accepted === 20, 60000, worker);
      api = launch('api', childEnv);
      await waitFor('API_RESTART', async () => (await healthStatus()) === 200, 20000, api);
      assert.equal((await apiCall('mailboxes', token)).length, mailboxCount);
      recovery.apiRestart = { ...await batchResult(db, apiBatch), health: await healthStatus(), sessionPreserved: true };
      const redisBatch = await seedOutgoing(db, fixture, runId, 20, sendCount + 40);
      compose('redis', 'stop'); stoppedService = 'redis';
      recovery.redisDownHealth = await healthStatus();
      assert.equal(recovery.redisDownHealth, 503);
      compose('redis', 'start'); stoppedService = undefined;
      await waitFor('REDIS_RECOVERED', async () => (await healthStatus()) === 200, 30000);
      await waitFor('REDIS_DRAIN', async () => (await batchResult(db, redisBatch)).accepted === 20, 90000, worker);
      recovery.redisRestart = await batchResult(db, redisBatch);
      const postgresBatch = await seedOutgoing(db, fixture, runId, 20, sendCount + 60);
      compose('postgres', 'stop'); stoppedService = 'postgres';
      recovery.postgresDownHealth = await healthStatus();
      assert.equal(recovery.postgresDownHealth, 503);
      compose('postgres', 'start'); stoppedService = undefined;
      await waitFor('POSTGRES_RECOVERED', async () => (await healthStatus()) === 200, 60000);
      await waitFor('POSTGRES_RECONCILED', async () => { const value = await batchResult(db, postgresBatch); return value.accepted + value.uncertain === 20 && value.processing === 0; }, 120000, worker);
      recovery.postgresRestart = await batchResult(db, postgresBatch);
      assert.equal(Object.values(recovery).filter(value => typeof value === 'object').reduce((sum, value) => sum + value.duplicateAttempts, 0), 0);
      assert.equal((await mailpitRunIds(runId)).size, sendCount + 80);
      monitoringQueue = new Queue('monitoring', { connection: redis });
      const monitoringRun = await db.monitoringRun.create({ data: { trigger: 'MODULE14_BACKLOG' } });
      let duplicateActiveRunRejected = false;
      try { await db.monitoringRun.create({ data: { trigger: 'MODULE14_OVERLAP' } }); }
      catch (error) { if (error?.code === 'P2002') duplicateActiveRunRejected = true; else throw error; }
      assert(duplicateActiveRunRejected);
      await monitoringQueue.add('run', { runId: monitoringRun.id }, { jobId: monitoringRun.id, attempts: 1 });
      await monitoringQueue.add('run', { runId: monitoringRun.id }, { jobId: monitoringRun.id, attempts: 1 });
      await waitFor('MONITORING_BACKLOG_DRAIN', async () => {
        const row = await db.monitoringRun.findUnique({ where: { id: monitoringRun.id }, select: { status: true } });
        return !!row && ['SUCCESS', 'PARTIAL', 'FAILED'].includes(row.status);
      }, 180000, worker);
      const monitored = await db.monitoringRun.findUniqueOrThrow({ where: { id: monitoringRun.id }, select: { status: true, resultCount: true, errorCode: true } });
      const openIssues = await db.monitoringIssue.findMany({ where: { status: 'OPEN' }, select: { targetType: true, targetId: true, checkType: true } });
      assert(['SUCCESS', 'PARTIAL'].includes(monitored.status) && monitored.resultCount >= mailboxCount);
      assert.equal(new Set(openIssues.map(item => `${item.targetType}:${item.targetId}:${item.checkType}`)).size, openIssues.length);
      recovery.monitoringBacklog = { run: monitored, duplicateActiveRunRejected, openIssues: openIssues.length, queue: await monitoringQueue.getJobCounts(), workerHeartbeatPresent: !!await redis.get('monitor:worker:last') };
      console.log(JSON.stringify({ scope: 'isolated Module 14 recovery', runId, recovery, worker: processMetrics(worker.pid), api: processMetrics(api.pid) }));
    }
  } finally {
    if (stoppedService) compose(stoppedService, 'start');
    await stop(worker);
    await stop(api);
    if (queue) await queue.close();
    if (monitoringQueue) await monitoringQueue.close();
    if (redis) redis.disconnect();
    if (db) await db.$disconnect();
    await cleanState(settings, state);
  }
}

const action = process.argv[2];
if (action === 'cleanup') await cleanupCommand();
else if (action === 'mailpit-cleanup') {
  const runId = process.argv.find(arg => arg.startsWith('--run-id='))?.split('=')[1] ?? '';
  console.log(JSON.stringify({ cleanedSyntheticMailpitMessages: await cleanMailpit(runId), runId }));
}
else if (action === 'run') await run();
else throw new Error('MODULE14_USAGE_RUN_OR_CLEANUP');
