import { Body, CanActivate, Controller, ExecutionContext, Get, Headers, HttpCode, HttpException, Inject, Injectable, OnModuleDestroy, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { Prisma } from '@uni/database';
import { readConfig } from '@uni/config';
import { hashApiKey } from '@uni/security';
import { sendMessageSchema } from '@uni/shared';
import { z } from 'zod';
import { AuthedRequest, Database, Public, RedisConnection, SuperAdmin, parse } from './core';

const config = readConfig();
const idSchema = z.string().cuid();
type ApiPrincipal = { id: string; projectId: string; scopes: string[] };
type ApiRequest = Request & { apiPrincipal: ApiPrincipal };
const problem = (code: string, message: string, status = 400) => new HttpException({ code, message }, status);

@Injectable()
export class MailQueue implements OnModuleDestroy {
  private readonly connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  private readonly queue = new Queue('mail-send', { connection: this.connection });
  async publish(eventId: string, messageId: string) {
    await this.queue.add('send', { messageId }, { jobId: eventId, removeOnComplete: { age: 86400, count: 10000 }, removeOnFail: { age: 86400, count: 10000 } });
  }
  async onModuleDestroy() { await this.queue.close(); await this.connection.quit(); }
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(Database) private readonly db: Database, @Inject(RedisConnection) private readonly redis: RedisConnection) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const raw = request.headers.authorization?.match(/^Bearer (umh_(?:live|test)_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!raw) throw problem('API_KEY_INVALID', 'Valid API key required', 401);
    const key = await this.db.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) }, select: { id: true, projectId: true, scopes: true, isActive: true, revokedAt: true, expiresAt: true } });
    if (!key) throw problem('API_KEY_INVALID', 'Valid API key required', 401);
    if (!key.isActive || key.revokedAt) throw problem('API_KEY_REVOKED', 'API key is revoked', 401);
    if (key.expiresAt && key.expiresAt <= new Date()) throw problem('API_KEY_EXPIRED', 'API key has expired', 401);
    if (!key.scopes.includes('MAIL_SEND')) throw problem('API_KEY_SCOPE_DENIED', 'API key lacks mail send scope', 403);
    const rateKey = `mail-api-rate:${key.id}:${Math.floor(Date.now() / (config.MAIL_API_RATE_LIMIT_WINDOW_SECONDS * 1000))}`;
    const count = await this.redis.client.incr(rateKey);
    if (count === 1) await this.redis.client.expire(rateKey, config.MAIL_API_RATE_LIMIT_WINDOW_SECONDS + 1);
    if (count > config.MAIL_API_RATE_LIMIT_MAX) throw problem('RATE_LIMIT_EXCEEDED', 'API key rate limit exceeded', 429);
    request.apiPrincipal = { id: key.id, projectId: key.projectId, scopes: key.scopes };
    await this.db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    return true;
  }
}

const clientSelect = { id: true, status: true, subject: true, queuedAt: true, processingAt: true, smtpAcceptedAt: true, failedAt: true, createdAt: true, lastErrorCode: true, fromMailbox: { select: { id: true, email: true } }, recipients: { where: { type: { in: ['TO', 'CC'] as ('TO' | 'CC')[] } }, select: { type: true, email: true, name: true, smtpStatus: true } } } as const;

