import { Body, Controller, Delete, Get, HttpException, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { domainSchema, mailboxSchema, projectSchema } from '@uni/shared';
import { z } from 'zod';
import { AuthedRequest, Database, SuperAdmin, parse } from './core';

const idSchema = z.string().cuid();
const projectPatch = projectSchema.partial().refine((value) => Object.keys(value).length > 0);
const domainPatch = domainSchema.partial().refine((value) => Object.keys(value).length > 0);
const mailboxPatch = mailboxSchema.partial().refine((value) => Object.keys(value).length > 0);

function ensureUnverifiedDomainStatus(status?: string) {
  if (status && status !== 'UNVERIFIED' && status !== 'DISABLED') throw new HttpException({ code: 'STATUS_NOT_VERIFIED', message: 'DNS verification is not available yet' }, 400);
}
function ensureUnverifiedMailboxStatus(status?: string) {
  if (status && status !== 'UNKNOWN' && status !== 'DISABLED') throw new HttpException({ code: 'STATUS_NOT_CHECKED', message: 'Mailbox health checks are not available yet' }, 400);
}

async function audit(db: Database, request: AuthedRequest, action: string, entityType: string, entityId: string) {
  await db.auditLog.create({ data: { userId: request.user.id, action, entityType, entityId, ipAddress: request.ip } });
}

@SuperAdmin()
@Controller('projects')
export class ProjectsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get() list() { return this.db.project.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { domains: true, mailboxes: true } } } }); }
  @Get(':id') async get(@Param('id') rawId: string) {
    const id = parse(idSchema, rawId);
    const item = await this.db.project.findUnique({ where: { id }, include: { domains: true, mailboxes: true, _count: { select: { domains: true, mailboxes: true } } } });
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
@Controller('domains')
export class DomainsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get() list() { return this.db.domain.findMany({ orderBy: { createdAt: 'desc' }, include: { project: { select: { id: true, name: true } }, _count: { select: { mailboxes: true } } } }); }
  @Get(':id') async get(@Param('id') rawId: string) {
    const item = await this.db.domain.findUnique({ where: { id: parse(idSchema, rawId) }, include: { project: true, mailboxes: true } });
    if (!item) throw new HttpException('Domain not found', 404);
    return item;
  }
  @Post() async create(@Body() body: unknown, @Req() request: AuthedRequest) {
    const input = parse(domainSchema, body);
    ensureUnverifiedDomainStatus(input.status);
    const item = await this.db.domain.create({ data: input });
    await audit(this.db, request, 'domain.created', 'Domain', item.id);
    return item;
  }
  @Patch(':id') async update(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    const input = parse(domainPatch, body);
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
    await this.db.domain.delete({ where: { id } });
    await audit(this.db, request, 'domain.deleted', 'Domain', id);
    return { deleted: true };
  }
}

@SuperAdmin()
@Controller('mailboxes')
export class MailboxesController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get() list() { return this.db.mailbox.findMany({ orderBy: { createdAt: 'desc' }, include: { project: { select: { id: true, name: true } }, domain: { select: { id: true, domain: true } } } }); }
  @Get(':id') async get(@Param('id') rawId: string) {
    const item = await this.db.mailbox.findUnique({ where: { id: parse(idSchema, rawId) }, include: { project: true, domain: true, mailServer: true } });
    if (!item) throw new HttpException('Mailbox not found', 404);
    return item;
  }
  private async checkRelations(input: { projectId: string; domainId: string; email: string; mailServerId?: string | null }) {
    const domain = await this.db.domain.findUnique({ where: { id: input.domainId } });
    if (!domain || domain.projectId !== input.projectId) throw new HttpException({ code: 'INVALID_RELATION', message: 'Domain must belong to the selected project' }, 400);
    if (!input.email.endsWith(`@${domain.domain}`)) throw new HttpException({ code: 'INVALID_RELATION', message: 'Mailbox email must use the selected domain' }, 400);
    if (input.mailServerId && !(await this.db.mailServer.findUnique({ where: { id: input.mailServerId } }))) throw new HttpException({ code: 'INVALID_RELATION', message: 'Mail server not found' }, 400);
  }
  @Post() async create(@Body() body: unknown, @Req() request: AuthedRequest) {
    const input = parse(mailboxSchema, body);
    ensureUnverifiedMailboxStatus(input.status);
    await this.checkRelations(input);
    const item = await this.db.mailbox.create({ data: input });
    await audit(this.db, request, 'mailbox.created', 'Mailbox', item.id);
    return item;
  }
  @Patch(':id') async update(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    const input = parse(mailboxPatch, body);
    ensureUnverifiedMailboxStatus(input.status);
    const existing = await this.db.mailbox.findUnique({ where: { id } });
    if (!existing) throw new HttpException('Mailbox not found', 404);
    await this.checkRelations({ projectId: input.projectId ?? existing.projectId, domainId: input.domainId ?? existing.domainId, email: input.email ?? existing.email, mailServerId: input.mailServerId ?? existing.mailServerId });
    const item = await this.db.mailbox.update({ where: { id }, data: input });
    await audit(this.db, request, 'mailbox.updated', 'Mailbox', item.id);
    return item;
  }
  @Delete(':id') async remove(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const id = parse(idSchema, rawId);
    await this.db.mailbox.delete({ where: { id } });
    await audit(this.db, request, 'mailbox.deleted', 'Mailbox', id);
    return { deleted: true };
  }
}

@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get() async get() {
    const [projects, domains, mailboxes, healthyMailboxes, issueMailboxes, recentActivity] = await Promise.all([
      this.db.project.count(), this.db.domain.count(), this.db.mailbox.count(),
      this.db.mailbox.count({ where: { status: 'HEALTHY', isActive: true } }),
      this.db.mailbox.count({ where: { status: { in: ['WARNING', 'ERROR'] }, isActive: true } }),
      this.db.auditLog.findMany({ take: 8, orderBy: { createdAt: 'desc' }, select: { id: true, action: true, entityType: true, createdAt: true, user: { select: { name: true } } } }),
    ]);
    return { projects, domains, mailboxes, healthyMailboxes, issueMailboxes, recentActivity };
  }
}
