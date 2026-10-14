import { Body, Controller, Delete, Get, HttpException, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { domainSchema, mailboxSchema, projectSchema } from '@uni/shared';
import { z } from 'zod';
import { AuthedRequest, Database, RedisConnection, SuperAdmin, parse } from './core';
import { AccessPolicy, RequirePermission, mailboxWhere, projectWhere } from './access';
import { UserRole } from '@uni/database';

const idSchema = z.string().cuid();
const projectPatch = projectSchema.partial().refine((value) => Object.keys(value).length > 0);
const domainPatch = domainSchema.partial().refine((value) => Object.keys(value).length > 0);
const mailboxPatch = mailboxSchema.partial().refine((value) => Object.keys(value).length > 0);

function ensureUnverifiedDomainStatus(status?: string) {
  if (status && status !== 'UNVERIFIED' && status !== 'DISABLED') throw new HttpException({ code: 'STATUS_NOT_VERIFIED', message: 'DNS verification is not available yet' }, 400);
}
function ensureUnverifiedMailboxStatus(status?: string) {
  if (status && status !== 'UNKNOWN' && status !== 'DISABLED') throw new HttpException({ code: 'STATUS_NOT_CHECKED', message: 'Mailbox health is determined by connection checks' }, 400);
}

async function audit(db: Database, request: AuthedRequest, action: string, entityType: string, entityId: string) {
  await db.auditLog.create({ data: { userId: request.user.id, action, entityType, entityId, ipAddress: request.ip } });
}

@SuperAdmin()
@RequirePermission('projects.manage')
@Controller('projects')
export class ProjectsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get() @RequirePermission('projects.read') list(@Req() request: AuthedRequest) {
    const mailboxCount = request.user.role === UserRole.STAFF || request.user.role === UserRole.VIEWER ? { where: { userGrants: { some: { userId: request.user.id } } } } : true;
    return this.db.project.findMany({ where: projectWhere(request.user), orderBy: { createdAt: 'desc' }, include: { _count: { select: { domains: true, mailboxes: mailboxCount } } } });
  }
  @Get(':id') @RequirePermission('projects.read') async get(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    await new AccessPolicy(this.db).project(request.user, id);
    const restricted = request.user.role === UserRole.STAFF || request.user.role === UserRole.VIEWER;
    const item = await this.db.project.findUnique({ where: { id }, include: { domains: true, mailboxes: { where: restricted ? { userGrants: { some: { userId: request.user.id } } } : {} }, _count: { select: { domains: true, mailboxes: restricted ? { where: { userGrants: { some: { userId: request.user.id } } } } : true } } } });
    if (!item) throw new HttpException('Project not found', 404);
    return item;
  }
  @Post() async create(@Body() body: unknown, @Req() request: AuthedRequest) {
    const input = parse(projectSchema, body);
    const item = await this.db.project.create({ data: input });
    await audit(this.db, request, 'project.created', 'Project', item.id);
    return item;
  }
  @Patch(':id') async update(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    const item = await this.db.project.update({ where: { id }, data: parse(projectPatch, body) });
    await audit(this.db, request, 'project.updated', 'Project', item.id);
    return item;
  }
  @Delete(':id') async remove(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    await this.db.project.delete({ where: { id } });
    await audit(this.db, request, 'project.deleted', 'Project', id);
    return { deleted: true };
  }
}

