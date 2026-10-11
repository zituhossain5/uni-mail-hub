import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@uni/database';
import type { readConfig } from '@uni/config';
import Redis from 'ioredis';

type Config = ReturnType<typeof readConfig>;
type Task = {
  name: string;
  count: () => Promise<number>;
  ids: (take: number) => Promise<{ id: string }[]>;
  remove: (ids: string[]) => Promise<number>;
};

export function retentionCutoff(now: Date, days: number) {
  return new Date(now.getTime() - days * 86_400_000);
}

export function retentionTasks(db: PrismaClient, config: Config, now: Date): Task[] {
  const monitoring = retentionCutoff(now, config.RETENTION_MONITORING_DAYS);
  const webhookDelivery = retentionCutoff(now, config.RETENTION_WEBHOOK_DELIVERY_DAYS);
  const webhookEvent = retentionCutoff(now, config.RETENTION_WEBHOOK_EVENT_DAYS);
  const sync = retentionCutoff(now, config.RETENTION_SYNC_RUN_DAYS);
  const connection = retentionCutoff(now, config.RETENTION_CONNECTION_CHECK_DAYS);
  const smtp = retentionCutoff(now, config.RETENTION_SMTP_ATTEMPT_DAYS);
  const audit = retentionCutoff(now, config.RETENTION_AUDIT_DAYS);
  const runWhere: Prisma.MonitoringRunWhereInput = { status: { in: ['SUCCESS', 'PARTIAL', 'FAILED'] }, createdAt: { lt: monitoring } };
  const resultWhere: Prisma.MonitoringResultWhereInput = { run: { is: runWhere } };
  const finishedRunWhere: Prisma.MonitoringRunWhereInput = { ...runWhere, results: { none: {} } };
  const issueWhere: Prisma.MonitoringIssueWhereInput = { status: 'RESOLVED', resolvedAt: { lt: monitoring } };
  const deliveryWhere: Prisma.WebhookDeliveryWhereInput = { status: 'DELIVERED', deliveredAt: { lt: webhookDelivery } };
  const eventWhere: Prisma.WebhookEventWhereInput = { createdAt: { lt: webhookEvent }, deliveries: { none: {} } };
  const syncWhere: Prisma.MailSyncRunWhereInput = { status: { in: ['SUCCESS', 'PARTIAL', 'FAILED'] }, completedAt: { lt: sync } };
  const connectionWhere: Prisma.MailboxConnectionCheckWhereInput = { testedAt: { lt: connection } };
  const smtpWhere: Prisma.SmtpAttemptWhereInput = { finishedAt: { lt: smtp }, message: { is: { status: { in: ['SMTP_ACCEPTED', 'SMTP_ACCEPTED_WITH_REJECTIONS', 'FAILED', 'CANCELLED'] } } } };
  const auditWhere: Prisma.AuditLogWhereInput = { createdAt: { lt: audit } };
  return [
    { name: 'monitoringResults', count: () => db.monitoringResult.count({ where: resultWhere }), ids: take => db.monitoringResult.findMany({ where: resultWhere, select: { id: true }, orderBy: { id: 'asc' }, take }), remove: async ids => (await db.monitoringResult.deleteMany({ where: { ...resultWhere, id: { in: ids } } })).count },
    { name: 'monitoringRuns', count: () => db.monitoringRun.count({ where: runWhere }), ids: take => db.monitoringRun.findMany({ where: finishedRunWhere, select: { id: true }, orderBy: { id: 'asc' }, take }), remove: async ids => (await db.monitoringRun.deleteMany({ where: { ...finishedRunWhere, id: { in: ids } } })).count },
    { name: 'resolvedMonitoringIssues', count: () => db.monitoringIssue.count({ where: issueWhere }), ids: take => db.monitoringIssue.findMany({ where: issueWhere, select: { id: true }, orderBy: { id: 'asc' }, take }), remove: async ids => (await db.monitoringIssue.deleteMany({ where: { ...issueWhere, id: { in: ids } } })).count },
    { name: 'deliveredWebhooks', count: () => db.webhookDelivery.count({ where: deliveryWhere }), ids: take => db.webhookDelivery.findMany({ where: deliveryWhere, select: { id: true }, orderBy: { id: 'asc' }, take }), remove: async ids => (await db.webhookDelivery.deleteMany({ where: { ...deliveryWhere, id: { in: ids } } })).count },
    { name: 'orphanedWebhookEvents', count: () => db.webhookEvent.count({ where: eventWhere }), ids: take => db.webhookEvent.findMany({ where: eventWhere, select: { id: true }, orderBy: { id: 'asc' }, take }), remove: async ids => (await db.webhookEvent.deleteMany({ where: { ...eventWhere, id: { in: ids } } })).count },
    { name: 'finishedSyncRuns', count: () => db.mailSyncRun.count({ where: syncWhere }), ids: take => db.mailSyncRun.findMany({ where: syncWhere, select: { id: true }, orderBy: { id: 'asc' }, take }), remove: async ids => (await db.mailSyncRun.deleteMany({ where: { ...syncWhere, id: { in: ids } } })).count },
    { name: 'connectionChecks', count: () => db.mailboxConnectionCheck.count({ where: connectionWhere }), ids: take => db.mailboxConnectionCheck.findMany({ where: connectionWhere, select: { id: true }, orderBy: { id: 'asc' }, take }), remove: async ids => (await db.mailboxConnectionCheck.deleteMany({ where: { ...connectionWhere, id: { in: ids } } })).count },
    { name: 'terminalSmtpAttempts', count: () => db.smtpAttempt.count({ where: smtpWhere }), ids: take => db.smtpAttempt.findMany({ where: smtpWhere, select: { id: true }, orderBy: { id: 'asc' }, take }), remove: async ids => (await db.smtpAttempt.deleteMany({ where: { ...smtpWhere, id: { in: ids } } })).count },
    { name: 'auditLogs', count: () => db.auditLog.count({ where: auditWhere }), ids: take => db.auditLog.findMany({ where: auditWhere, select: { id: true }, orderBy: { id: 'asc' }, take }), remove: async ids => (await db.auditLog.deleteMany({ where: { ...auditWhere, id: { in: ids } } })).count },
  ];
}

