import { Queue } from 'bullmq';
import { PrismaClient } from '@uni/database';
import { decryptSecret } from '@uni/security';
import { postWebhook } from '@uni/mail';
import type { readConfig } from '@uni/config';

type Config = ReturnType<typeof readConfig>;
const backoff = [60, 300, 900, 3600];

export function deliveryDecision(status: number, attempt: number, maxAttempts: number, retryAfter: number | null = null) {
  if (status >= 200 && status < 300) return { status: 'DELIVERED' as const, delaySeconds: null };
  const transient = status === 0 || status === 408 || status === 429 || status >= 500;
  if (!transient || attempt >= maxAttempts) return { status: 'FAILED' as const, delaySeconds: null };
  const seconds = backoff[Math.min(attempt - 1, backoff.length - 1)]!;
  return { status: 'RETRY_SCHEDULED' as const, delaySeconds: retryAfter === null ? seconds : Math.max(seconds, retryAfter) };
}

export async function dispatchWebhookDeliveries(db: PrismaClient, queue: Queue, staleSeconds = 120) {
  const stale = new Date(Date.now() - staleSeconds * 1000);
  await db.webhookDelivery.updateMany({ where: { status: 'DELIVERING', lastAttemptAt: { lt: stale } }, data: { status: 'RETRY_SCHEDULED', nextAttemptAt: new Date(), errorCode: 'WEBHOOK_DELIVERY_INTERRUPTED', errorMessage: 'Delivery interrupted; retry scheduled.' } });
  const due = await db.webhookDelivery.findMany({ where: { status: { in: ['PENDING', 'RETRY_SCHEDULED'] }, nextAttemptAt: { lte: new Date() } }, select: { id: true, attemptCount: true }, orderBy: { createdAt: 'asc' }, take: 50 });
  for (const item of due) await queue.add('deliver', { deliveryId: item.id }, { jobId: `${item.id}-${item.attemptCount + 1}`, removeOnComplete: { age: 86400, count: 10000 }, removeOnFail: { age: 86400, count: 10000 } });
}

export async function processWebhookDelivery(db: PrismaClient, config: Config, key: Buffer, deliveryId: string) {
  const now = new Date();
  const claimed = await db.webhookDelivery.updateMany({ where: { id: deliveryId, status: { in: ['PENDING', 'RETRY_SCHEDULED'] }, nextAttemptAt: { lte: now } }, data: { status: 'DELIVERING', attemptCount: { increment: 1 }, lastAttemptAt: now } });
  if (!claimed.count) return;
  const item = await db.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { event: true, endpoint: true } });
  if (!item.firstAttemptAt) await db.webhookDelivery.update({ where: { id: item.id }, data: { firstAttemptAt: now } });
  if (item.endpoint.status !== 'ACTIVE' || item.endpoint.projectId !== item.event.projectId || !(item.endpoint.subscriptions.includes(item.event.type) || item.event.type === 'webhook.test' && item.event.resourceId === item.endpoint.id)) {
    await db.webhookDelivery.update({ where: { id: item.id }, data: { status: 'FAILED', errorCode: 'WEBHOOK_ENDPOINT_DISABLED', errorMessage: 'Endpoint is disabled or no longer subscribed.' } });
    return;
  }
  let status = 0; let retryAfter: number | null = null; let durationMs = 0; let errorCode: string | null = null;
  try {
    const secret = decryptSecret({ encryptedPassword: item.endpoint.encryptedSecret, encryptionIv: item.endpoint.encryptionIv, encryptionAuthTag: item.endpoint.encryptionAuthTag, encryptionVersion: item.endpoint.encryptionVersion }, key);
    const result = await postWebhook(item.endpoint.url, item.event.type, item.event.id, JSON.stringify(item.event.payload), secret, config.WEBHOOK_TIMEOUT_MS, config.WEBHOOK_RESPONSE_MAX_BYTES);
    status = result.status; retryAfter = result.retryAfterSeconds; durationMs = result.durationMs;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const nodeCode = String((error as { code?: unknown })?.code ?? '');
    errorCode = ['WEBHOOK_ENDPOINT_INVALID', 'WEBHOOK_RESPONSE_TOO_LARGE', 'WEBHOOK_DELIVERY_TIMEOUT'].includes(code) ? code
      : code === 'CREDENTIAL_DECRYPTION_FAILED' ? 'WEBHOOK_SECRET_INVALID'
        : ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(nodeCode) ? 'WEBHOOK_ENDPOINT_INVALID'
          : 'WEBHOOK_DELIVERY_FAILED';
  }
  const decision = errorCode === 'WEBHOOK_ENDPOINT_INVALID' || errorCode === 'WEBHOOK_SECRET_INVALID' || errorCode === 'WEBHOOK_RESPONSE_TOO_LARGE'
    ? { status: 'FAILED' as const, delaySeconds: null }
    : deliveryDecision(status, item.attemptCount, config.WEBHOOK_MAX_ATTEMPTS, retryAfter);
  await db.$transaction(async tx => {
    await tx.webhookDelivery.update({ where: { id: item.id }, data: {
      status: decision.status, httpStatus: status || null, responseSnippet: status ? `HTTP ${status}` : null,
      durationMs, errorCode: decision.status === 'DELIVERED' ? null : errorCode ?? 'WEBHOOK_DELIVERY_FAILED',
      errorMessage: decision.status === 'DELIVERED' ? null : errorCode ?? `Endpoint returned HTTP ${status}`,
      nextAttemptAt: decision.delaySeconds === null ? now : new Date(Date.now() + decision.delaySeconds * 1000),
      deliveredAt: decision.status === 'DELIVERED' ? new Date() : null,
    } });
    if (decision.status === 'DELIVERED') await tx.webhookEndpoint.update({ where: { id: item.endpointId }, data: { lastDeliveryAt: new Date() } });
  });
}