@SuperAdmin()
@RequirePermission('mailbox.manage')
@Controller('domains')
export class DomainsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get() list(@Req() request: AuthedRequest) { return this.db.domain.findMany({ where: { project: projectWhere(request.user) }, orderBy: { createdAt: 'desc' }, include: { project: { select: { id: true, name: true } }, _count: { select: { mailboxes: true } } } }); }
  @Get(':id') async get(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const item = await this.db.domain.findFirst({ where: { id: parse(idSchema, rawId), project: projectWhere(request.user) }, include: { project: true, mailboxes: true } });
    if (!item) throw new HttpException('Domain not found', 404);
    return item;
  }
  @Post() async create(@Body() body: unknown, @Req() request: AuthedRequest) {
    const input = parse(domainSchema, body);
    await new AccessPolicy(this.db).project(request.user, input.projectId);
    ensureUnverifiedDomainStatus(input.status);
    const item = await this.db.domain.create({ data: input });
    await audit(this.db, request, 'domain.created', 'Domain', item.id);
    return item;
  }
  @Patch(':id') async update(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    const input = parse(domainPatch, body);
    const current = await this.get(id, request);
    if (input.projectId && input.projectId !== current.projectId) await new AccessPolicy(this.db).project(request.user, input.projectId);
    ensureUnverifiedDomainStatus(input.status);
    if (input.projectId) {
      const count = await this.db.mailbox.count({ where: { domainId: id, projectId: { not: input.projectId } } });
      if (count) throw new HttpException({ code: 'RELATION_CONFLICT', message: 'Move or remove linked mailboxes first' }, 409);
    }
    const item = await this.db.domain.update({ where: { id }, data: input });
    await audit(this.db, request, 'domain.updated', 'Domain', item.id);
    return item;
  }
  @Delete(':id') async remove(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    await this.get(id, request);
    await this.db.domain.delete({ where: { id } });
    await audit(this.db, request, 'domain.deleted', 'Domain', id);
    return { deleted: true };
  }
}

@SuperAdmin()
@RequirePermission('mailbox.manage')
@Controller('mailboxes')
export class MailboxesController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get() list(@Req() request: AuthedRequest) { return this.db.mailbox.findMany({ where: mailboxWhere(request.user), orderBy: { createdAt: 'desc' }, include: { project: { select: { id: true, name: true } }, domain: { select: { id: true, domain: true } }, mailServer: { select: { id: true, name: true, status: true } }, credential: { select: { username: true, updatedAt: true } }, connectionChecks: { orderBy: { testedAt: 'desc' }, take: 10, select: { protocol: true, status: true, testedAt: true, configVersion: true } } } }); }
  @Get(':id') async get(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const item = await this.db.mailbox.findFirst({ where: { id: parse(idSchema, rawId), ...mailboxWhere(request.user) }, include: { project: true, domain: true, mailServer: true, credential: { select: { username: true, updatedAt: true, lastRotatedAt: true } }, connectionChecks: { orderBy: { testedAt: 'desc' }, take: 20 } } });
    if (!item) throw new HttpException('Mailbox not found', 404);
    return item;
  }
  private async checkRelations(input: { projectId: string; domainId: string; email: string; mailServerId?: string | null }, requireActiveServer = true) {
    const domain = await this.db.domain.findUnique({ where: { id: input.domainId } });
    if (!domain || domain.projectId !== input.projectId) throw new HttpException({ code: 'INVALID_RELATION', message: 'Domain must belong to the selected project' }, 400);
    if (!input.email.endsWith(`@${domain.domain}`)) throw new HttpException({ code: 'INVALID_RELATION', message: 'Mailbox email must use the selected domain' }, 400);
    if (input.mailServerId) {
      const server = await this.db.mailServer.findUnique({ where: { id: input.mailServerId } });
      if (!server || requireActiveServer && server.status !== 'ACTIVE') throw new HttpException({ code: 'INVALID_RELATION', message: 'Select an active mail server' }, 400);
    }
  }
  @Post() async create(@Body() body: unknown, @Req() request: AuthedRequest) {
    const input = parse(mailboxSchema, body);
    await new AccessPolicy(this.db).project(request.user, input.projectId);
    ensureUnverifiedMailboxStatus(input.status);
    await this.checkRelations(input);
    const item = await this.db.mailbox.create({ data: { ...input, ...(input.isActive === false || input.status === 'DISABLED' ? { status: 'DISABLED' } : {}) } });
    await audit(this.db, request, 'mailbox.created', 'Mailbox', item.id);
    return item;
  }
  @Patch(':id') async update(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    const input = parse(mailboxPatch, body);
    ensureUnverifiedMailboxStatus(input.status);
    const existing = await this.db.mailbox.findUnique({ where: { id } });
    if (!existing) throw new HttpException('Mailbox not found', 404);
    await new AccessPolicy(this.db).mailbox(request.user, id, 'mailbox.manage');
    if (input.projectId && input.projectId !== existing.projectId) await new AccessPolicy(this.db).project(request.user, input.projectId);
    await this.checkRelations({ projectId: input.projectId ?? existing.projectId, domainId: input.domainId ?? existing.domainId, email: input.email ?? existing.email, mailServerId: input.mailServerId === undefined ? existing.mailServerId : input.mailServerId }, input.mailServerId !== undefined && input.mailServerId !== existing.mailServerId);
    const changed = input.mailServerId !== undefined && input.mailServerId !== existing.mailServerId;
    const reactivated = existing.isActive === false && input.isActive === true;
    const disabled = input.isActive === false || input.status === 'DISABLED';
    const item = await this.db.mailbox.update({ where: { id }, data: { ...input, ...((changed || reactivated) ? { connectionConfigVersion: { increment: 1 }, lastError: null } : {}), ...((disabled || changed || reactivated) ? { status: disabled ? 'DISABLED' : 'UNKNOWN' } : {}) } });
    await audit(this.db, request, 'mailbox.updated', 'Mailbox', item.id);
    return item;
  }
  @Delete(':id') async remove(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    await new AccessPolicy(this.db).mailbox(request.user, id, 'mailbox.manage');
    await this.db.mailbox.delete({ where: { id } });
    await audit(this.db, request, 'mailbox.deleted', 'Mailbox', id);
    return { deleted: true };
  }
}

