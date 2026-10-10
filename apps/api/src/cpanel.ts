import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Injectable, OnModuleDestroy, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Prisma } from '@uni/database';
import { CpanelClient, classifyCpanelError, normalizeEmail, validateCpanelHost } from '@uni/mail';
import { decodeEncryptionKey, decryptSecret, encryptSecret } from '@uni/security';
import Redis from 'ioredis';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { AuthedRequest, Database, SuperAdmin, parse, requestLogger } from './core';

const id = z.string().cuid();
const accountFields = z.object({ name: z.string().trim().min(1).max(120), host: z.string().trim().min(1).max(253), port: z.literal(2083), username: z.string().regex(/^[a-z0-9_-]{1,32}$/), status: z.enum(['ACTIVE', 'DISABLED']) }).strict();
const createAccount = accountFields.extend({ apiToken: z.string().min(1).max(4096) });
const updateAccount = accountFields.partial().strict().refine(value => Object.keys(value).length > 0);
const importInput = z.object({ projectId: id.optional(), newProject: z.object({ name: z.string().trim().min(1).max(120), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120) }).strict().optional(), mailServerId: id.optional(), createMailServer: z.boolean().optional(), mailHost: z.string().optional() }).strict().refine(value => Boolean(value.projectId) !== Boolean(value.newProject), 'Select a project or create one').refine(value => Boolean(value.mailServerId) !== Boolean(value.createMailServer), 'Select a mail server or create one');
const discoveryListQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().refine(value => [10, 20, 50, 100].includes(value)).default(20),
  search: z.string().trim().max(320).default(''),
  status: z.enum(['ALL', 'NEW', 'MANAGED', 'MISSING', 'IGNORED']).default('ALL'),
}).strict();
const safeAccount = { id: true, name: true, host: true, port: true, username: true, status: true, connectionStatus: true, lastConnectedAt: true, lastDiscoveryAt: true, lastError: true, createdAt: true, updatedAt: true } as const;
const key = decodeEncryptionKey(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY ?? '');

@Injectable()
export class CpanelDiscoveryQueue implements OnModuleDestroy {
  private readonly connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  private readonly queue = new Queue('cpanel-discovery', { connection: this.connection });
  async enqueue(runId: string) { await this.queue.add('discover', { runId }, { jobId: runId, attempts: 1, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 86400, count: 1000 } }); }
  async onModuleDestroy() { await this.queue.close(); await this.connection.quit(); }
}

