import { PrismaClient } from '@uni/database';

export const preSmtpMarker = 'PRE_SMTP_DISPATCH';
export const smtpPendingMarker = 'SMTP_OUTCOME_PENDING';

export async function recoverStaleOutgoing(db: PrismaClient, staleSeconds: number, now = new Date()) {
  const staleBefore = new Date(now.getTime() - staleSeconds * 1000);
  const stale = await db.outgoingMessage.findMany({
    where: { status: 'PROCESSING', processingAt: { lt: staleBefore } },
    select: { id: true }, orderBy: { processingAt: 'asc' }, take: 50,
  });
  const result = { requeued: 0, accepted: 0, uncertain: 0 };
  for (const item of stale) await db.$transaction(async tx => {
    const message = await tx.outgoingMessage.findUnique({ where: { id: item.id }, select: { status: true, processingAt: true, lastErrorCode: true, attemptCount: true, smtpAcceptedAt: true } });
    if (!message || message.status !== 'PROCESSING' || !message.processingAt || message.processingAt >= staleBefore) return;
    const accepted = await tx.smtpAttempt.findFirst({ where: { messageId: item.id, status: { in: ['ACCEPTED', 'PARTIAL'] } }, orderBy: { finishedAt: 'desc' }, select: { status: true, finishedAt: true } });
    const where = { id: item.id, status: 'PROCESSING' as const, processingAt: { lt: staleBefore }, attemptCount: message.attemptCount };
    if (accepted || message.smtpAcceptedAt) {
      const partial = accepted?.status === 'PARTIAL';
      const changed = await tx.outgoingMessage.updateMany({ where, data: { status: partial ? 'SMTP_ACCEPTED_WITH_REJECTIONS' : 'SMTP_ACCEPTED', smtpAcceptedAt: message.smtpAcceptedAt ?? accepted?.finishedAt ?? now, processingAt: null, failedAt: null, lastErrorCode: partial ? 'PARTIAL_RECIPIENT_REJECTION' : null, lastErrorMessage: partial ? 'Some recipients were rejected by SMTP; accepted recipients will not be resent.' : null } });
      result.accepted += changed.count;
    } else if (message.lastErrorCode === preSmtpMarker) {
      const changed = await tx.outgoingMessage.updateMany({ where: { ...where, lastErrorCode: preSmtpMarker }, data: { status: 'RETRY_SCHEDULED', processingAt: null, attemptCount: { decrement: 1 }, lastErrorCode: 'PROCESSING_INTERRUPTED', lastErrorMessage: 'Worker stopped before SMTP dispatch; message safely requeued.' } });
      if (changed.count) { await tx.outboxEvent.create({ data: { messageId: item.id } }); result.requeued++; }
    } else {
      const changed = await tx.outgoingMessage.updateMany({ where, data: { status: 'FAILED', processingAt: null, failedAt: now, lastErrorCode: 'SMTP_OUTCOME_UNKNOWN', lastErrorMessage: 'SMTP outcome could not be confirmed. Review the mail server before resending.' } });
      result.uncertain += changed.count;
    }
  });
  return result;
}

export function safeSmtpFailure<T extends { code: string; message: string; retryable: boolean; smtpResponseCode: number | null }>(failure: T, smtpInvoked: boolean): T {
  if (smtpInvoked && ['SMTP_TIMEOUT', 'SMTP_CONNECTION_FAILED'].includes(failure.code)) {
    return { ...failure, code: 'SMTP_OUTCOME_UNKNOWN', message: 'SMTP outcome could not be confirmed. Review the mail server before resending.', retryable: false };
  }
  return failure;
}