@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(RedisConnection) private readonly redis: RedisConnection) {}
  @Get() async get(@Req() request: AuthedRequest) {
    if (request.user.role !== UserRole.SUPER_ADMIN && request.user.role !== UserRole.ADMIN) {
      const scoped = mailboxWhere(request.user);
      const [projects, domains, mailboxes, healthyMailboxes, warningMailboxes, errorMailboxes, unknownMailboxes, queuedMessages, processingMessages, retryScheduledMessages] = await Promise.all([
        this.db.project.count({ where: projectWhere(request.user) }),
        this.db.domain.count({ where: { project: projectWhere(request.user) } }),
        this.db.mailbox.count({ where: scoped }),
        this.db.mailbox.count({ where: { AND: [scoped, { status: 'HEALTHY', isActive: true }] } }),
        this.db.mailbox.count({ where: { AND: [scoped, { status: 'WARNING', isActive: true }] } }),
        this.db.mailbox.count({ where: { AND: [scoped, { status: 'ERROR', isActive: true }] } }),
        this.db.mailbox.count({ where: { AND: [scoped, { status: 'UNKNOWN', isActive: true }] } }),
        this.db.outgoingMessage.count({ where: { status: 'QUEUED', fromMailbox: scoped } }),
        this.db.outgoingMessage.count({ where: { status: 'PROCESSING', fromMailbox: scoped } }),
        this.db.outgoingMessage.count({ where: { status: 'RETRY_SCHEDULED', fromMailbox: scoped } }),
      ]);
      return { projects, domains, mailboxes, healthyMailboxes, warningMailboxes, errorMailboxes, unknownMailboxes, issueMailboxes: warningMailboxes + errorMailboxes, queuedMessages, processingMessages, retryScheduledMessages, smtpAcceptedToday: 0, failedToday: 0, recentActivity: [], monitoring: { lastCheckedAt: null, criticalIssues: 0, domainWarnings: 0, queueFailures: 0, healthyMailboxes: 0, attentionMailboxes: 0, worker: 'UNKNOWN' } };
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [projects, domains, mailboxes, healthyMailboxes, warningMailboxes, errorMailboxes, unknownMailboxes, queuedMessages, processingMessages, retryScheduledMessages, smtpAcceptedToday, failedToday, recentActivity] = await Promise.all([
      this.db.project.count(), this.db.domain.count(), this.db.mailbox.count(),
      this.db.mailbox.count({ where: { status: 'HEALTHY', isActive: true } }),
      this.db.mailbox.count({ where: { status: 'WARNING', isActive: true } }),
      this.db.mailbox.count({ where: { status: 'ERROR', isActive: true } }),
      this.db.mailbox.count({ where: { status: 'UNKNOWN', isActive: true } }),
      this.db.outgoingMessage.count({ where: { status: 'QUEUED' } }),
      this.db.outgoingMessage.count({ where: { status: 'PROCESSING' } }),
      this.db.outgoingMessage.count({ where: { status: 'RETRY_SCHEDULED' } }),
      this.db.outgoingMessage.count({ where: { status: { in: ['SMTP_ACCEPTED', 'SMTP_ACCEPTED_WITH_REJECTIONS'] }, smtpAcceptedAt: { gte: today } } }),
      this.db.outgoingMessage.count({ where: { status: 'FAILED', failedAt: { gte: today } } }),
      this.db.auditLog.findMany({ take: 8, orderBy: { createdAt: 'desc' }, select: { id: true, action: true, entityType: true, createdAt: true, user: { select: { name: true } } } }),
    ]);
    const lastMonitoringRun = await this.db.monitoringRun.findFirst({ where: { status: { in: ['SUCCESS', 'PARTIAL'] } }, orderBy: { completedAt: 'desc' }, select: { id: true, completedAt: true } });
    const [criticalIssues, domainWarnings, queueFailures, monitoredHealthyMailboxes, monitoredAttentionMailboxes] = await Promise.all([
      this.db.monitoringIssue.count({ where: { status: 'OPEN', severity: 'CRITICAL' } }),
      this.db.monitoringIssue.count({ where: { status: 'OPEN', targetType: 'DOMAIN', severity: 'WARNING' } }),
      this.db.monitoringIssue.count({ where: { status: 'OPEN', targetType: 'QUEUE' } }),
      lastMonitoringRun ? this.db.monitoringResult.count({ where: { runId: lastMonitoringRun.id, targetType: 'MAILBOX', checkType: 'OVERALL', status: 'HEALTHY' } }) : Promise.resolve(0),
      lastMonitoringRun ? this.db.monitoringResult.count({ where: { runId: lastMonitoringRun.id, targetType: 'MAILBOX', checkType: 'OVERALL', status: { in: ['WARNING', 'CRITICAL'] } } }) : Promise.resolve(0),
    ]);
    let worker = 'CRITICAL';
    try {
      const value = await this.redis.client.get('monitor:worker:last');
      const parsed = value ? JSON.parse(value) as { lastHeartbeatAt?: string } : null;
      if (parsed?.lastHeartbeatAt && Date.now() - new Date(parsed.lastHeartbeatAt).getTime() <= Number(process.env.MONITOR_WORKER_HEARTBEAT_SECONDS ?? 90) * 1000) worker = 'HEALTHY';
    } catch { /* live worker status remains critical */ }
    return { projects, domains, mailboxes, healthyMailboxes, warningMailboxes, errorMailboxes, unknownMailboxes, issueMailboxes: warningMailboxes + errorMailboxes, queuedMessages, processingMessages, retryScheduledMessages, smtpAcceptedToday, failedToday, recentActivity, monitoring: { lastCheckedAt: lastMonitoringRun?.completedAt ?? null, criticalIssues, domainWarnings, queueFailures, healthyMailboxes: monitoredHealthyMailboxes, attentionMailboxes: monitoredAttentionMailboxes, worker } };
  }
}