@SuperAdmin()
@Controller('cpanel-accounts')
export class CpanelController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(CpanelDiscoveryQueue) private readonly queue: CpanelDiscoveryQueue) {}
  private async account(rawId: string) {
    const item = await this.db.cpanelAccount.findUnique({ where: { id: parse(id, rawId) } });
    if (!item) throw new HttpException({ code: 'CPANEL_ACCOUNT_NOT_FOUND', message: 'cPanel account not found.' }, 404);
    return item;
  }
  private client(account: Awaited<ReturnType<CpanelController['account']>>) {
    try { return new CpanelClient({ host: account.host, port: account.port, username: account.username, apiToken: decryptSecret({ encryptedPassword: account.encryptedApiToken, encryptionIv: account.encryptionIv, encryptionAuthTag: account.encryptionAuthTag, encryptionVersion: account.encryptionVersion }, key) }, event => requestLogger.info({ accountId: account.id, ...event }, 'cPanel connection stage')); }
    catch { throw new HttpException({ code: 'CPANEL_CREDENTIAL_UNAVAILABLE', message: 'Stored cPanel token could not be decrypted.' }, 409); }
  }
  @Get() list() { return this.db.cpanelAccount.findMany({ select: { ...safeAccount, _count: { select: { domains: true, mailboxes: true, forwarders: true } } }, orderBy: { createdAt: 'desc' } }); }
  @Get(':id') async get(@Param('id') rawId: string) {
    const accountId = parse(id, rawId);
    const item = await this.db.cpanelAccount.findUnique({ where: { id: accountId }, select: { ...safeAccount, _count: { select: { domains: true, mailboxes: true, forwarders: true } } } });
    if (!item) throw new HttpException('cPanel account not found.', 404);
    return item;
  }
  @Post() async create(@Body() body: unknown, @Req() request: AuthedRequest) {
    const input = parse(createAccount, body);
    let host: string;
    try { host = validateCpanelHost(input.host); } catch (error) { throw new HttpException({ code: 'CPANEL_INVALID_HOST', message: (error as Error).message }, 400); }
    const encrypted = encryptSecret(input.apiToken, key);
    const result = await this.db.$transaction(async tx => {
      const item = await tx.cpanelAccount.create({ data: { name: input.name, host, port: input.port, username: input.username, status: input.status, encryptedApiToken: encrypted.encryptedPassword, encryptionIv: encrypted.encryptionIv, encryptionAuthTag: encrypted.encryptionAuthTag, encryptionVersion: encrypted.encryptionVersion }, select: safeAccount });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'CPANEL_ACCOUNT_CREATED', entityType: 'CpanelAccount', entityId: item.id, ipAddress: request.ip, metadata: { host, username: input.username } } });
      return item;
    });
    return result;
  }
  @Patch(':id') async update(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const account = await this.account(rawId);
    const input = parse(updateAccount, body);
    let host: string | undefined;
    try { host = input.host ? validateCpanelHost(input.host) : undefined; } catch (error) { throw new HttpException({ code: 'CPANEL_INVALID_HOST', message: (error as Error).message }, 400); }
    return this.db.$transaction(async tx => {
      const item = await tx.cpanelAccount.update({ where: { id: account.id }, data: { ...input, ...(host ? { host } : {}), ...(host && host !== account.host || input.username && input.username !== account.username ? { connectionStatus: 'UNTESTED', lastConnectedAt: null, lastError: null } : {}) }, select: safeAccount });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'CPANEL_ACCOUNT_UPDATED', entityType: 'CpanelAccount', entityId: item.id, ipAddress: request.ip, metadata: { changedFields: Object.keys(input) } } });
      return item;
    });
  }
  @Post(':id/token') async replaceToken(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const account = await this.account(rawId);
    const { apiToken } = parse(z.object({ apiToken: z.string().min(1).max(4096) }).strict(), body);
    const encrypted = encryptSecret(apiToken, key);
    await this.db.$transaction(async tx => {
      await tx.cpanelAccount.update({ where: { id: account.id }, data: { encryptedApiToken: encrypted.encryptedPassword, encryptionIv: encrypted.encryptionIv, encryptionAuthTag: encrypted.encryptionAuthTag, encryptionVersion: encrypted.encryptionVersion, connectionStatus: 'UNTESTED', lastConnectedAt: null, lastError: null } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'CPANEL_TOKEN_REPLACED', entityType: 'CpanelAccount', entityId: account.id, ipAddress: request.ip } });
    });
    return { replaced: true };
  }
  @Delete(':id') async remove(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const account = await this.account(rawId);
    if (await this.db.cpanelDiscoveryRun.count({ where: { accountId: account.id, status: { in: ['QUEUED', 'RUNNING'] } } })) throw new HttpException({ code: 'CPANEL_DISCOVERY_ACTIVE', message: 'Wait for the current discovery run before removing this account.' }, 409);
    if (await this.db.cpanelMailboxChange.count({ where: { accountId: account.id, status: { in: ['PREPARED', 'CRITICAL'] } } })) throw new HttpException({ code: 'CPANEL_RECOVERY_REQUIRED', message: 'Resolve pending mailbox changes before removing this account.' }, 409);
    await this.db.$transaction(async tx => {
      await tx.cpanelMailboxChange.deleteMany({ where: { accountId: account.id, status: 'COMPLETED' } });
      await tx.cpanelAccount.delete({ where: { id: account.id } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'CPANEL_ACCOUNT_REMOVED', entityType: 'CpanelAccount', entityId: account.id, ipAddress: request.ip, metadata: { host: account.host } } });
    });
    return { removed: true };
  }
  @Post(':id/test-connection')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  async testConnection(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const account = await this.account(rawId);
    const started = Date.now();
    let status: 'CONNECTED' | 'AUTH_FAILED' | 'TLS_FAILED' | 'TIMEOUT' | 'CONNECTION_FAILED' = 'CONNECTED';
    let errorCode: string | null = null;
    let message = 'Connected and authenticated successfully.';
    try { await this.client(account).testConnection(); }
    catch (error) {
      const failure = classifyCpanelError(error);
      errorCode = failure.code;
      message = failure.message;
      status = failure.code === 'CPANEL_AUTH_FAILED' ? 'AUTH_FAILED' : failure.code === 'CPANEL_TLS_FAILED' ? 'TLS_FAILED' : failure.code === 'CPANEL_TIMEOUT' ? 'TIMEOUT' : 'CONNECTION_FAILED';
    }
    await this.db.$transaction(async tx => {
      await tx.cpanelAccount.update({ where: { id: account.id }, data: { connectionStatus: status, lastError: errorCode ? message : null, ...(status === 'CONNECTED' ? { lastConnectedAt: new Date() } : {}) } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'CPANEL_CONNECTION_TESTED', entityType: 'CpanelAccount', entityId: account.id, ipAddress: request.ip, metadata: { status, errorCode } } });
    });
    return { status, errorCode, message, latencyMs: Date.now() - started };
  }
  @Post(':id/discover') async discover(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const account = await this.account(rawId);
    if (account.status !== 'ACTIVE') throw new HttpException({ code: 'CPANEL_ACCOUNT_DISABLED', message: 'Enable the account before discovery.' }, 409);
    const active = await this.db.cpanelDiscoveryRun.findFirst({ where: { accountId: account.id, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
    if (active) return { status: 'QUEUED', runId: active.id };
    let run;
    try { run = await this.db.cpanelDiscoveryRun.create({ data: { accountId: account.id, requestedByUserId: request.user.id }, select: { id: true } }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') { const current = await this.db.cpanelDiscoveryRun.findFirst({ where: { accountId: account.id, status: { in: ['QUEUED', 'RUNNING'] } } }); return { status: 'QUEUED', runId: current?.id }; } throw error; }
    try { await this.queue.enqueue(run.id); }
    catch {
      await this.db.cpanelDiscoveryRun.update({ where: { id: run.id }, data: { status: 'FAILED', completedAt: new Date(), errorCode: 'CPANEL_QUEUE_FAILED', errorMessage: 'Discovery could not be queued.' } });
      throw new HttpException({ code: 'CPANEL_QUEUE_FAILED', message: 'Discovery could not be queued.' }, 503);
    }
    await this.db.auditLog.create({ data: { userId: request.user.id, action: 'CPANEL_DISCOVERY_STARTED', entityType: 'CpanelAccount', entityId: account.id, ipAddress: request.ip, metadata: { runId: run.id } } });
    return { status: 'QUEUED', runId: run.id };
  }
  @Get(':id/discovery') async discovery(@Param('id') rawId: string, @Query() rawQuery: Record<string, unknown> = {}) {
    const account = await this.account(rawId);
    const paged = Object.keys(rawQuery).length > 0;
    const input = paged ? parse(discoveryListQuery, rawQuery) : null;
    const state = input?.status === 'NEW' ? 'DISCOVERED' : input?.status === 'ALL' ? undefined : input?.status;
    const mailboxWhere: Prisma.CpanelDiscoveredMailboxWhereInput = { accountId: account.id, ...(state ? { state } : {}), ...(input?.search ? { email: { contains: input.search, mode: 'insensitive' } } : {}) };
    const [domains, forwarders, runs, totalItems, states] = await Promise.all([
      this.db.cpanelDiscoveredDomain.findMany({ where: { accountId: account.id }, orderBy: { domain: 'asc' } }),
      this.db.cpanelDiscoveredForwarder.findMany({ where: { accountId: account.id }, orderBy: { source: 'asc' } }),
      this.db.cpanelDiscoveryRun.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
      input ? this.db.cpanelDiscoveredMailbox.count({ where: mailboxWhere }) : Promise.resolve(0),
      input ? this.db.cpanelDiscoveredMailbox.groupBy({ by: ['state'], where: { accountId: account.id }, _count: { _all: true } }) : Promise.resolve([]),
    ]);
    const pageSize = input?.pageSize ?? 20;
    const totalPages = input ? Math.max(1, Math.ceil(totalItems / pageSize)) : 1;
    const page = Math.min(input?.page ?? 1, totalPages);
    const mailboxes = await this.db.cpanelDiscoveredMailbox.findMany({ where: mailboxWhere, orderBy: [{ email: 'asc' }, { id: 'asc' }], ...(input ? { skip: (page - 1) * pageSize, take: pageSize } : {}), include: { managedMailbox: { select: { id: true, email: true, credential: { select: { id: true } } } } } });
    const items = mailboxes.map(item => ({ ...item, usedBytes: item.usedBytes?.toString() ?? null, quotaBytes: item.quotaBytes?.toString() ?? null, usagePercent: item.quotaBytes && item.quotaBytes > 0n && item.usedBytes !== null ? Math.round(Number(item.usedBytes * 100n / item.quotaBytes)) : null, managedMailbox: item.managedMailbox ? { id: item.managedMailbox.id, email: item.managedMailbox.email, credentialConfigured: !!item.managedMailbox.credential } : null }));
    return input ? { domains, mailboxes: items, forwarders, runs, pagination: { page, pageSize, totalItems, totalPages }, summary: { mailboxes: states.reduce((sum, row) => sum + row._count._all, 0), missing: states.find(row => row.state === 'MISSING')?._count._all ?? 0 } } : { domains, mailboxes: items, forwarders, runs };
  }
  @Post(':id/mailboxes/:mailboxId/ignore') async ignore(@Param('id') rawId: string, @Param('mailboxId') rawMailboxId: string, @Req() request: AuthedRequest) {
    const account = await this.account(rawId);
    const item = await this.db.cpanelDiscoveredMailbox.findFirst({ where: { id: parse(id, rawMailboxId), accountId: account.id } });
    if (!item) throw new HttpException('Discovered mailbox not found.', 404);
    if (item.state === 'MANAGED') throw new HttpException({ code: 'CPANEL_ALREADY_MANAGED', message: 'Managed mailboxes cannot be ignored.' }, 409);
    await this.db.$transaction(async tx => {
      await tx.cpanelDiscoveredMailbox.update({ where: { id: item.id }, data: { state: 'IGNORED' } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'DISCOVERED_MAILBOX_IGNORED', entityType: 'CpanelDiscoveredMailbox', entityId: item.id, ipAddress: request.ip } });
    });
    return { state: 'IGNORED' };
  }
  @Post(':id/mailboxes/:mailboxId/restore') async restore(@Param('id') rawId: string, @Param('mailboxId') rawMailboxId: string, @Req() request: AuthedRequest) {
    const account = await this.account(rawId);
    const item = await this.db.cpanelDiscoveredMailbox.findFirst({ where: { id: parse(id, rawMailboxId), accountId: account.id } });
    if (!item) throw new HttpException('Discovered mailbox not found.', 404);
    await this.db.$transaction(async tx => {
      await tx.cpanelDiscoveredMailbox.update({ where: { id: item.id }, data: { state: item.managedMailboxId ? 'MANAGED' : 'DISCOVERED' } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'DISCOVERED_MAILBOX_RESTORED', entityType: 'CpanelDiscoveredMailbox', entityId: item.id, ipAddress: request.ip } });
    });
    return { restored: true };
  }
  @Post(':id/mailboxes/:mailboxId/import') async importMailbox(@Param('id') rawId: string, @Param('mailboxId') rawMailboxId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const account = await this.account(rawId);
    const item = await this.db.cpanelDiscoveredMailbox.findFirst({ where: { id: parse(id, rawMailboxId), accountId: account.id } });
    if (!item) throw new HttpException('Discovered mailbox not found.', 404);
    if (item.state !== 'DISCOVERED' || !normalizeEmail(item.email) || item.email.split('@')[1] !== item.domain) throw new HttpException({ code: 'CPANEL_IMPORT_UNAVAILABLE', message: 'Only a valid, present, new mailbox can be imported.' }, 409);
    const input = parse(importInput, body);
    let mailHost: string | undefined;
    if (input.createMailServer) { try { mailHost = validateCpanelHost(input.mailHost || account.host); } catch (error) { throw new HttpException({ code: 'CPANEL_INVALID_HOST', message: (error as Error).message }, 400); } }
    return this.db.$transaction(async tx => {
      if (await tx.mailbox.findFirst({ where: { email: { equals: item.email, mode: 'insensitive' } } })) throw new HttpException({ code: 'CPANEL_MAILBOX_EXISTS', message: 'This mailbox is already managed.' }, 409);
      const project = input.projectId ? await tx.project.findUnique({ where: { id: input.projectId } }) : await tx.project.create({ data: input.newProject! });
      if (!project) throw new HttpException({ code: 'CPANEL_PROJECT_NOT_FOUND', message: 'Select an existing project.' }, 400);
      let domain = await tx.domain.findFirst({ where: { domain: { equals: item.domain, mode: 'insensitive' } } });
      if (domain && domain.projectId !== project.id) throw new HttpException({ code: 'CPANEL_DOMAIN_PROJECT_CONFLICT', message: 'This domain belongs to a different project.' }, 409);
      if (!domain) domain = await tx.domain.create({ data: { domain: item.domain, projectId: project.id } });
      let server = input.mailServerId ? await tx.mailServer.findUnique({ where: { id: input.mailServerId } }) : null;
      if (input.createMailServer && mailHost) {
        server = await tx.mailServer.findFirst({ where: { providerType: 'CPANEL', status: 'ACTIVE', imapHost: mailHost, imapPort: 993, smtpHost: mailHost, smtpPort: 465 } });
        if (!server) server = await tx.mailServer.create({ data: { name: `${account.name} mail`, providerType: 'CPANEL', imapHost: mailHost, imapPort: 993, smtpHost: mailHost, smtpPort: 465, imapSecurity: 'TLS', smtpSecurity: 'TLS', smtpAuthMode: 'PASSWORD' } });
      }
      if (!server || server.status !== 'ACTIVE') throw new HttpException({ code: 'CPANEL_MAIL_SERVER_INVALID', message: 'Select an active mail server.' }, 400);
      const mailbox = await tx.mailbox.create({ data: { email: item.email, projectId: project.id, domainId: domain.id, mailServerId: server.id, status: 'UNKNOWN' }, select: { id: true, email: true } });
      await tx.cpanelDiscoveredMailbox.update({ where: { id: item.id }, data: { state: 'MANAGED', managedMailboxId: mailbox.id } });
      await tx.cpanelDiscoveredDomain.updateMany({ where: { accountId: account.id, domain: item.domain }, data: { state: 'MANAGED', managedDomainId: domain.id } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'MAILBOX_IMPORTED_FROM_CPANEL', entityType: 'Mailbox', entityId: mailbox.id, ipAddress: request.ip, metadata: { accountId: account.id, discoveredMailboxId: item.id, projectId: project.id, domainId: domain.id, mailServerId: server.id } } });
      return { ...mailbox, projectId: project.id, domainId: domain.id, mailServerId: server.id, credentialConfigured: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
