import { Body, Controller, Get, HttpException, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { apiKeyCreateSchema } from '@uni/shared';
import { generateApiKey } from '@uni/security';
import { z } from 'zod';
import { AuthedRequest, Database, SuperAdmin, parse } from './core';

const idSchema = z.string().cuid();
const grantsSchema = z.object({ mailboxIds: z.array(idSchema).min(1).max(100) }).strict();
const safeInclude = { project: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } }, grants: { include: { mailbox: { select: { id: true, email: true, projectId: true } } } } } as const;
const safeSelect = { id: true, projectId: true, name: true, keyPrefix: true, scopes: true, isActive: true, lastUsedAt: true, expiresAt: true, createdByUserId: true, createdAt: true, updatedAt: true, revokedAt: true, ...safeInclude } as const;

@SuperAdmin()
@Controller('api-keys')
export class ApiKeysController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get() list() { return this.db.apiKey.findMany({ select: safeSelect, orderBy: { createdAt: 'desc' } }); }
  @Get(':id') async get(@Param('id') rawId: string) {
    const item = await this.db.apiKey.findUnique({ where: { id: parse(idSchema, rawId) }, select: safeSelect });
    if (!item) throw new HttpException({ code: 'API_KEY_NOT_FOUND', message: 'API key not found' }, 404);
    return item;
  }
  @Post() async create(@Body() body: unknown, @Req() request: AuthedRequest) {
    const input = parse(apiKeyCreateSchema, body);
    const project = await this.db.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw new HttpException({ code: 'PROJECT_NOT_FOUND', message: 'Project not found' }, 404);
    const mailboxIds = [...new Set(input.mailboxIds)];
    const count = await this.db.mailbox.count({ where: { id: { in: mailboxIds }, projectId: input.projectId } });
    if (count !== mailboxIds.length) throw new HttpException({ code: 'INVALID_MAILBOX_GRANT', message: 'All sender mailboxes must belong to this project' }, 400);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) throw new HttpException({ code: 'INVALID_EXPIRATION', message: 'Expiration must be in the future' }, 400);
    const { rawKey, keyPrefix, keyHash } = generateApiKey(process.env.NODE_ENV === 'production' ? 'live' : 'test');
    const item = await this.db.$transaction(async tx => {
      const saved = await tx.apiKey.create({ data: { projectId: input.projectId, name: input.name, keyPrefix, keyHash, scopes: input.scopes, expiresAt, createdByUserId: request.user.id, grants: { create: mailboxIds.map(mailboxId => ({ mailboxId })) } }, select: safeSelect });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'API_KEY_CREATED', entityType: 'ApiKey', entityId: saved.id, metadata: { projectId: input.projectId, mailboxCount: mailboxIds.length }, ipAddress: request.ip } });
      if (input.integration) await tx.auditLog.create({ data: { userId: request.user.id, action: 'PROJECT_INTEGRATION_KEY_CREATED', entityType: 'ApiKey', entityId: saved.id, metadata: { projectId: input.projectId, mailboxCount: mailboxIds.length }, ipAddress: request.ip } });
      return saved;
    });
    return { ...item, rawKey };
  }
  @Patch(':id/grants') async updateGrants(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    const item = await this.db.apiKey.findUnique({ where: { id } });
    if (!item) throw new HttpException({ code: 'API_KEY_NOT_FOUND', message: 'API key not found' }, 404);
    if (item.revokedAt) throw new HttpException({ code: 'API_KEY_REVOKED', message: 'Revoked keys cannot be changed' }, 409);
    const mailboxIds = [...new Set(parse(grantsSchema, body).mailboxIds)];
    const count = await this.db.mailbox.count({ where: { id: { in: mailboxIds }, projectId: item.projectId } });
    if (count !== mailboxIds.length) throw new HttpException({ code: 'INVALID_MAILBOX_GRANT', message: 'All sender mailboxes must belong to this project' }, 400);
    await this.db.$transaction(async tx => {
      await tx.apiKeyMailboxGrant.deleteMany({ where: { apiKeyId: id } });
      await tx.apiKeyMailboxGrant.createMany({ data: mailboxIds.map(mailboxId => ({ apiKeyId: id, mailboxId })) });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'API_KEY_MAILBOX_GRANT_UPDATED', entityType: 'ApiKey', entityId: id, metadata: { mailboxCount: mailboxIds.length }, ipAddress: request.ip } });
    });
    return this.get(id);
  }
  @Post(':id/revoke') async revoke(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    await this.db.$transaction(async tx => {
      await tx.apiKey.update({ where: { id }, data: { isActive: false, revokedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'API_KEY_REVOKED', entityType: 'ApiKey', entityId: id, ipAddress: request.ip } });
    });
    return this.get(id);
  }
  @Patch(':id') async setActive(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    const { isActive } = parse(z.object({ isActive: z.boolean() }).strict(), body);
    const existing = await this.db.apiKey.findUnique({ where: { id } });
    if (!existing) throw new HttpException({ code: 'API_KEY_NOT_FOUND', message: 'API key not found' }, 404);
    if (existing.revokedAt) throw new HttpException({ code: 'API_KEY_REVOKED', message: 'Revoked keys cannot be reactivated' }, 409);
    await this.db.$transaction(async tx => {
      await tx.apiKey.update({ where: { id }, data: { isActive } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: isActive ? 'API_KEY_ENABLED' : 'API_KEY_DISABLED', entityType: 'ApiKey', entityId: id, ipAddress: request.ip } });
    });
    return this.get(id);
  }
}
