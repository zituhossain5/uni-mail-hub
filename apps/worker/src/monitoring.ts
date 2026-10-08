import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { Prisma, PrismaClient } from '@uni/database';
import { readConfig } from '@uni/config';
import { decryptSecret } from '@uni/security';
import { testImap, testSmtp } from '@uni/mail';
import { Check, Health, connectionHealth, heartbeatHealth, issueDecision, queueHealth, quotaHealth, syncHealth } from './monitoring-rules';
import { domainChecks } from './monitoring-dns';
import { inspectMailTls } from './monitoring-tls';
import { emitWebhookEvent } from './webhook-events';

type Config = ReturnType<typeof readConfig>;
const severity: Record<Health, number> = { HEALTHY: 0, UNKNOWN: 1, WARNING: 2, CRITICAL: 3 };
const overall = (checks: Check[]): Health => checks.reduce<Health>((state, check) => severity[check.status] > severity[state] ? check.status : state, 'HEALTHY');

async function record(db: PrismaClient, runId: string, targetType: string, targetId: string, targetName: string, checkType: string, check: Check) {
  const now = new Date();
  await db.$transaction(async tx => {
    await tx.monitoringResult.create({ data: { runId, targetType, targetId, targetName, checkType, status: check.status, summary: check.summary.slice(0, 500), errorCode: check.errorCode, details: check.details as Prisma.InputJsonValue | undefined, checkedAt: now, latencyMs: check.latencyMs } });
    if (check.status === 'UNKNOWN' || checkType === 'OVERALL') return;
    const key = { targetType, targetId, checkType, status: 'OPEN' as const };
    const open = await tx.monitoringIssue.findFirst({ where: key });
    const action = issueDecision(Boolean(open), check.status);
    const projectId = targetType === 'MAILBOX' ? (await tx.mailbox.findUnique({ where: { id: targetId }, select: { projectId: true } }))?.projectId
      : targetType === 'DOMAIN' ? (await tx.domain.findUnique({ where: { id: targetId }, select: { projectId: true } }))?.projectId : null;
    if (action === 'RESOLVE' && open) {
      await tx.monitoringIssue.update({ where: { id: open.id }, data: { status: 'RESOLVED', resolvedAt: now, lastHealthyAt: now } });
      if (projectId) await emitWebhookEvent(tx, { projectId, eventKey: `monitoring.issue_resolved:${open.id}`, type: 'monitoring.issue_resolved', resourceType: 'MonitoringIssue', resourceId: open.id, payload: { issueId: open.id, targetType, targetId, checkType, severity: open.severity, timestamp: now.toISOString() } });
    } else if (action === 'UPDATE' && open) {
      await tx.monitoringIssue.update({ where: { id: open.id }, data: { severity: check.status, summary: check.summary.slice(0, 500), errorCode: check.errorCode, targetName, lastDetectedAt: now } });
    } else if (action === 'CREATE') {
      const priorHealthy = await tx.monitoringResult.findFirst({ where: { targetType, targetId, checkType, status: 'HEALTHY', checkedAt: { lt: now } }, orderBy: { checkedAt: 'desc' }, select: { checkedAt: true } });
      const issue = await tx.monitoringIssue.create({ data: { targetType, targetId, targetName, checkType, severity: check.status, summary: check.summary.slice(0, 500), errorCode: check.errorCode, firstDetectedAt: now, lastDetectedAt: now, lastHealthyAt: priorHealthy?.checkedAt } });
      if (projectId) await emitWebhookEvent(tx, { projectId, eventKey: `monitoring.issue_opened:${issue.id}`, type: 'monitoring.issue_opened', resourceType: 'MonitoringIssue', resourceId: issue.id, payload: { issueId: issue.id, targetType, targetId, checkType, severity: check.status, errorCode: check.errorCode, timestamp: now.toISOString() } });
    }
  });
}

