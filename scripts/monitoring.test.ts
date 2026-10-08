import 'reflect-metadata';
import assert from 'node:assert/strict';
import { connectionHealth, dkimHealth, heartbeatHealth, issueDecision, queueHealth, quotaHealth, syncHealth, tlsHealth } from '../apps/worker/src/monitoring-rules';
import { domainChecks } from '../apps/worker/src/monitoring-dns';
import { tlsFailure } from '../apps/worker/src/monitoring-tls';
import { MonitoringWatchdog } from '../apps/api/dist/monitoring.js';

async function main() {
const now = new Date('2026-10-08T12:00:00Z');
assert.equal(connectionHealth({ status: 'SUCCESS', errorCode: null, configVersion: 2 }, 2, 'IMAP', true).status, 'HEALTHY');
assert.deepEqual(connectionHealth({ status: 'FAILED', errorCode: 'IMAP_AUTH_FAILED', configVersion: 2 }, 2, 'IMAP', true).errorCode, 'IMAP_AUTH_FAILED');
assert.equal(connectionHealth(null, 2, 'SMTP', false).status, 'WARNING');
assert.equal(connectionHealth({ status: 'SUCCESS', errorCode: null, configVersion: 1 }, 2, 'IMAP', true).status, 'UNKNOWN');
assert.equal(syncHealth(null, now, 15, 60, 5).status, 'UNKNOWN');
assert.equal(syncHealth({ status: 'SUCCESS', completedAt: new Date(now.getTime() - 5 * 60000) }, now, 15, 60, 5).status, 'HEALTHY');
assert.equal(syncHealth({ status: 'SUCCESS', completedAt: new Date(now.getTime() - 30 * 60000) }, now, 15, 60, 5).status, 'WARNING');
assert.equal(syncHealth({ status: 'SUCCESS', completedAt: new Date(now.getTime() - 70 * 60000) }, now, 15, 60, 5).status, 'CRITICAL');
assert.equal(syncHealth({ status: 'FAILED', completedAt: now, errorCode: 'IMAP_AUTH_FAILED' }, now, 15, 60, 5).status, 'CRITICAL');
assert.equal(quotaHealth({ usedBytes: 80n, quotaBytes: 100n, unlimitedQuota: false }, 80, 95).status, 'WARNING');
assert.equal(quotaHealth({ usedBytes: 95n, quotaBytes: 100n, unlimitedQuota: false }, 80, 95).status, 'CRITICAL');
assert.equal(quotaHealth({ usedBytes: null, quotaBytes: null, unlimitedQuota: true }, 80, 95).status, 'UNKNOWN');
assert.equal(quotaHealth(null, 80, 95).status, 'UNKNOWN');

const key = 'A'.repeat(44);
const validDns = { mx: async () => [{ exchange: 'mail.example.test', priority: 10 }], txt: async (name: string) => name.startsWith('_dmarc.') ? [['v=DMARC1; p=none']] : name.includes('._domainkey.') ? [[`v=DKIM1; p=${key}`]] : [['v=spf1 -all']] };
const valid = await domainChecks('example.test', ['default'], validDns);
for (const type of ['MX', 'SPF', 'DMARC', 'DKIM:default']) assert.equal(valid[type]?.status, 'HEALTHY', type);
const missingDns = { mx: async () => [], txt: async () => [] as string[][] };
const missing = await domainChecks('example.test', ['default'], missingDns);
assert.equal(missing.MX?.errorCode, 'MX_MISSING');
assert.equal(missing.SPF?.errorCode, 'SPF_MISSING');
assert.equal(missing.DMARC?.errorCode, 'DMARC_MISSING');
assert.equal(missing['DKIM:default']?.errorCode, 'DKIM_RECORD_MISSING');
assert.equal((await domainChecks('example.test', [], missingDns)).DKIM?.status, 'UNKNOWN');
assert.equal((await domainChecks('example.test', [], { ...validDns, txt: async (name: string) => name === 'example.test' ? [['v=spf1 -all'], ['v=spf1 ~all']] : validDns.txt(name) })).SPF?.errorCode, 'SPF_MULTIPLE_RECORDS');
assert.equal(dkimHealth('default', ['v=DKIM1; p=bad']).status, 'WARNING');

assert.equal(tlsHealth(new Date(now.getTime() + 100 * 86400000), now, 30).status, 'HEALTHY');
assert.equal(tlsHealth(new Date(now.getTime() + 10 * 86400000), now, 30).status, 'WARNING');
assert.equal(tlsHealth(new Date(now.getTime() - 86400000), now, 30).status, 'CRITICAL');
assert.equal(tlsFailure({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }).errorCode, 'TLS_CERT_INVALID');
assert.equal(tlsFailure({ code: 'CERT_HAS_EXPIRED' }).errorCode, 'TLS_CERT_EXPIRED');

assert.equal(issueDecision(false, 'CRITICAL'), 'CREATE');
assert.equal(issueDecision(true, 'CRITICAL'), 'UPDATE');
assert.equal(issueDecision(true, 'HEALTHY'), 'RESOLVE');
assert.equal(issueDecision(false, 'CRITICAL'), 'CREATE'); // recurrence after resolution
assert.equal(issueDecision(true, 'UNKNOWN'), 'KEEP');
assert.equal(heartbeatHealth(now, new Date(now.getTime() + 30000), 90).status, 'HEALTHY');
assert.equal(heartbeatHealth(now, new Date(now.getTime() + 100000), 90).errorCode, 'WORKER_HEARTBEAT_STALE');
assert.equal(queueHealth({ waiting: 2, active: 1, delayed: 10, failed: 0 }, 100).status, 'HEALTHY');
assert.equal(queueHealth({ waiting: 101, active: 1, delayed: 0, failed: 0 }, 100).errorCode, 'QUEUE_BACKLOG');
const rows: Array<Record<string, unknown>> = [];
let heartbeatText = JSON.stringify({ lastHeartbeatAt: new Date(Date.now() - 600000).toISOString() });
const fakeDb = { monitoringIssue: {
  findFirst: async ({ where }: { where: { targetType: string; targetId: string; checkType: string; status: string } }) => rows.find(row => row.targetType === where.targetType && row.targetId === where.targetId && row.checkType === where.checkType && row.status === where.status) ?? null,
  create: async ({ data }: { data: Record<string, unknown> }) => { const row = { ...data, id: `issue-${rows.length}`, status: 'OPEN', lastDetectedAt: new Date() }; rows.push(row); return row; },
  updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => { const row = rows.find(item => item.id === where.id && item.status === where.status); if (row) Object.assign(row, data); return { count: row ? 1 : 0 }; },
} } as unknown as ConstructorParameters<typeof MonitoringWatchdog>[0];
const fakeRedis = { client: { ping: async () => 'PONG', get: async () => heartbeatText } } as unknown as ConstructorParameters<typeof MonitoringWatchdog>[1];
const watchdog = new MonitoringWatchdog(fakeDb, fakeRedis);
const watchdogCheck = () => (watchdog as unknown as { check: () => Promise<void> }).check();
await watchdogCheck();
assert.equal(rows.filter(row => row.targetType === 'WORKER' && row.status === 'OPEN').length, 1);
await watchdogCheck();
assert.equal(rows.filter(row => row.targetType === 'WORKER').length, 1, 'stale heartbeat must not duplicate an open issue');
heartbeatText = JSON.stringify({ lastHeartbeatAt: new Date().toISOString() });
await watchdogCheck();
assert.equal(rows[0]?.status, 'RESOLVED');
heartbeatText = JSON.stringify({ lastHeartbeatAt: new Date(Date.now() - 600000).toISOString() });
await watchdogCheck();
assert.equal(rows.filter(row => row.targetType === 'WORKER' && row.status === 'OPEN').length, 1, 'recurrence opens a new issue');
console.log('Monitoring tests passed: mailbox, DNS, TLS, issue lifecycle, heartbeat, queue, API watchdog.');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
