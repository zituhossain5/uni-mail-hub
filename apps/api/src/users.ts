import { Body, Controller, Get, Header, HttpException, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { Prisma, UserRole } from '@uni/database';
import { z } from 'zod';
import { AuthedRequest, Database, Public, parse } from './core';
import { RequirePermission } from './access';

const id = z.string().cuid();
const role = z.nativeEnum(UserRole);
const email = z.string().trim().email().max(254).transform(value => value.toLowerCase());
const createInput = z.object({ name: z.string().trim().min(1).max(120), email, role, projectIds: z.array(id).max(100).default([]), mailboxIds: z.array(id).max(500).default([]) }).strict();
const patchInput = createInput.partial().refine(value => Object.keys(value).length > 0);
const listInput = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), search: z.string().trim().max(120).optional(), role: role.optional(), status: z.enum(['ACTIVE', 'DISABLED', 'PENDING']).optional() }).strict();
const tokenInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{40,60}$/) }).strict();
const acceptInviteInput = tokenInput.extend({ password: z.string().min(16).max(256), confirmPassword: z.string() }).refine(value => value.password === value.confirmPassword);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const unavailable = () => new HttpException({ code: 'INVITATION_UNAVAILABLE', message: 'Invitation is invalid or expired' }, 400);

@RequirePermission('users.manage')
@Controller('users')
export class UsersController {
  constructor(@Inject(Database) private readonly db: Database) {}

  private assertTarget(actor: AuthedRequest['user'], targetRole: UserRole) {
    if (actor.role !== UserRole.SUPER_ADMIN && (targetRole === UserRole.SUPER_ADMIN || targetRole === UserRole.ADMIN)) throw new HttpException('User cannot be managed by this administrator', 403);
  }
  private async validateAccess(roleValue: UserRole, projects: string[], mailboxes: string[]) {
    if (new Set(projects).size !== projects.length || new Set(mailboxes).size !== mailboxes.length) throw new HttpException('Duplicate grants are not allowed', 400);
    if ((roleValue === UserRole.SUPER_ADMIN || roleValue === UserRole.ADMIN) && (projects.length || mailboxes.length)) throw new HttpException('Global roles do not use explicit grants', 400);
    if (roleValue === UserRole.MANAGER && mailboxes.length) throw new HttpException('Manager mailboxes are scoped by project', 400);
    if (projects.length !== await this.db.project.count({ where: { id: { in: projects } } })) throw new HttpException('Project selection unavailable', 400);
    if (mailboxes.length !== await this.db.mailbox.count({ where: { id: { in: mailboxes }, projectId: { in: projects } } })) throw new HttpException('Mailbox selection unavailable', 400);
  }
  private select() { return { id: true, name: true, email: true, role: true, isActive: true, createdAt: true, updatedAt: true, lastLoginAt: true, projectMemberships: { select: { project: { select: { id: true, name: true } } } }, mailboxGrants: { select: { mailbox: { select: { id: true, email: true, projectId: true } } } }, invitations: { where: { acceptedAt: null }, select: { id: true, expiresAt: true, revokedAt: true }, orderBy: { createdAt: 'desc' }, take: 1 } } as const; }

