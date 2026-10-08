import { Prisma } from '@uni/database';
import type { DsnEvidence } from '@uni/mail';
import { emitWebhookEvent } from './webhook-events';

export async function recordDsn(tx: Prisma.TransactionClient, projectId: string, sourceMessageId: string, dsn: DsnEvidence) {
  const candidates = dsn.originalMessageId && dsn.recipientEmail ? await tx.outgoingMessage.findMany({ where: { projectId, rfcMessageId: { in: [dsn.originalMessageId, `<${dsn.originalMessageId}>`], mode: 'insensitive' }, recipients: { some: { email: { equals: dsn.recipientEmail, mode: 'insensitive' }, smtpStatus: { in: ['ACCEPTED', 'BOUNCED'] } } } }, select: { id: true }, take: 2 }) : [];
  const matchedId = candidates.length === 1 ? candidates[0]!.id : null;
  const bounce = await tx.mailBounce.create({ data: { projectId, sourceMessageId, outgoingMessageId: matchedId, recipientEmail: dsn.recipientEmail, originalMessageId: dsn.originalMessageId, action: dsn.action, statusCode: dsn.statusCode, classification: dsn.classification, correlationCode: matchedId ? 'MATCHED' : 'BOUNCE_UNMATCHED' } });
  if (matchedId && dsn.classification === 'HARD_BOUNCE' && dsn.recipientEmail) {
    await tx.outgoingRecipient.updateMany({ where: { messageId: matchedId, email: { equals: dsn.recipientEmail, mode: 'insensitive' }, smtpStatus: 'ACCEPTED' }, data: { smtpStatus: 'BOUNCED', smtpResponse: `DSN ${dsn.statusCode}` } });
    await tx.suppression.upsert({ where: { projectId_email: { projectId, email: dsn.recipientEmail } }, create: { projectId, email: dsn.recipientEmail, reason: 'HARD_BOUNCE', source: 'DSN', lastFailureAt: new Date() }, update: { lastFailureAt: new Date() } });
  }
  await emitWebhookEvent(tx, { projectId, eventKey: `mail.bounced:${bounce.id}`, type: 'mail.bounced', resourceType: 'MailBounce', resourceId: bounce.id, payload: { bounceId: bounce.id, sourceMessageId, outgoingMessageId: matchedId, recipientEmail: dsn.recipientEmail, classification: dsn.classification, statusCode: dsn.statusCode, correlationCode: bounce.correlationCode, timestamp: bounce.createdAt.toISOString() } });
  return bounce;
}
