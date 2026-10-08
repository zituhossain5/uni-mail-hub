import { randomUUID } from 'node:crypto';
import { Prisma } from '@uni/database';
import type { WebhookEventType } from './webhook-types';

export async function emitWebhookEvent(tx: Prisma.TransactionClient, input: {
  projectId: string; eventKey: string; type: WebhookEventType; resourceType: string; resourceId: string; payload: Record<string, unknown>;
}) {
  const id = randomUUID();
  const created = await tx.webhookEvent.createMany({ data: [{ id, projectId: input.projectId, eventKey: input.eventKey, type: input.type, resourceType: input.resourceType, resourceId: input.resourceId, payload: { eventId: id, type: input.type, projectId: input.projectId, ...input.payload } as Prisma.InputJsonValue }], skipDuplicates: true });
  if (!created.count) return false;
  const endpoints = await tx.webhookEndpoint.findMany({ where: { projectId: input.projectId, status: 'ACTIVE', subscriptions: { has: input.type } }, select: { id: true } });
  if (endpoints.length) await tx.webhookDelivery.createMany({ data: endpoints.map(endpoint => ({ eventId: id, endpointId: endpoint.id })) });
  return true;
}
