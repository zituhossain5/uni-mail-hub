import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '../packages/database/generated/client';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { preSmtpMarker, smtpPendingMarker, recoverStaleOutgoing, safeSmtpFailure } from '../apps/worker/src/recovery';
import { deliveryDecision, dispatchWebhookDeliveries } from '../apps/worker/src/webhook-delivery';
import { collectCpanelDiscovery } from '../apps/worker/src/cpanel-discovery';
import { renewMonitoringLease } from '../apps/worker/src/monitoring';

const now = new Date('2026-10-11T09:00:00Z');
type Row = { id: string; status: string; processingAt: Date | null; attemptCount: number; lastErrorCode: string | null; smtpAcceptedAt: Date | null; failedAt?: Date | null };
function fakeDb(row: Row, attempt: { status: 'ACCEPTED' | 'PARTIAL'; finishedAt: Date } | null = null) {
  let outbox = 0;
  const tx = {
    outgoingMessage: {
      findUnique: async () => ({ ...row }),
      updateMany: async ({ where, data }: { where: { status: string; processingAt: { lt: Date }; attemptCount: number; lastErrorCode?: string }; data: Record<string, unknown> }) => {
        if (row.status !== where.status || !row.processingAt || row.processingAt >= where.processingAt.lt || row.attemptCount !== where.attemptCount || where.lastErrorCode && row.lastErrorCode !== where.lastErrorCode) return { count: 0 };
        const priorAttempts = row.attemptCount;
        Object.assign(row, data);
        if (typeof data.attemptCount === 'object' && data.attemptCount) row.attemptCount = priorAttempts - (data.attemptCount as { decrement: number }).decrement;
        return { count: 1 };
      },
    },
    smtpAttempt: { findFirst: async () => attempt },
    outboxEvent: { create: async () => { outbox++; } },
  };
  const db = {
    outgoingMessage: { findMany: async () => row.status === 'PROCESSING' ? [{ id: row.id }] : [] },
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  return { db, row, outbox: () => outbox };
}

test('pre-SMTP interruption requeues once and returns the unused attempt number', async () => {
  const fixture = fakeDb({ id: 'synthetic', status: 'PROCESSING', processingAt: new Date(now.getTime() - 200_000), attemptCount: 1, lastErrorCode: preSmtpMarker, smtpAcceptedAt: null });
  assert.deepEqual(await recoverStaleOutgoing(fixture.db, 120, now), { requeued: 1, accepted: 0, uncertain: 0 });
  assert.equal(fixture.row.status, 'RETRY_SCHEDULED');
  assert.equal(fixture.row.attemptCount, 0);
  assert.equal(fixture.outbox(), 1);
  await recoverStaleOutgoing(fixture.db, 120, now);
  assert.equal(fixture.outbox(), 1);
});

test('in-flight and legacy interruptions never auto-resend', async () => {
  for (const marker of [smtpPendingMarker, null]) {
    const fixture = fakeDb({ id: 'synthetic', status: 'PROCESSING', processingAt: new Date(now.getTime() - 200_000), attemptCount: 1, lastErrorCode: marker, smtpAcceptedAt: null });
    assert.equal((await recoverStaleOutgoing(fixture.db, 120, now)).uncertain, 1);
    assert.equal(fixture.row.status, 'FAILED');
    assert.equal(fixture.row.lastErrorCode, 'SMTP_OUTCOME_UNKNOWN');
    assert.equal(fixture.outbox(), 0);
  }
});

test('recorded SMTP acceptance wins over stale PROCESSING state', async () => {
  const fixture = fakeDb({ id: 'synthetic', status: 'PROCESSING', processingAt: new Date(now.getTime() - 200_000), attemptCount: 1, lastErrorCode: smtpPendingMarker, smtpAcceptedAt: null }, { status: 'PARTIAL', finishedAt: now });
  assert.equal((await recoverStaleOutgoing(fixture.db, 120, now)).accepted, 1);
  assert.equal(fixture.row.status, 'SMTP_ACCEPTED_WITH_REJECTIONS');
  assert.equal(fixture.row.lastErrorCode, 'PARTIAL_RECIPIENT_REJECTION');
  assert.equal(fixture.outbox(), 0);
});

test('recent processing is untouched and ambiguous SMTP failures are not retried', async () => {
  const fixture = fakeDb({ id: 'synthetic', status: 'PROCESSING', processingAt: new Date(now.getTime() - 30_000), attemptCount: 1, lastErrorCode: preSmtpMarker, smtpAcceptedAt: null });
  assert.equal((await recoverStaleOutgoing(fixture.db, 120, now)).requeued, 0);
  assert.equal(fixture.row.status, 'PROCESSING');
  const failure = { code: 'SMTP_TIMEOUT', message: 'timeout', retryable: true, smtpResponseCode: null };
  assert.equal(safeSmtpFailure(failure, true).code, 'SMTP_OUTCOME_UNKNOWN');
  assert.equal(safeSmtpFailure(failure, true).retryable, false);
  assert.equal(safeSmtpFailure(failure, false).retryable, true);
});

test('webhook backlog decisions distinguish success, retry, Retry-After and permanent errors', () => {
  assert.equal(deliveryDecision(204, 1, 5).status, 'DELIVERED');
  assert.deepEqual(deliveryDecision(500, 1, 5), { status: 'RETRY_SCHEDULED', delaySeconds: 60 });
  assert.deepEqual(deliveryDecision(429, 2, 5, 600), { status: 'RETRY_SCHEDULED', delaySeconds: 600 });
  assert.equal(deliveryDecision(400, 1, 5).status, 'FAILED');
  assert.equal(deliveryDecision(500, 5, 5).status, 'FAILED');
});

test('webhook backlog dispatch is bounded, preserves both endpoints, and recovers stale delivery', async () => {
  const rows: { id: string; endpoint: number; status: string; attemptCount: number }[] = Array.from({ length: 120 }, (_, index) => ({ id: `synthetic-${index}`, endpoint: index % 2, status: index === 0 ? 'DELIVERING' : 'PENDING', attemptCount: 0 }));
  const jobs = new Set<string>();
  const db = { webhookDelivery: {
    updateMany: async () => { if (rows[0]!.status === 'DELIVERING') { rows[0]!.status = 'RETRY_SCHEDULED'; return { count: 1 }; } return { count: 0 }; },
    findMany: async () => rows.filter(row => row.status === 'PENDING' || row.status === 'RETRY_SCHEDULED').slice(0, 50),
  } } as unknown as PrismaClient;
  const queue = { add: async (_name: string, data: { deliveryId: string }, options: { jobId: string }) => {
    assert.equal(options.jobId, `${data.deliveryId}-1`);
    jobs.add(data.deliveryId);
  } } as unknown as Queue;
  for (let page = 0; page < 3; page++) {
    await dispatchWebhookDeliveries(db, queue, 120);
    assert.equal(jobs.size, Math.min((page + 1) * 50, 120));
    for (const row of rows) if (jobs.has(row.id)) row.status = 'DELIVERED';
  }
  assert.equal(jobs.size, 120);
  assert.equal(rows.filter(row => row.endpoint === 0).length, 60);
  assert.equal(rows.filter(row => row.endpoint === 1).length, 60);
  assert.equal(rows[0]!.status, 'DELIVERED');
});

test('cPanel timeout is normalized and does not discard successful domains', async () => {
  const result = await collectCpanelDiscovery({
    listDomains: async () => ['module14.test'],
    listMailboxes: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
    listForwarders: async () => [],
  });
  assert.deepEqual(result.domains, ['module14.test']);
  assert.equal(result.mailboxes, null);
  assert.equal(result.failures[0]?.code, 'CPANEL_TIMEOUT');
});

test('active monitoring run reacquires a lost Redis lease without stealing another run', async () => {
  let owner: string | null = null;
  let renewals = 0;
  const redis = {
    get: async () => owner,
    expire: async () => { renewals++; return 1; },
    set: async (_key: string, value: string) => { if (owner !== null) return null; owner = value; return 'OK'; },
  } as unknown as Pick<Redis, 'get' | 'expire' | 'set'>;
  await renewMonitoringLease(redis, 'synthetic-run');
  assert.equal(owner, 'synthetic-run');
  await renewMonitoringLease(redis, 'synthetic-run');
  assert.equal(renewals, 1);
  owner = 'other-run';
  await renewMonitoringLease(redis, 'synthetic-run');
  assert.equal(owner, 'other-run');
});
