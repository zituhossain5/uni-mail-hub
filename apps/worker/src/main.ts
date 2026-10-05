import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { PrismaClient } from '@uni/database';
import { readConfig } from '@uni/config';
import { decodeEncryptionKey, decryptSecret } from '@uni/security';
import { classifySendError, sendSmtp } from '@uni/mail';
import { queueNames } from '@uni/shared';
import { processMailboxSync } from './imap-sync';
import { withMailboxSyncLease } from './sync-lease';

const config = readConfig();
const key = decodeEncryptionKey(config.MAIL_CREDENTIAL_ENCRYPTION_KEY);
const log = pino({ name: 'uni-mail-worker', redact: ['password', 'rawKey', 'authorization', 'credential'] });
const db = new PrismaClient();
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
const queue = new Queue('mail-send', { connection });
const syncQueue = new Queue('mail-sync', { connection });
const workers: Worker[] = [];
let timer: NodeJS.Timeout | undefined;
let syncTimer: NodeJS.Timeout | undefined;
let dispatching = false;
let syncScheduleTask: Promise<void> | null = null;

async function scheduleSync() {
  try {
    let cursor: string | undefined;
    for (;;) {
      const mailboxes = await db.mailbox.findMany({
        where: { isActive: true, status: { not: 'DISABLED' }, credential: { isNot: null }, mailServer: { is: { status: 'ACTIVE', imapHost: { not: null }, imapPort: { not: null } } } },
        select: { id: true }, orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const mailbox of mailboxes) await syncQueue.add('sync', { mailboxId: mailbox.id }, { jobId: `sync-${mailbox.id}`, attempts: 4, backoff: { type: 'exponential', delay: 30000 }, removeOnComplete: true, removeOnFail: true });
      if (mailboxes.length < 100) break;
      cursor = mailboxes.at(-1)?.id;
    }
  } catch (error) { log.warn({ errorType: error instanceof Error ? error.name : typeof error }, 'mail sync scheduling deferred'); }
}

function triggerSyncSchedule() {
  if (syncScheduleTask) return syncScheduleTask;
  syncScheduleTask = scheduleSync().finally(() => { syncScheduleTask = null; });
  return syncScheduleTask;
}

async function recoverSyncRuns() {
  let cursor: string | undefined;
  for (;;) {
    const runs = await db.mailSyncRun.findMany({ where: { status: 'RUNNING', ...(cursor ? { id: { gt: cursor } } : {}) }, select: { id: true, mailboxId: true }, orderBy: { id: 'asc' }, take: 100 });
    for (const run of runs) {
      if (await connection.exists(`mail-sync:lease:${run.mailboxId}`)) continue;
      await db.mailSyncRun.updateMany({ where: { id: run.id, status: 'RUNNING' }, data: { status: 'FAILED', completedAt: new Date(), errorCode: 'SYNC_INTERRUPTED', errorMessage: 'Synchronization was interrupted before completion.' } });
    }
    if (runs.length < 100) break;
    cursor = runs.at(-1)?.id;
  }
}

async function processSyncJob(mailboxId: string) {
  const claimed = await withMailboxSyncLease(connection, mailboxId, signal => processMailboxSync(db, config, key, log, mailboxId, signal));
  if (!claimed) log.info({ mailboxId }, 'overlapping mailbox sync skipped');
}

async function dispatchOutbox() {
  if (dispatching) return;
  dispatching = true;
  try {
    const events = await db.outboxEvent.findMany({ where: { status: 'READY', availableAt: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: 50 });
    for (const event of events) {
      await queue.add('send', { messageId: event.messageId }, { jobId: event.id, removeOnComplete: { age: 86400, count: 10000 }, removeOnFail: { age: 86400, count: 10000 } });
      await db.outboxEvent.updateMany({ where: { id: event.id, status: 'READY' }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
    }
  } catch (error) { log.warn({ errorType: error instanceof Error ? error.name : typeof error }, 'outbox dispatch deferred'); }
  finally { dispatching = false; }
}

async function recoverStale() {
  const staleBefore = new Date(Date.now() - 120000);
  const stale = await db.outgoingMessage.findMany({ where: { status: 'PROCESSING', processingAt: { lt: staleBefore } }, select: { id: true }, take: 50 });
  for (const item of stale) await db.$transaction(async tx => {
    const changed = await tx.outgoingMessage.updateMany({ where: { id: item.id, status: 'PROCESSING', processingAt: { lt: staleBefore } }, data: { status: 'RETRY_SCHEDULED', lastErrorCode: 'PROCESSING_INTERRUPTED', lastErrorMessage: 'Worker interrupted before confirming SMTP result.' } });
    if (changed.count) await tx.outboxEvent.create({ data: { messageId: item.id } });
  });
}

async function processMessage(messageId: string) {
  const claimed = await db.outgoingMessage.updateMany({ where: { id: messageId, status: { in: ['QUEUED', 'RETRY_SCHEDULED'] } }, data: { status: 'PROCESSING', processingAt: new Date(), attemptCount: { increment: 1 } } });
  if (!claimed.count) return;
  const message = await db.outgoingMessage.findUniqueOrThrow({ where: { id: messageId }, include: { recipients: true, fromMailbox: { include: { mailServer: true, credential: true } } } });
  const startedAt = new Date();
  const mailbox = message.fromMailbox;
  let accepted: string[] = []; let rejected: string[] = []; let pending: string[] = [];
  let rfcMessageId: string | null = null; let responseCode: number | null = null;
  let failure: ReturnType<typeof classifySendError> | null = null;
  try {
    const server = mailbox.mailServer;
    if (!mailbox.isActive || mailbox.status === 'DISABLED') throw { code: 'MAILBOX_DISABLED' };
    if (!server || !server.smtpHost || !server.smtpPort || server.status !== 'ACTIVE') throw { code: 'MAIL_SERVER_DISABLED' };
    if (config.NODE_ENV === 'production' && server.smtpSecurity === 'NONE') throw { code: 'INSECURE_MAIL_SERVER' };
    if (server.smtpAuthMode === 'PASSWORD' && !mailbox.credential) throw { code: 'MAIL_CREDENTIAL_NOT_CONFIGURED' };
    const auth = server.smtpAuthMode === 'PASSWORD' ? { user: mailbox.credential!.username, pass: decryptSecret(mailbox.credential!, key) } : null;
    const recipients = (type: 'TO' | 'CC' | 'BCC') => message.recipients.filter(item => item.type === type).map(item => ({ email: item.email, name: item.name }));
    const result = await sendSmtp({ endpoint: { host: server.smtpHost, port: server.smtpPort, security: server.smtpSecurity }, auth, from: { email: mailbox.email, name: mailbox.displayName }, to: recipients('TO'), cc: recipients('CC'), bcc: recipients('BCC'), replyTo: message.replyToEmail ? { email: message.replyToEmail, name: message.replyToName } : null, subject: message.subject, text: message.textBody, html: message.htmlBody });
    accepted = result.accepted; rejected = result.rejected; pending = result.pending; rfcMessageId = result.messageId; responseCode = result.responseCode;
    if (!accepted.length) throw { code: 'SMTP_RECIPIENT_REJECTED', responseCode: responseCode ?? 550 };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (['MAILBOX_DISABLED', 'MAIL_SERVER_DISABLED', 'INSECURE_MAIL_SERVER', 'MAIL_CREDENTIAL_NOT_CONFIGURED', 'CREDENTIAL_DECRYPTION_FAILED'].includes(code ?? '') || (error instanceof Error && error.message === 'CREDENTIAL_DECRYPTION_FAILED')) {
      const safe = code ?? 'CREDENTIAL_DECRYPTION_FAILED'; failure = { code: safe, message: safe.replaceAll('_', ' ').toLowerCase(), retryable: false, smtpResponseCode: null };
    } else failure = classifySendError(error);
  }
  const finishedAt = new Date();
  const latencyMs = finishedAt.getTime() - startedAt.getTime();
  await db.$transaction(async tx => {
    if (failure) {
      const retry = failure.retryable && message.attemptCount < config.MAIL_SEND_MAX_ATTEMPTS;
      await tx.smtpAttempt.create({ data: { messageId, mailboxId: mailbox.id, attemptNumber: message.attemptCount, status: 'FAILED', startedAt, finishedAt, latencyMs, smtpResponseCode: failure.smtpResponseCode, smtpResponse: failure.smtpResponseCode ? `SMTP ${failure.smtpResponseCode}` : null, errorCode: failure.code, errorMessage: failure.message } });
      if (failure.code === 'SMTP_RECIPIENT_REJECTED') await tx.outgoingRecipient.updateMany({ where: { messageId }, data: { smtpStatus: 'REJECTED', smtpResponse: failure.message } });
      await tx.outgoingMessage.update({ where: { id: messageId }, data: { status: retry ? 'RETRY_SCHEDULED' : 'FAILED', lastErrorCode: failure.code, lastErrorMessage: failure.message, failedAt: retry ? null : finishedAt } });
      if (retry) await tx.outboxEvent.create({ data: { messageId, availableAt: new Date(Date.now() + config.MAIL_SEND_BACKOFF_BASE_MS * 2 ** (message.attemptCount - 1)) } });
    } else {
      const acceptedSet = new Set(accepted);
      const rejectedSet = new Set([...rejected, ...pending, ...message.recipients.filter(item => !acceptedSet.has(item.email.toLowerCase())).map(item => item.email.toLowerCase())]);
      const partial = rejectedSet.size > 0;
      await tx.smtpAttempt.create({ data: { messageId, mailboxId: mailbox.id, attemptNumber: message.attemptCount, status: partial ? 'PARTIAL' : 'ACCEPTED', startedAt, finishedAt, latencyMs, smtpResponseCode: responseCode, smtpResponse: responseCode ? `SMTP ${responseCode}` : 'SMTP accepted', messageIdHeader: rfcMessageId } });
      for (const recipient of message.recipients) await tx.outgoingRecipient.update({ where: { id: recipient.id }, data: { smtpStatus: rejectedSet.has(recipient.email.toLowerCase()) ? 'REJECTED' : 'ACCEPTED', smtpResponse: rejectedSet.has(recipient.email.toLowerCase()) ? 'Rejected by SMTP server' : 'Accepted by SMTP server' } });
      await tx.outgoingMessage.update({ where: { id: messageId }, data: { status: partial ? 'SMTP_ACCEPTED_WITH_REJECTIONS' : 'SMTP_ACCEPTED', smtpAcceptedAt: finishedAt, rfcMessageId, lastErrorCode: partial ? 'PARTIAL_RECIPIENT_REJECTION' : null, lastErrorMessage: partial ? 'Some recipients were rejected by SMTP; accepted recipients will not be resent.' : null } });
    }
  });
  log.info({ messageId, status: failure ? failure.retryable && message.attemptCount < config.MAIL_SEND_MAX_ATTEMPTS ? 'RETRY_SCHEDULED' : 'FAILED' : rejected.length || pending.length ? 'SMTP_ACCEPTED_WITH_REJECTIONS' : 'SMTP_ACCEPTED', errorCode: failure?.code }, 'mail send processed');
}

let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  if (timer) clearInterval(timer);
  if (syncTimer) clearInterval(syncTimer);
  if (syncScheduleTask) await syncScheduleTask;
  await Promise.all(workers.map(worker => worker.close()));
  await queue.close(); await syncQueue.close(); await connection.quit(); await db.$disconnect();
  log.info('worker stopped'); process.exit(0);
}

async function main() {
  await db.$connect(); await connection.ping();
  for (const name of queueNames) {
    const worker = new Worker(name, async job => {
      if (name === 'mail-send') return processMessage(String(job.data.messageId));
      if (name === 'mail-sync') return processSyncJob(String(job.data.mailboxId));
      throw new Error(`Processor for ${job.queueName} is not implemented`);
    }, { connection, concurrency: name === 'mail-send' ? config.MAIL_SEND_WORKER_CONCURRENCY : name === 'mail-sync' ? config.MAIL_SYNC_WORKER_CONCURRENCY : 1 });
    worker.on('failed', (job, error) => log.error({ queue: name, jobId: job?.id, errorType: error.name }, 'job failed'));
    worker.on('error', error => log.error({ queue: name, errorType: error.name }, 'worker error'));
    workers.push(worker);
  }
  await recoverStale(); await dispatchOutbox();
  await recoverSyncRuns();
  await triggerSyncSchedule();
  timer = setInterval(() => { void recoverStale().then(dispatchOutbox).catch(error => log.warn({ errorType: error instanceof Error ? error.name : typeof error }, 'reconciliation deferred')); }, 5000);
  syncTimer = setInterval(() => { void triggerSyncSchedule(); }, config.MAIL_SYNC_INTERVAL_MINUTES * 60000);
  log.info({ queues: queueNames, concurrency: config.MAIL_SEND_WORKER_CONCURRENCY }, 'worker ready');
}
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
main().catch(error => { log.error({ errorType: error instanceof Error ? error.name : typeof error }, 'worker startup failed'); process.exit(1); });
