import { Body, Controller, Delete, Get, Header, HttpCode, HttpException, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { readConfig } from '@uni/config';
import { encryptSecret, decodeEncryptionKey, generateWebhookSecret } from '@uni/security';
import { resolveWebhookTarget, webhookEventTypes } from '@uni/mail';
import { AuthedRequest, Database, SuperAdmin, parse } from './core';

const id = z.string().cuid();
const eventType = z.enum(webhookEventTypes);
const createEndpoint = z.object({ name: z.string().trim().min(1).max(120), url: z.string().trim().url().max(2048), subscriptions: z.array(eventType).min(1).max(webhookEventTypes.length) }).strict();
const updateEndpoint = createEndpoint.partial().extend({ status: z.enum(['ACTIVE', 'DISABLED']).optional() }).strict();
const suppressionInput = z.object({ email: z.string().trim().toLowerCase().email().max(320) }).strict();
const key = decodeEncryptionKey(readConfig().MAIL_CREDENTIAL_ENCRYPTION_KEY);
const problem = (code: string, message: string, status = 400) => new HttpException({ code, message }, status);
export const webhookEndpointSelect = { id: true, projectId: true, name: true, url: true, status: true, subscriptions: true, createdAt: true, updatedAt: true, lastDeliveryAt: true } as const;

@SuperAdmin()
@Controller('admin/projects/:projectId/webhooks')
export class WebhooksController {
  constructor(@Inject(Database) private readonly db: Database) {}

  private async project(raw: string) {
    const projectId = parse(id, raw);
    if (!await this.db.project.findUnique({ where: { id: projectId }, select: { id: true } })) throw problem('PROJECT_NOT_FOUND', 'Project not found', 404);
    return projectId;
  }
  private async endpoint(projectId: string, raw: string) {
    const endpoint = await this.db.webhookEndpoint.findFirst({ where: { id: parse(id, raw), projectId } });
    if (!endpoint) throw problem('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint not found', 404);
    return endpoint;
  }
  private async validateUrl(url: string) {
    try { await resolveWebhookTarget(url); }
    catch { throw problem('WEBHOOK_ENDPOINT_INVALID', 'Webhook URL must be a public HTTPS hostname on port 443'); }
  }

  @Get() async list(@Param('projectId') raw: string) {
    const projectId = await this.project(raw);
    return { eventTypes: webhookEventTypes, endpoints: await this.db.webhookEndpoint.findMany({ where: { projectId }, select: webhookEndpointSelect, orderBy: { createdAt: 'desc' } }) };
  }

  @Post() @Header('Cache-Control', 'private, no-store') async create(@Param('projectId') raw: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const projectId = await this.project(raw);
    const input = parse(createEndpoint, body);
    await this.validateUrl(input.url);
    const secret = generateWebhookSecret();
    const encrypted = encryptSecret(secret, key);
    const endpoint = await this.db.$transaction(async tx => {
      const row = await tx.webhookEndpoint.create({ data: { projectId, name: input.name, url: input.url, subscriptions: [...new Set(input.subscriptions)], encryptedSecret: encrypted.encryptedPassword, encryptionIv: encrypted.encryptionIv, encryptionAuthTag: encrypted.encryptionAuthTag, encryptionVersion: encrypted.encryptionVersion }, select: webhookEndpointSelect });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'WEBHOOK_CREATED', entityType: 'WebhookEndpoint', entityId: row.id, metadata: { projectId } } });
      return row;
    });
    return { endpoint, secret };
  }

  @Patch(':endpointId') async update(@Param('projectId') raw: string, @Param('endpointId') endpointRaw: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const projectId = await this.project(raw);
    const current = await this.endpoint(projectId, endpointRaw);
    const input = parse(updateEndpoint, body);
    if (input.url) await this.validateUrl(input.url);
    const endpoint = await this.db.$transaction(async tx => {
      const row = await tx.webhookEndpoint.update({ where: { id: current.id }, data: { ...input, subscriptions: input.subscriptions ? [...new Set(input.subscriptions)] : undefined }, select: webhookEndpointSelect });
      await tx.auditLog.create({ data: { userId: request.user.id, action: input.status === 'DISABLED' ? 'WEBHOOK_DISABLED' : 'WEBHOOK_UPDATED', entityType: 'WebhookEndpoint', entityId: row.id, metadata: { projectId } } });
      return row;
    });
    return endpoint;
  }

  @Post(':endpointId/rotate') @Header('Cache-Control', 'private, no-store') async rotate(@Param('projectId') raw: string, @Param('endpointId') endpointRaw: string, @Req() request: AuthedRequest) {
    const projectId = await this.project(raw);
    const current = await this.endpoint(projectId, endpointRaw);
    const secret = generateWebhookSecret();
    const encrypted = encryptSecret(secret, key);
    await this.db.$transaction(async tx => {
      await tx.webhookEndpoint.update({ where: { id: current.id }, data: { encryptedSecret: encrypted.encryptedPassword, encryptionIv: encrypted.encryptionIv, encryptionAuthTag: encrypted.encryptionAuthTag, encryptionVersion: encrypted.encryptionVersion } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'WEBHOOK_SECRET_ROTATED', entityType: 'WebhookEndpoint', entityId: current.id, metadata: { projectId } } });
    });
    return { secret };
  }

  @Post(':endpointId/test') @Throttle({ default: { limit: 5, ttl: 60_000 } }) async test(@Param('projectId') raw: string, @Param('endpointId') endpointRaw: string, @Req() request: AuthedRequest) {
    const projectId = await this.project(raw);
    const endpoint = await this.endpoint(projectId, endpointRaw);
    if (endpoint.status !== 'ACTIVE') throw problem('WEBHOOK_ENDPOINT_DISABLED', 'Enable the endpoint before sending a test', 409);
    const eventId = randomUUID();
    const event = await this.db.$transaction(async tx => {
      const row = await tx.webhookEvent.create({ data: { id: eventId, projectId, eventKey: `webhook.test:${eventId}`, type: 'webhook.test', resourceType: 'WebhookEndpoint', resourceId: endpoint.id, payload: { eventId, type: 'webhook.test', projectId, endpointId: endpoint.id, message: 'Synthetic Uni Mail Hub webhook test' }, deliveries: { create: { endpointId: endpoint.id } } }, select: { id: true, deliveries: { select: { id: true } } } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'WEBHOOK_TEST_SENT', entityType: 'WebhookEndpoint', entityId: endpoint.id, metadata: { projectId, eventId } } });
      return row;
    });
    return { eventId: event.id, deliveryId: event.deliveries[0]!.id, status: 'PENDING' };
  }

  @Get('deliveries') async deliveries(@Param('projectId') raw: string) {
    const projectId = await this.project(raw);
    return this.db.webhookDelivery.findMany({ where: { endpoint: { projectId } }, select: { id: true, eventId: true, endpointId: true, replayOfId: true, status: true, attemptCount: true, httpStatus: true, responseSnippet: true, durationMs: true, nextAttemptAt: true, firstAttemptAt: true, lastAttemptAt: true, deliveredAt: true, errorCode: true, errorMessage: true, createdAt: true, event: { select: { type: true, resourceType: true, resourceId: true, payload: true, createdAt: true } }, endpoint: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Post('deliveries/:deliveryId/replay') @Throttle({ default: { limit: 5, ttl: 60_000 } }) async replay(@Param('projectId') raw: string, @Param('deliveryId') deliveryRaw: string, @Req() request: AuthedRequest) {
    const projectId = await this.project(raw);
    const previous = await this.db.webhookDelivery.findFirst({ where: { id: parse(id, deliveryRaw), endpoint: { projectId } }, include: { endpoint: true, event: true } });
    if (!previous) throw problem('WEBHOOK_DELIVERY_NOT_FOUND', 'Delivery not found', 404);
    if (previous.status !== 'FAILED') throw problem('WEBHOOK_REPLAY_INVALID', 'Only failed deliveries can be replayed', 409);
    if (previous.endpoint.status !== 'ACTIVE' || !previous.endpoint.subscriptions.includes(previous.event.type)) throw problem('WEBHOOK_ENDPOINT_DISABLED', 'Endpoint is disabled or unsubscribed', 409);
    const replay = await this.db.$transaction(async tx => {
      const row = await tx.webhookDelivery.create({ data: { eventId: previous.eventId, endpointId: previous.endpointId, replayOfId: previous.id } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'WEBHOOK_REPLAYED', entityType: 'WebhookDelivery', entityId: row.id, metadata: { projectId, previousDeliveryId: previous.id, eventId: previous.eventId } } });
      return row;
    });
    return { deliveryId: replay.id, eventId: replay.eventId, status: replay.status };
  }
}

@SuperAdmin()
@Controller('admin/projects/:projectId/suppressions')
export class SuppressionsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get() async list(@Param('projectId') raw: string) {
    const projectId = parse(id, raw);
    return this.db.suppression.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 500 });
  }
  @Post() async add(@Param('projectId') raw: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const projectId = parse(id, raw);
    const { email } = parse(suppressionInput, body);
    const item = await this.db.$transaction(async tx => {
      const row = await tx.suppression.upsert({ where: { projectId_email: { projectId, email } }, create: { projectId, email, reason: 'MANUAL', source: 'ADMIN' }, update: {} });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'SUPPRESSION_ADDED', entityType: 'Suppression', entityId: row.id, metadata: { projectId, email } } });
      return row;
    });
    return item;
  }
  @Delete(':suppressionId') @HttpCode(200) async remove(@Param('projectId') raw: string, @Param('suppressionId') rawId: string, @Req() request: AuthedRequest) {
    const projectId = parse(id, raw);
    const item = await this.db.suppression.findFirst({ where: { id: parse(id, rawId), projectId } });
    if (!item) throw problem('SUPPRESSION_NOT_FOUND', 'Suppression not found', 404);
    await this.db.$transaction(async tx => {
      await tx.suppression.delete({ where: { id: item.id } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'SUPPRESSION_REMOVED', entityType: 'Suppression', entityId: item.id, metadata: { projectId, email: item.email } } });
    });
    return { removed: true };
  }
}