@Public()
@UseGuards(ApiKeyGuard)
@Controller('messages')
export class ClientMessagesController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(MailQueue) private readonly queue: MailQueue) {}
  @Post() @HttpCode(202)
  async submit(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: ApiRequest) {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw problem('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
    const input = parse(sendMessageSchema, body);
    const to = input.to ?? []; const cc = input.cc ?? []; const bcc = input.bcc ?? [];
    const recipientCount = to.length + cc.length + bcc.length;
    if (recipientCount > config.MAIL_MAX_RECIPIENTS) throw problem('TOO_MANY_RECIPIENTS', 'Recipient limit exceeded');
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > config.MAIL_MAX_BODY_BYTES) throw problem('MESSAGE_TOO_LARGE', 'Message body limit exceeded', 413);
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const keyId = request.apiPrincipal.id;
    const existing = await this.db.outgoingMessage.findUnique({ where: { apiKeyId_idempotencyKey: { apiKeyId: keyId, idempotencyKey } } });
    if (existing) return this.existing(existing.id, existing.requestHash, requestHash);
    const mailbox = await this.db.mailbox.findFirst({ where: { id: input.fromMailboxId, projectId: request.apiPrincipal.projectId }, include: { mailServer: true, credential: { select: { id: true } }, apiKeyGrants: { where: { apiKeyId: keyId, canSend: true }, select: { id: true } } } });
    if (!mailbox || mailbox.apiKeyGrants.length === 0) throw problem('SENDER_NOT_AUTHORIZED', 'Sender mailbox is not authorized for this API key', 403);
    if (!mailbox.isActive || mailbox.status === 'DISABLED') throw problem('MAILBOX_DISABLED', 'Sender mailbox is disabled', 409);
    if (!mailbox.mailServer || !mailbox.mailServer.smtpHost || !mailbox.mailServer.smtpPort) throw problem('MAILBOX_NOT_CONFIGURED', 'Sender mailbox has no SMTP server', 409);
    if (mailbox.mailServer.status !== 'ACTIVE') throw problem('MAIL_SERVER_DISABLED', 'Sender mail server is disabled', 409);
    if (mailbox.mailServer.smtpAuthMode === 'PASSWORD' && !mailbox.credential) throw problem('MAIL_CREDENTIAL_NOT_CONFIGURED', 'Sender mailbox credentials are missing', 409);
    const recipients = [...to.map(value => ({ ...value, type: 'TO' as const })), ...cc.map(value => ({ ...value, type: 'CC' as const })), ...bcc.map(value => ({ ...value, type: 'BCC' as const }))];
    let created: { id: string; status: string; createdAt: Date; outboxEvents: { id: string }[] };
    try {
      created = await this.db.outgoingMessage.create({ data: { projectId: request.apiPrincipal.projectId, apiKeyId: keyId, fromMailboxId: mailbox.id, subject: input.subject, textBody: input.text, htmlBody: input.html, replyToEmail: input.replyTo?.email, replyToName: input.replyTo?.name, idempotencyKey, requestHash, recipients: { create: recipients }, outboxEvents: { create: {} } }, select: { id: true, status: true, createdAt: true, outboxEvents: { select: { id: true } } } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.db.outgoingMessage.findUnique({ where: { apiKeyId_idempotencyKey: { apiKeyId: keyId, idempotencyKey } } });
        if (raced) return this.existing(raced.id, raced.requestHash, requestHash);
      }
      throw error;
    }
    await this.publish(created.id, created.outboxEvents[0]!.id);
    return { id: created.id, status: created.status, createdAt: created.createdAt };
  }
  private async existing(id: string, oldHash: string, requestHash: string) {
    if (oldHash !== requestHash) throw problem('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used with different content', 409);
    const event = await this.db.outboxEvent.findFirst({ where: { messageId: id, status: 'READY', availableAt: { lte: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (event) await this.publish(id, event.id);
    const message = await this.db.outgoingMessage.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, createdAt: true } });
    return message;
  }
  private async publish(messageId: string, eventId: string) {
    try { await this.queue.publish(eventId, messageId); await this.db.outboxEvent.update({ where: { id: eventId }, data: { status: 'PUBLISHED', publishedAt: new Date() } }); }
    catch { throw problem('QUEUE_UNAVAILABLE', 'Message saved, but queue is temporarily unavailable; retry with the same Idempotency-Key', 503); }
  }
  @Get(':id') async get(@Param('id') rawId: string, @Req() request: ApiRequest) {
    const item = await this.db.outgoingMessage.findFirst({ where: { id: parse(idSchema, rawId), apiKeyId: request.apiPrincipal.id, projectId: request.apiPrincipal.projectId }, select: clientSelect });
    if (!item) throw problem('MESSAGE_NOT_FOUND', 'Message not found', 404);
    return item;
  }
}

@SuperAdmin()
@Controller('admin/compose')
export class AdminComposeController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(MailQueue) private readonly queue: MailQueue) {}

  @Post() @HttpCode(202)
  async submit(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: AuthedRequest) {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw problem('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
    const input = parse(sendMessageSchema, body);
    const to = input.to ?? []; const cc = input.cc ?? []; const bcc = input.bcc ?? [];
    if (to.length + cc.length + bcc.length > config.MAIL_MAX_RECIPIENTS) throw problem('TOO_MANY_RECIPIENTS', 'Recipient limit exceeded');
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > config.MAIL_MAX_BODY_BYTES) throw problem('MESSAGE_TOO_LARGE', 'Message body limit exceeded', 413);
    const mailbox = await this.db.mailbox.findUnique({ where: { id: input.fromMailboxId }, include: { mailServer: true, credential: { select: { id: true } } } });
    if (!mailbox) throw problem('SENDER_NOT_AUTHORIZED', 'Select a managed sender mailbox', 403);
    if (!mailbox.isActive || mailbox.status === 'DISABLED') throw problem('MAILBOX_DISABLED', 'Sender mailbox is disabled', 409);
    if (!mailbox.mailServer || !mailbox.mailServer.smtpHost || !mailbox.mailServer.smtpPort || mailbox.mailServer.status !== 'ACTIVE') throw problem('MAILBOX_NOT_CONFIGURED', 'Sender mailbox needs an active SMTP server', 409);
    if (mailbox.mailServer.smtpAuthMode === 'PASSWORD' && !mailbox.credential) throw problem('MAIL_CREDENTIAL_NOT_CONFIGURED', 'Sender mailbox credentials are missing', 409);
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const identity = { createdByUserId: request.user.id, idempotencyKey };
    const existing = await this.db.outgoingMessage.findUnique({ where: { createdByUserId_idempotencyKey: identity }, select: { id: true, requestHash: true, status: true, createdAt: true } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw problem('IDEMPOTENCY_CONFLICT', 'This submission key was used with different content', 409);
      const event = await this.db.outboxEvent.findFirst({ where: { messageId: existing.id, status: 'READY', availableAt: { lte: new Date() } }, orderBy: { createdAt: 'desc' } });
      if (event) await this.publish(event.id, existing.id);
      return { id: existing.id, status: existing.status, createdAt: existing.createdAt };
    }
    const recipients = [...to.map(value => ({ ...value, type: 'TO' as const })), ...cc.map(value => ({ ...value, type: 'CC' as const })), ...bcc.map(value => ({ ...value, type: 'BCC' as const }))];
    let created: { id: string; status: string; createdAt: Date; outboxEvents: { id: string }[] };
    try {
      created = await this.db.outgoingMessage.create({ data: { projectId: mailbox.projectId, createdByUserId: request.user.id, fromMailboxId: mailbox.id, subject: input.subject, textBody: input.text, htmlBody: input.html, replyToEmail: input.replyTo?.email, replyToName: input.replyTo?.name, idempotencyKey, requestHash, recipients: { create: recipients }, outboxEvents: { create: {} } }, select: { id: true, status: true, createdAt: true, outboxEvents: { select: { id: true } } } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.db.outgoingMessage.findUnique({ where: { createdByUserId_idempotencyKey: identity }, select: { id: true, requestHash: true, status: true, createdAt: true } });
        if (raced) { if (raced.requestHash !== requestHash) throw problem('IDEMPOTENCY_CONFLICT', 'This submission key was used with different content', 409); return { id: raced.id, status: raced.status, createdAt: raced.createdAt }; }
      }
      throw error;
    }
    await this.db.auditLog.create({ data: { userId: request.user.id, action: 'WEBMAIL_COMPOSE_QUEUED', entityType: 'OutgoingMessage', entityId: created.id, ipAddress: request.ip } });
    await this.publish(created.outboxEvents[0]!.id, created.id);
    return { id: created.id, status: created.status, createdAt: created.createdAt };
  }

  private async publish(eventId: string, messageId: string) {
    try { await this.queue.publish(eventId, messageId); await this.db.outboxEvent.update({ where: { id: eventId }, data: { status: 'PUBLISHED', publishedAt: new Date() } }); }
    catch { throw problem('QUEUE_UNAVAILABLE', 'Message saved, but delivery is temporarily unavailable. Check Outgoing Mail.', 503); }
  }
}

@SuperAdmin()
@Controller('admin/messages')
export class AdminMessagesController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(MailQueue) private readonly queue: MailQueue) {}
  @Get() list() { return this.db.outgoingMessage.findMany({ take: 100, orderBy: { createdAt: 'desc' }, select: { id: true, subject: true, status: true, createdAt: true, attemptCount: true, lastErrorCode: true, project: { select: { id: true, name: true } }, fromMailbox: { select: { id: true, email: true } }, recipients: { where: { type: 'TO' }, select: { email: true } } } }); }
  @Get(':id') async get(@Param('id') rawId: string) {
    const item = await this.db.outgoingMessage.findUnique({ where: { id: parse(idSchema, rawId) }, select: { id: true, subject: true, textBody: true, status: true, queuedAt: true, processingAt: true, smtpAcceptedAt: true, failedAt: true, createdAt: true, attemptCount: true, lastErrorCode: true, lastErrorMessage: true, rfcMessageId: true, project: { select: { id: true, name: true } }, apiKey: { select: { id: true, name: true, keyPrefix: true } }, fromMailbox: { select: { id: true, email: true } }, recipients: { select: { type: true, email: true, name: true, smtpStatus: true, smtpResponse: true } }, attempts: { orderBy: { attemptNumber: 'desc' } } } });
    if (!item) throw problem('MESSAGE_NOT_FOUND', 'Message not found', 404);
    return item;
  }
  @Post(':id/retry') async retry(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    const event = await this.db.$transaction(async tx => {
      const changed = await tx.outgoingMessage.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'QUEUED', queuedAt: new Date(), failedAt: null } });
      if (changed.count !== 1) throw problem('MESSAGE_NOT_RETRYABLE', 'Only final failed messages can be retried', 409);
      const outbox = await tx.outboxEvent.create({ data: { messageId: id } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'OUTGOING_MESSAGE_MANUAL_RETRY', entityType: 'OutgoingMessage', entityId: id, ipAddress: request.ip } });
      return outbox;
    });
    try { await this.queue.publish(event.id, id); await this.db.outboxEvent.update({ where: { id: event.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } }); } catch { /* durable outbox will retry */ }
    return this.get(id);
  }
}