export async function processMonitoringRun(db: PrismaClient, redis: Redis, config: Config, key: Buffer, runId: string, queues: Record<string, Queue>) {
  const claim = await db.monitoringRun.updateMany({ where: { id: runId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
  if (!claim.count) return;
  const lease = await redis.set('monitor:run:lease', runId, 'EX', 90, 'NX');
  if (lease !== 'OK') {
    await db.monitoringRun.update({ where: { id: runId }, data: { status: 'FAILED', completedAt: new Date(), errorCode: 'MONITORING_OVERLAP' } });
    return;
  }
  const renew = setInterval(() => { void redis.get('monitor:run:lease').then(value => value === runId ? redis.expire('monitor:run:lease', 90) : undefined).catch(() => undefined); }, 20000);
  let resultCount = 0;
  let partial = false;
  const put = async (type: string, id: string, name: string, checkType: string, check: Check) => {
    await record(db, runId, type, id, name, checkType, check);
    resultCount++;
    if (check.errorCode === 'DNS_LOOKUP_FAILED') partial = true;
  };
  try {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600000);
    const [outgoingGroups, stuckGroups] = await Promise.all([
      db.outgoingMessage.groupBy({ by: ['fromMailboxId', 'status'], where: { createdAt: { gte: hourAgo } }, _count: { _all: true } }),
      db.outgoingMessage.groupBy({ by: ['fromMailboxId'], where: { status: 'PROCESSING', processingAt: { lt: new Date(now.getTime() - 120000) } }, _count: { _all: true } }),
    ]);
    const mailboxes = await db.mailbox.findMany({ include: { credential: true, mailServer: true, syncRuns: { orderBy: { startedAt: 'desc' }, take: 1 }, cpanelDiscoveries: { where: { state: 'MANAGED' }, orderBy: { lastSeenAt: 'desc' }, take: 1 } }, orderBy: { id: 'asc' } });
    for (const mailbox of mailboxes) {
      const name = mailbox.email;
      if (!mailbox.isActive || mailbox.status === 'DISABLED' || mailbox.mailServer?.status === 'DISABLED') {
        await put('MAILBOX', mailbox.id, name, 'STATE', { status: 'UNKNOWN', summary: 'Mailbox or mail server is disabled.', errorCode: null });
        await put('MAILBOX', mailbox.id, name, 'OVERALL', { status: 'UNKNOWN', summary: 'Mailbox or mail server is disabled.', errorCode: null });
        continue;
      }
      const server = mailbox.mailServer;
      const mailboxChecks: Check[] = [];
      for (const protocol of ['IMAP', 'SMTP'] as const) {
        const endpoint = protocol === 'IMAP'
          ? server?.imapHost && server.imapPort ? { host: server.imapHost, port: server.imapPort, security: server.imapSecurity } : null
          : server?.smtpHost && server.smtpPort ? { host: server.smtpHost, port: server.smtpPort, security: server.smtpSecurity } : null;
        const needsCredential = protocol === 'IMAP' || server?.smtpAuthMode === 'PASSWORD';
        let check: Check;
        if (!endpoint) check = { status: 'UNKNOWN', summary: `${protocol} endpoint is not configured.`, errorCode: null };
        else if (needsCredential && !mailbox.credential) check = connectionHealth(null, mailbox.connectionConfigVersion, protocol, false);
        else {
          let password: string | null = null;
          try { if (needsCredential) password = decryptSecret(mailbox.credential!, key); }
          catch { check = { status: 'CRITICAL', summary: 'Stored mailbox credential cannot be decrypted.', errorCode: 'CREDENTIAL_DECRYPTION_FAILED' }; }
          if (!check!) {
            const tested = protocol === 'IMAP'
              ? await testImap(endpoint, mailbox.credential!.username, password!)
              : await testSmtp(endpoint, needsCredential ? { user: mailbox.credential!.username, pass: password! } : null);
            check = tested.status === 'SUCCESS'
              ? { status: 'HEALTHY', summary: `${protocol} connection succeeded.`, errorCode: null, latencyMs: tested.latencyMs }
              : { status: 'CRITICAL', summary: tested.message, errorCode: tested.errorCode, latencyMs: tested.latencyMs };
          }
        }
        await put('MAILBOX', mailbox.id, name, protocol, check!);
        mailboxChecks.push(check!);
      }
      const sync = syncHealth(mailbox.syncRuns[0] ?? null, now, config.MONITOR_SYNC_WARNING_MINUTES, config.MONITOR_SYNC_CRITICAL_MINUTES, config.MAIL_SYNC_INTERVAL_MINUTES);
      mailboxChecks.push(sync);
      await put('MAILBOX', mailbox.id, name, 'SYNC', sync);
      const quota = mailbox.cpanelDiscoveries[0];
      const quotaFresh = !!quota && now.getTime() - quota.lastSeenAt.getTime() <= config.MONITOR_QUOTA_MAX_AGE_HOURS * 3600000;
      const quotaCheck: Check = quota && !quotaFresh ? { status: 'UNKNOWN', summary: 'cPanel quota data is stale; run discovery to refresh it.', errorCode: 'MAILBOX_QUOTA_STALE' }
        : quotaHealth(quota ? { usedBytes: quota.usedBytes, quotaBytes: quota.quotaBytes, unlimitedQuota: quota.unlimitedQuota } : null, config.MONITOR_QUOTA_WARNING_PERCENT, config.MONITOR_QUOTA_CRITICAL_PERCENT);
      if (quotaCheck.status !== 'UNKNOWN') mailboxChecks.push(quotaCheck);
      await put('MAILBOX', mailbox.id, name, 'QUOTA', quotaCheck);
      const cpanelState: Check = !quota || !quotaFresh || quota.suspended === null ? { status: 'UNKNOWN', summary: 'Current cPanel mailbox suspension state is unavailable.', errorCode: null }
        : quota.suspended ? { status: 'CRITICAL', summary: 'cPanel reports the mailbox as suspended.', errorCode: 'MAILBOX_SUSPENDED' }
          : { status: 'HEALTHY', summary: 'cPanel reports the mailbox as active.', errorCode: null };
      if (cpanelState.status !== 'UNKNOWN') mailboxChecks.push(cpanelState);
      await put('MAILBOX', mailbox.id, name, 'CPANEL_STATE', cpanelState);
      await put('MAILBOX', mailbox.id, name, 'OVERALL', { status: overall(mailboxChecks), summary: 'Combined mailbox connection, sync, and available quota status.', errorCode: null });
      const count = (status: string) => outgoingGroups.find(group => group.fromMailboxId === mailbox.id && group.status === status)?._count._all ?? 0;
      const failures = count('FAILED'); const retries = count('RETRY_SCHEDULED'); const accepted = count('SMTP_ACCEPTED') + count('SMTP_ACCEPTED_WITH_REJECTIONS');
      const stuck = stuckGroups.find(group => group.fromMailboxId === mailbox.id)?._count._all ?? 0;
      const outgoing: Check = stuck || failures >= 3 ? { status: 'CRITICAL', summary: `${failures} failed and ${stuck} stuck messages for this mailbox.`, errorCode: stuck ? 'OUTGOING_PROCESSING_STUCK' : 'OUTGOING_REPEATED_FAILURES' }
        : failures || retries >= 5 ? { status: 'WARNING', summary: `${failures} failed and ${retries} retrying messages for this mailbox.`, errorCode: 'OUTGOING_FAILURES' }
        : accepted ? { status: 'HEALTHY', summary: `${accepted} messages accepted by SMTP; final delivery is unconfirmed.`, errorCode: null }
        : { status: 'UNKNOWN', summary: 'No recent outgoing SMTP acceptance evidence.', errorCode: null };
      await put('MAILBOX', mailbox.id, name, 'OUTGOING', outgoing);
    }

    const servers = await db.mailServer.findMany({ orderBy: { id: 'asc' } });
    for (const server of servers) {
      const checks: Check[] = [];
      for (const protocol of ['IMAP', 'SMTP'] as const) {
        const host = protocol === 'IMAP' ? server.imapHost : server.smtpHost;
        const port = protocol === 'IMAP' ? server.imapPort : server.smtpPort;
        const security = protocol === 'IMAP' ? server.imapSecurity : server.smtpSecurity;
        if (!host || !port || server.status !== 'ACTIVE') continue;
        const result = await inspectMailTls(host, port, protocol, security, now, config.MONITOR_TLS_WARNING_DAYS);
        checks.push(result);
        await put('MAIL_SERVER', server.id, server.name, `${protocol}_TLS`, result);
      }
      await put('MAIL_SERVER', server.id, server.name, 'OVERALL', { status: checks.length ? overall(checks) : 'UNKNOWN', summary: checks.length ? 'Combined configured TLS endpoint status.' : 'No active TLS endpoints configured.', errorCode: null });
    }

    const domains = await db.domain.findMany({ where: { status: { not: 'DISABLED' } }, orderBy: { id: 'asc' } });
    for (const domain of domains) {
      const checks = await domainChecks(domain.domain, domain.dkimSelectors);
      for (const [type, check] of Object.entries(checks)) await put('DOMAIN', domain.id, domain.domain, type, check);
      await put('DOMAIN', domain.id, domain.domain, 'OVERALL', { status: overall(Object.values(checks)), summary: 'Combined deliverability DNS status.', errorCode: null });
    }

    try {
      await redis.ping();
      await put('SYSTEM', 'redis', 'Redis', 'CONNECTIVITY', { status: 'HEALTHY', summary: 'Redis responded to PING.', errorCode: null });
    } catch { await put('SYSTEM', 'redis', 'Redis', 'CONNECTIVITY', { status: 'CRITICAL', summary: 'Redis is unavailable.', errorCode: 'REDIS_UNAVAILABLE' }); }
    const heartbeat = await redis.get('monitor:worker:last');
    let lastHeartbeatAt: Date | null = null;
    try { const value = JSON.parse(heartbeat ?? '{}') as { lastHeartbeatAt?: string }; if (value.lastHeartbeatAt) lastHeartbeatAt = new Date(value.lastHeartbeatAt); } catch { /* expired or invalid heartbeat */ }
    await put('WORKER', 'mail-worker', 'Mail worker', 'HEARTBEAT', heartbeatHealth(lastHeartbeatAt, now, config.MONITOR_WORKER_HEARTBEAT_SECONDS));
    for (const [name, queue] of Object.entries(queues)) {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        await put('QUEUE', name, name, 'QUEUE_STATE', queueHealth({ waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0 }, config.MONITOR_QUEUE_BACKLOG_WARNING));
      } catch { await put('QUEUE', name, name, 'QUEUE_STATE', { status: 'CRITICAL', summary: 'Queue counts could not be read.', errorCode: 'QUEUE_UNAVAILABLE' }); }
    }

    const [failed, retrying, stuck, queued, accepted] = await Promise.all([
      db.outgoingMessage.count({ where: { status: 'FAILED', failedAt: { gte: hourAgo } } }),
      db.outgoingMessage.count({ where: { status: 'RETRY_SCHEDULED', createdAt: { gte: hourAgo } } }),
      db.outgoingMessage.count({ where: { status: 'PROCESSING', processingAt: { lt: new Date(now.getTime() - 120000) } } }),
      db.outgoingMessage.count({ where: { status: 'QUEUED' } }),
      db.outgoingMessage.count({ where: { status: { in: ['SMTP_ACCEPTED', 'SMTP_ACCEPTED_WITH_REJECTIONS'] }, smtpAcceptedAt: { gte: hourAgo } } }),
    ]);
    const outgoing: Check = stuck > 0 || failed >= 3 ? { status: 'CRITICAL', summary: `${failed} failed and ${stuck} stuck messages in the last hour.`, errorCode: stuck ? 'OUTGOING_PROCESSING_STUCK' : 'OUTGOING_REPEATED_FAILURES' }
      : retrying >= 10 || queued >= config.MONITOR_QUEUE_BACKLOG_WARNING || failed > 0 ? { status: 'WARNING', summary: `${failed} failed, ${retrying} retrying, ${queued} queued.`, errorCode: queued >= config.MONITOR_QUEUE_BACKLOG_WARNING ? 'QUEUE_BACKLOG' : 'OUTGOING_FAILURES' }
      : accepted > 0 ? { status: 'HEALTHY', summary: `${accepted} messages accepted by SMTP in the last hour; final delivery is unconfirmed.`, errorCode: null }
      : { status: 'UNKNOWN', summary: 'No recent SMTP acceptance evidence.', errorCode: null };
    await put('SYSTEM', 'outgoing', 'Outgoing mail', 'DELIVERY_PIPELINE', { ...outgoing, details: { failed, retrying, stuck, queued, smtpAccepted: accepted } });
    const currentTargets: Record<string, Set<string>> = { MAILBOX: new Set(mailboxes.filter(item => item.isActive && item.status !== 'DISABLED' && item.mailServer?.status !== 'DISABLED').map(item => item.id)), MAIL_SERVER: new Set(servers.filter(item => item.status === 'ACTIVE').map(item => item.id)), DOMAIN: new Set(domains.map(item => item.id)) };
    const orphaned = await db.monitoringIssue.findMany({ where: { status: 'OPEN', targetType: { in: Object.keys(currentTargets) } }, select: { id: true, targetType: true, targetId: true } });
    for (const issue of orphaned) if (!currentTargets[issue.targetType]?.has(issue.targetId)) await db.monitoringIssue.update({ where: { id: issue.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    const issueCount = await db.monitoringIssue.count({ where: { status: 'OPEN' } });
    await db.monitoringRun.update({ where: { id: runId }, data: { status: partial ? 'PARTIAL' : 'SUCCESS', completedAt: new Date(), resultCount, issueCount } });
  } catch (error) {
    await db.monitoringRun.update({ where: { id: runId }, data: { status: 'FAILED', completedAt: new Date(), resultCount, errorCode: error instanceof Error ? error.name.slice(0, 80) : 'MONITORING_FAILED' } });
    throw error;
  } finally {
    clearInterval(renew);
    if (await redis.get('monitor:run:lease').catch(() => null) === runId) await redis.del('monitor:run:lease').catch(() => undefined);
  }
}