export async function runRetention(db: PrismaClient, config: Config, dryRun: boolean, now = new Date()) {
  const started = Date.now();
  const tasks = retentionTasks(db, config, now);
  const eligible: Record<string, number> = {};
  const deleted: Record<string, number> = {};
  for (const task of tasks) eligible[task.name] = await task.count();
  if (!dryRun) {
    let remaining = config.RETENTION_MAX_ROWS_PER_RUN;
    for (const task of tasks) {
      deleted[task.name] = 0;
      while (remaining > 0) {
        const take = Math.min(config.RETENTION_BATCH_SIZE, remaining);
        const rows = await task.ids(take);
        if (!rows.length) break;
        const count = await task.remove(rows.map(row => row.id));
        deleted[task.name] = (deleted[task.name] ?? 0) + count;
        remaining -= rows.length;
        if (rows.length < take) break;
      }
    }
    if (Object.values(deleted).some(count => count > 0)) {
      await db.auditLog.create({ data: { action: 'RETENTION_CLEANUP', entityType: 'Maintenance', metadata: { deleted, cutoffAt: now.toISOString() } } });
    }
  }
  return { dryRun, eligible, deleted, durationMs: Date.now() - started, capped: !dryRun && Object.values(deleted).reduce((a, b) => a + b, 0) >= config.RETENTION_MAX_ROWS_PER_RUN };
}

export async function withRetentionLease<T>(redisUrl: string, work: () => Promise<T>) {
  const redis = new Redis(redisUrl);
  const token = randomUUID();
  try {
    const acquired = await redis.set('maintenance:retention:lease', token, 'EX', 3600, 'NX');
    if (acquired !== 'OK') throw new Error('RETENTION_ALREADY_RUNNING');
    try { return await work(); }
    finally { await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, 'maintenance:retention:lease', token); }
  } finally {
    await redis.quit();
  }
}