  @Get()
  async list(@Query() raw: unknown, @Req() request: AuthedRequest) {
    const query = parse(listInput, raw);
    const where: Prisma.UserWhereInput = {
      ...(request.user.role === UserRole.ADMIN ? { role: { in: [UserRole.MANAGER, UserRole.STAFF, UserRole.VIEWER] } } : {}),
      ...(query.search ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { email: { contains: query.search, mode: 'insensitive' } }] } : {}),
      ...(query.role ? { AND: [{ role: query.role }] } : {}),
      ...(query.status === 'PENDING' ? { isActive: false, invitations: { some: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } } } : query.status === 'ACTIVE' ? { isActive: true } : query.status === 'DISABLED' ? { isActive: false, invitations: { none: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } } } : {}),
    };
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [totalItems, items] = await this.db.$transaction([
      this.db.user.count({ where }),
      this.db.user.findMany({ where, select: this.select(), orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return { items, pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) } };
  }

  @Get(':id')
  async get(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const userId = parse(id, rawId);
    const item = await this.db.user.findUnique({ where: { id: userId }, select: { ...this.select(), sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, ipAddress: true, userAgent: true }, orderBy: { createdAt: 'desc' }, take: 50 } } });
    if (!item) throw new HttpException('User not found', 404);
    this.assertTarget(request.user, item.role);
    const activity = await this.db.auditLog.findMany({ where: { OR: [{ userId }, { entityType: 'User', entityId: userId }] }, select: { id: true, action: true, entityType: true, createdAt: true, userId: true }, orderBy: { createdAt: 'desc' }, take: 30 });
    return { ...item, activity };
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'private, no-store')
  async create(@Body() body: unknown, @Req() request: AuthedRequest) {
    const input = parse(createInput, body);
    if (input.role === UserRole.SUPER_ADMIN) throw new HttpException('Super Admin accounts are not created through invitations', 403);
    this.assertTarget(request.user, input.role);
    const projectIds = input.projectIds ?? [];
    const mailboxIds = input.mailboxIds ?? [];
    await this.validateAccess(input.role, projectIds, mailboxIds);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = digest(token);
    const passwordHash = await argon2.hash(randomBytes(32).toString('base64url'));
    const expiresAt = new Date(Date.now() + 48 * 60 * 60_000);
    const origin = process.env.WEB_URL;
    if (!origin) throw new Error('WEB_URL is required');
    const user = await this.db.$transaction(async tx => {
      const created = await tx.user.create({ data: { name: input.name, email: input.email, role: input.role, passwordHash, isActive: false,
        projectMemberships: { create: projectIds.map(projectId => ({ projectId, createdByUserId: request.user.id })) },
        mailboxGrants: { create: mailboxIds.map(mailboxId => ({ mailboxId })) },
        invitations: { create: { tokenHash, expiresAt, createdByUserId: request.user.id } },
      }, select: { id: true, name: true, email: true, role: true, isActive: true } });
      await tx.auditLog.createMany({ data: [
        { userId: request.user.id, action: 'USER_CREATED', entityType: 'User', entityId: created.id, ipAddress: request.ip },
        { userId: request.user.id, action: 'USER_INVITED', entityType: 'User', entityId: created.id, ipAddress: request.ip },
        ...(projectIds.length ? [{ userId: request.user.id, action: 'USER_PROJECT_GRANTED', entityType: 'User', entityId: created.id, ipAddress: request.ip }] : []),
        ...(mailboxIds.length ? [{ userId: request.user.id, action: 'USER_MAILBOX_GRANTED', entityType: 'User', entityId: created.id, ipAddress: request.ip }] : []),
      ] });
      return created;
    });
    return { user, invitation: { expiresAt, url: `${origin.replace(/\/$/, '')}/invite#${token}` } };
  }

  @Patch(':id')
  async update(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const userId = parse(id, rawId);
    const input = parse(patchInput, body);
    const current = await this.db.user.findUnique({ where: { id: userId }, include: { projectMemberships: { select: { projectId: true } }, mailboxGrants: { select: { mailboxId: true } } } });
    if (!current) throw new HttpException('User not found', 404);
    this.assertTarget(request.user, current.role);
    const nextRole = input.role ?? current.role;
    this.assertTarget(request.user, nextRole);
    const projects = input.projectIds ?? current.projectMemberships.map(value => value.projectId);
    const mailboxes = input.mailboxIds ?? current.mailboxGrants.map(value => value.mailboxId);
    await this.validateAccess(nextRole, projects, mailboxes);
    if (current.role === UserRole.SUPER_ADMIN && nextRole !== UserRole.SUPER_ADMIN) throw new HttpException('Super Admin role cannot be removed through user management', 403);
    const previousProjects = new Set(current.projectMemberships.map(value => value.projectId));
    const previousMailboxes = new Set(current.mailboxGrants.map(value => value.mailboxId));
    const addedProjects = projects.filter(value => !previousProjects.has(value));
    const removedProjects = [...previousProjects].filter(value => !projects.includes(value));
    const addedMailboxes = mailboxes.filter(value => !previousMailboxes.has(value));
    const removedMailboxes = [...previousMailboxes].filter(value => !mailboxes.includes(value));
    const grantsChanged = nextRole !== current.role || !!(addedProjects.length || removedProjects.length || addedMailboxes.length || removedMailboxes.length);
    await this.db.$transaction(async tx => {
      await tx.user.update({ where: { id: userId }, data: { name: input.name, email: input.email, role: input.role } });
      if (grantsChanged) {
        await tx.projectMember.deleteMany({ where: { userId } });
        await tx.userMailboxAccess.deleteMany({ where: { userId } });
        if (projects.length) await tx.projectMember.createMany({ data: projects.map(projectId => ({ userId, projectId, createdByUserId: request.user.id })) });
        if (mailboxes.length) await tx.userMailboxAccess.createMany({ data: mailboxes.map(mailboxId => ({ userId, mailboxId })) });
        await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      const actions = ['USER_UPDATED', ...(nextRole !== current.role ? ['USER_ROLE_CHANGED'] : []), ...(addedProjects.length ? ['USER_PROJECT_GRANTED'] : []), ...(removedProjects.length ? ['USER_PROJECT_REVOKED'] : []), ...(addedMailboxes.length ? ['USER_MAILBOX_GRANTED'] : []), ...(removedMailboxes.length ? ['USER_MAILBOX_REVOKED'] : [])];
      await tx.auditLog.createMany({ data: actions.map(action => ({ userId: request.user.id, action, entityType: 'User', entityId: userId, ipAddress: request.ip })) });
    });
    return this.get(userId, request);
  }

  private async setActive(rawId: string, active: boolean, request: AuthedRequest) {
    const userId = parse(id, rawId);
    const target = await this.db.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true } });
    if (!target) throw new HttpException('User not found', 404);
    this.assertTarget(request.user, target.role);
    if (active && !target.isActive && await this.db.userInvitation.count({ where: { userId } }) && !await this.db.userInvitation.count({ where: { userId, acceptedAt: { not: null } } })) throw new HttpException('Invitation must be accepted before the account can be enabled', 409);
    if (userId === request.user.id && !active) throw new HttpException('You cannot disable your own account', 403);
    if (target.role === UserRole.SUPER_ADMIN && !active) throw new HttpException('Super Admin accounts cannot be disabled here', 403);
    await this.db.$transaction(async tx => {
      await tx.user.update({ where: { id: userId }, data: { isActive: active } });
      let invitationsRevoked = 0;
      if (!active) {
        await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        invitationsRevoked = (await tx.userInvitation.updateMany({ where: { userId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } })).count;
      }
      await tx.auditLog.createMany({ data: [
        { userId: request.user.id, action: active ? 'USER_ENABLED' : 'USER_DISABLED', entityType: 'User', entityId: userId, ipAddress: request.ip },
        ...(invitationsRevoked ? [{ userId: request.user.id, action: 'INVITE_REVOKED', entityType: 'User', entityId: userId, ipAddress: request.ip }] : []),
      ] });
    });
    return { success: true };
  }
  @Post(':id/disable') disable(@Param('id') rawId: string, @Req() request: AuthedRequest) { return this.setActive(rawId, false, request); }
  @Post(':id/enable') enable(@Param('id') rawId: string, @Req() request: AuthedRequest) { return this.setActive(rawId, true, request); }

  @Post(':id/revoke-sessions')
  async revokeSessions(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const userId = parse(id, rawId);
    const target = await this.db.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!target) throw new HttpException('User not found', 404);
    this.assertTarget(request.user, target.role);
    const result = await this.db.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.db.auditLog.create({ data: { userId: request.user.id, action: 'USER_SESSIONS_REVOKED', entityType: 'User', entityId: userId, ipAddress: request.ip } });
    return { revoked: result.count };
  }

  @Post(':id/reinvite')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Header('Cache-Control', 'private, no-store')
  async reinvite(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const userId = parse(id, rawId);
    const target = await this.db.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true, invitations: { where: { acceptedAt: null }, select: { id: true }, take: 1 } } });
    if (!target) throw new HttpException('User not found', 404);
    this.assertTarget(request.user, target.role);
    if (target.isActive || !target.invitations.length) throw new HttpException('Only invited accounts can receive a new link', 409);
    const origin = process.env.WEB_URL;
    if (!origin) throw new Error('WEB_URL is required');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60_000);
    await this.db.$transaction(async tx => {
      await tx.userInvitation.updateMany({ where: { userId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.userInvitation.create({ data: { userId, tokenHash: digest(token), expiresAt, createdByUserId: request.user.id } });
      await tx.auditLog.createMany({ data: [
        { userId: request.user.id, action: 'INVITE_REVOKED', entityType: 'User', entityId: userId, ipAddress: request.ip },
        { userId: request.user.id, action: 'USER_INVITED', entityType: 'User', entityId: userId, ipAddress: request.ip },
      ] });
    });
    return { invitation: { expiresAt, url: `${origin.replace(/\/$/, '')}/invite#${token}` } };
  }
}

@Controller('invitations')
export class InvitationsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Public() @Post('inspect')
  @Throttle({ default: { limit: 10, ttl: 60_000, blockDuration: 60_000 } })
  @Header('Cache-Control', 'private, no-store')
  async inspect(@Body() body: unknown) {
    const { token } = parse(tokenInput, body);
    const invite = await this.db.userInvitation.findUnique({ where: { tokenHash: digest(token) }, select: { expiresAt: true, acceptedAt: true, revokedAt: true, user: { select: { name: true, email: true, isActive: true } } } });
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= new Date() || invite.user.isActive) throw unavailable();
    return { name: invite.user.name, email: invite.user.email, expiresAt: invite.expiresAt };
  }
  @Public() @Post('accept')
  @Throttle({ default: { limit: 5, ttl: 60_000, blockDuration: 60_000 } })
  async accept(@Body() body: unknown, @Req() request: AuthedRequest) {
    const input = parse(acceptInviteInput, body);
    const token = input.token;
    const tokenHash = digest(token);
    const passwordHash = await argon2.hash(input.password);
    await this.db.$transaction(async tx => {
      const invite = await tx.userInvitation.findUnique({ where: { tokenHash }, select: { id: true, userId: true, expiresAt: true, acceptedAt: true, revokedAt: true, user: { select: { isActive: true } } } });
      if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= new Date() || invite.user.isActive) throw unavailable();
      const changed = await tx.userInvitation.updateMany({ where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date() } });
      if (changed.count !== 1) throw unavailable();
      await tx.user.update({ where: { id: invite.userId }, data: { passwordHash, isActive: true } });
      await tx.auditLog.create({ data: { userId: invite.userId, action: 'INVITE_ACCEPTED', entityType: 'User', entityId: invite.userId, ipAddress: request.ip } });
    });
    return { success: true };
  }
}
