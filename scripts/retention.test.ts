import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '../packages/database/generated/client';
import type { readConfig } from '../packages/config/src/index';
import { retentionCutoff, retentionTasks, runRetention } from '../apps/worker/src/retention';

const now = new Date('2026-10-11T12:00:00.000Z');
const policy = {
  RETENTION_BATCH_SIZE: 2,
  RETENTION_MAX_ROWS_PER_RUN: 3,
  RETENTION_MONITORING_DAYS: 90,
  RETENTION_AUDIT_DAYS: 365,
  RETENTION_WEBHOOK_DELIVERY_DAYS: 90,
  RETENTION_WEBHOOK_EVENT_DAYS: 180,
  RETENTION_SYNC_RUN_DAYS: 90,
  RETENTION_CONNECTION_CHECK_DAYS: 90,
  RETENTION_SMTP_ATTEMPT_DAYS: 180,
  RETENTION_OUTGOING_MESSAGE_DAYS: 365,
} as ReturnType<typeof readConfig>;

function fakeDatabase() {
  const captured: Record<string, unknown> = {};
  const model = (name: string) => ({
    count: async () => 0,
    findMany: async () => [],
    deleteMany: async (args: unknown) => { captured[name] = args; return { count: 0 }; },
  });
  const db = {
    monitoringResult: model('monitoringResult'), monitoringRun: model('monitoringRun'), monitoringIssue: model('monitoringIssue'),
    webhookDelivery: model('webhookDelivery'), webhookEvent: model('webhookEvent'), mailSyncRun: model('mailSyncRun'),
    mailboxConnectionCheck: model('mailboxConnectionCheck'), smtpAttempt: model('smtpAttempt'), auditLog: { ...model('auditLog'), create: async () => { throw new Error('Unexpected audit write'); } },
  } as unknown as PrismaClient;
  return { db, captured };
}

test('cutoffs are deterministic and synchronized messages have no cleanup task', () => {
  assert.equal(retentionCutoff(now, 90).toISOString(), '2026-07-13T12:00:00.000Z');
  const { db } = fakeDatabase();
  assert.equal(retentionTasks(db, policy, now).some(task => /message|attachment|outgoing/i.test(task.name)), false);
});

test('retention predicates preserve active issues, retrying webhooks, running syncs, and nonterminal SMTP history', async () => {
  const { db, captured } = fakeDatabase();
  for (const task of retentionTasks(db, policy, now)) await task.remove(['synthetic-id']);
  const issue = captured.monitoringIssue as { where: { status: string; resolvedAt: unknown } };
  const delivery = captured.webhookDelivery as { where: { status: string; deliveredAt: unknown } };
  const event = captured.webhookEvent as { where: { deliveries: { none: unknown } } };
  const sync = captured.mailSyncRun as { where: { status: { in: string[] }; completedAt: unknown } };
  const smtp = captured.smtpAttempt as { where: { message: { is: { status: { in: string[] } } } } };
  assert.equal(issue.where.status, 'RESOLVED');
  assert.equal(delivery.where.status, 'DELIVERED');
  assert.deepEqual(event.where.deliveries, { none: {} });
  assert.equal(sync.where.status.in.includes('RUNNING'), false);
  assert.equal(smtp.where.message.is.status.in.includes('PROCESSING'), false);
});

test('dry run counts without deleting; live run respects total and per-batch limits', async () => {
  const { db } = fakeDatabase();
  const pending = ['one', 'two', 'three', 'four', 'five'];
  const batches: number[] = [];
  let audits = 0;
  const mutable = db as unknown as { monitoringResult: { count: () => Promise<number>; findMany: (args: { take: number }) => Promise<{ id: string }[]>; deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<{ count: number }> }; auditLog: { create: () => Promise<unknown> } };
  mutable.monitoringResult = {
    count: async () => pending.length,
    findMany: async ({ take }) => pending.slice(0, take).map(id => ({ id })),
    deleteMany: async ({ where }) => { batches.push(where.id.in.length); for (const id of where.id.in) pending.splice(pending.indexOf(id), 1); return { count: where.id.in.length }; },
  };
  mutable.auditLog.create = async () => { audits++; return {}; };
  const dry = await runRetention(db, policy, true, now);
  assert.equal(dry.eligible.monitoringResults, 5);
  assert.equal(pending.length, 5);
  assert.equal(audits, 0);
  const live = await runRetention(db, policy, false, now);
  assert.equal(live.deleted.monitoringResults, 3);
  assert.deepEqual(batches, [2, 1]);
  assert.equal(pending.length, 2);
  assert.equal(audits, 1);
  assert.equal(live.capped, true);
});
