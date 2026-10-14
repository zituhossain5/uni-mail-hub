import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { UserRole } from '../packages/database/generated/client';
import { AccessPolicy, can, mailboxWhere, projectWhere } from '../apps/api/dist/access.js';
import { AuthGuard } from '../apps/api/dist/core.js';
import { UsersController } from '../apps/api/dist/users.js';
import { MailSearchController } from '../apps/api/dist/mail-search.js';
import { AdminMessagesController } from '../apps/api/dist/sending.js';
import { ProjectsController } from '../apps/api/dist/registry.js';
import { MailServersController } from '../apps/api/dist/mail-servers.js';

const user = (role: UserRole, id = 'person') => ({ id, role, email: 'synthetic@example.invalid', name: 'Synthetic', sessionId: 'session' });

test('role matrix keeps Viewer read only and global administration restricted', () => {
  assert.equal(can(UserRole.SUPER_ADMIN, 'system.manage'), true);
  assert.equal(can(UserRole.ADMIN, 'users.manage'), true);
  assert.equal(can(UserRole.ADMIN, 'system.manage'), false);
  assert.equal(can(UserRole.MANAGER, 'mail.sync'), true);
  assert.equal(can(UserRole.MANAGER, 'users.manage'), false);
  assert.equal(can(UserRole.STAFF, 'mail.write'), true);
  assert.equal(can(UserRole.STAFF, 'mailbox.manage'), false);
  assert.equal(can(UserRole.VIEWER, 'mail.read'), true);
  for (const action of ['mail.write', 'mail.sync', 'projects.manage', 'users.manage', 'outgoing.retry'] as const) assert.equal(can(UserRole.VIEWER, action), false);
});

test('project and mailbox query filters require grants at database level', () => {
  assert.deepEqual(projectWhere(user(UserRole.ADMIN)), {});
  assert.deepEqual(projectWhere(user(UserRole.MANAGER)), { members: { some: { userId: 'person' } } });
  assert.deepEqual(mailboxWhere(user(UserRole.MANAGER)), { project: { members: { some: { userId: 'person' } } } });
  const restricted = { project: { members: { some: { userId: 'person' } } }, userGrants: { some: { userId: 'person' } } };
  assert.deepEqual(mailboxWhere(user(UserRole.STAFF)), restricted);
  assert.deepEqual(mailboxWhere(user(UserRole.VIEWER)), restricted);
});

test('direct mailbox ID is rejected before message or attachment handlers run', async () => {
  const db = {
    userSession: { findUnique: async () => ({ userId: 'person', expiresAt: new Date(Date.now() + 60000), revokedAt: null, lastUsedAt: new Date() }) },
    user: { findUnique: async () => ({ id: 'person', role: UserRole.STAFF, email: 'synthetic@example.invalid', name: 'Synthetic', isActive: true }) },
    mailbox: { findFirst: async ({ where }: { where: { id: string; project: unknown; userGrants: unknown } }) => { assert.equal(where.id, 'foreign-mailbox'); assert.ok(where.project); assert.ok(where.userGrants); return null; } },
  };
  const reflector = { getAllAndOverride: (key: string) => key === 'permission' ? 'mail.read' : false };
  const jwt = { verifyAsync: async () => ({ sub: 'person', sid: 'session' }) };
  const guard = new AuthGuard(reflector as never, jwt as never, db as never);
  const request = { headers: { authorization: 'Bearer synthetic' }, params: { mailboxId: 'foreign-mailbox', messageId: 'foreign-message', attachmentId: 'foreign-attachment' } };
  const context = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => request }) };
  await assert.rejects(guard.canActivate(context as never), { name: 'ForbiddenException' });
});

test('disabled users and revoked sessions cannot authorize requests', async () => {
  const reflector = { getAllAndOverride: () => false };
  const jwt = { verifyAsync: async () => ({ sub: 'person', sid: 'session' }) };
  const request = { headers: { authorization: 'Bearer synthetic' }, params: {} };
  const context = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => request }) };
  const db = { userSession: { findUnique: async () => ({ userId: 'person', expiresAt: new Date(Date.now() + 60000), revokedAt: null, lastUsedAt: new Date() }) }, user: { findUnique: async () => ({ id: 'person', role: UserRole.VIEWER, email: 'synthetic@example.invalid', name: 'Synthetic', isActive: false }) } };
  await assert.rejects(new AuthGuard(reflector as never, jwt as never, db as never).canActivate(context as never), { name: 'UnauthorizedException' });
  db.userSession.findUnique = async () => ({ userId: 'person', expiresAt: new Date(Date.now() + 60000), revokedAt: new Date(), lastUsedAt: new Date() });
  await assert.rejects(new AuthGuard(reflector as never, jwt as never, db as never).canActivate(context as never), { name: 'UnauthorizedException' });
});

test('resource assertions use scoped records and reject unknown project and mailbox IDs', async () => {
  const db = { project: { findFirst: async ({ where }: { where: { id: string; members: unknown } }) => { assert.equal(where.id, 'foreign-project'); assert.ok(where.members); return null; } }, mailbox: { findFirst: async ({ where }: { where: { id: string; project: unknown; userGrants: unknown } }) => { assert.equal(where.id, 'foreign-mailbox'); assert.ok(where.project); assert.ok(where.userGrants); return null; } } };
  const policy = new AccessPolicy(db as never);
  await assert.rejects(policy.project(user(UserRole.STAFF), 'foreign-project'), { name: 'ForbiddenException' });
  await assert.rejects(policy.mailbox(user(UserRole.STAFF), 'foreign-mailbox'), { name: 'ForbiddenException' });
});

test('Viewer can read only granted mailboxes and cannot invoke mail mutations', async () => {
  let checked = 0;
  const db = {
    userSession: { findUnique: async () => ({ userId: 'person', expiresAt: new Date(Date.now() + 60_000), revokedAt: null, lastUsedAt: new Date() }) },
    user: { findUnique: async () => ({ id: 'person', role: UserRole.VIEWER, email: 'synthetic@example.invalid', name: 'Synthetic', isActive: true }) },
    mailbox: { findFirst: async ({ where }: { where: { id: string; project: unknown; userGrants: unknown } }) => { checked++; assert.ok(where.project); assert.ok(where.userGrants); return where.id === 'granted' ? { id: 'granted' } : null; } },
  };
  let permission = 'mail.read';
  const reflector = { getAllAndOverride: (key: string) => key === 'permission' ? permission : false };
  const jwt = { verifyAsync: async () => ({ sub: 'person', sid: 'session' }) };
  const guard = new AuthGuard(reflector as never, jwt as never, db as never);
  const request = { headers: { authorization: 'Bearer synthetic' }, params: { mailboxId: 'granted', messageId: 'known' } };
  const context = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => request }) };
  assert.equal(await guard.canActivate(context as never), true);
  permission = 'mail.write';
  await assert.rejects(guard.canActivate(context as never), { name: 'ForbiddenException' });
  permission = 'mail.read';
  request.params.mailboxId = 'ungranted';
  await assert.rejects(guard.canActivate(context as never), { name: 'ForbiddenException' });
  assert.equal(checked, 2);
});

test('project detail and outgoing message ID queries keep the actor scope in SQL filters', async () => {
  const projectId = 'ckv00000000000000000000001';
  const outgoingId = 'ckv00000000000000000000002';
  let projectScoped = false;
  let outgoingScoped = false;
  const db = {
    project: {
      findFirst: async ({ where }: { where: { id: string; members: unknown } }) => { projectScoped = true; assert.equal(where.id, projectId); assert.ok(where.members); return { id: projectId }; },
      findUnique: async ({ include }: { include: { mailboxes: { where: { userGrants: unknown } } } }) => { assert.ok(include.mailboxes.where.userGrants); return { id: projectId, mailboxes: [] }; },
    },
    outgoingMessage: { findFirst: async ({ where }: { where: { id: string; fromMailbox: { project: unknown; userGrants: unknown } } }) => { outgoingScoped = true; assert.equal(where.id, outgoingId); assert.ok(where.fromMailbox.project); assert.ok(where.fromMailbox.userGrants); return null; } },
  };
  await new ProjectsController(db as never).get(projectId, { user: user(UserRole.STAFF) } as never);
  await assert.rejects(new AdminMessagesController(db as never, {} as never).get(outgoingId, { user: user(UserRole.STAFF) } as never), { status: 404 });
  assert.equal(projectScoped && outgoingScoped, true);
});

test('search applies project and mailbox grants inside the database query', async () => {
  const db = { $queryRaw: async (query: { sql: string }) => {
    assert.match(query.sql, /FROM "ProjectMember" pm/);
    assert.match(query.sql, /FROM "UserMailboxAccess" ma/);
    return [];
  } };
  const result = await new MailSearchController(db as never).search({}, { user: user(UserRole.STAFF) } as never);
  assert.deepEqual(result, { items: [], nextCursor: null });
});

test('Manager server choices expose only safe identifiers and names', async () => {
  const db = { mailServer: { findMany: async ({ select }: { select: Record<string, boolean> }) => {
    assert.deepEqual(select, { id: true, name: true, status: true });
    return [{ id: 'server', name: 'Synthetic server', status: 'ACTIVE' }];
  } } };
  assert.equal(can(UserRole.MANAGER, 'mailbox.manage'), true);
  assert.equal(Reflect.getMetadata('permission', MailServersController.prototype.options), 'mailbox.manage');
  assert.deepEqual(await new MailServersController(db as never).options(), [{ id: 'server', name: 'Synthetic server', status: 'ACTIVE' }]);
});

test('Admin cannot create or modify Super Admin and Admin accounts', async () => {
  const targetId = 'ckv00000000000000000000000';
  const db = { user: { findUnique: async () => ({ id: 'target', role: UserRole.SUPER_ADMIN, projectMemberships: [], mailboxGrants: [] }) } };
  const controller = new UsersController(db as never);
  const actor = { user: user(UserRole.ADMIN), ip: '127.0.0.1' };
  await assert.rejects(controller.create({ name: 'Synthetic', email: 'synthetic@example.invalid', role: UserRole.ADMIN }, actor as never), { status: 403 });
  await assert.rejects(controller.update(targetId, { name: 'Changed' }, actor as never), { status: 403 });
  await assert.rejects(controller.disable(targetId, actor as never), { status: 403 });
});

test('new invitations persist only a token hash and create an inactive account', async () => {
  let storedHash = '';
  const db = {
    project: { count: async () => 0 }, mailbox: { count: async () => 0 },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      user: { create: async ({ data }: { data: { isActive: boolean; passwordHash: string; invitations: { create: { tokenHash: string } } } }) => {
        assert.equal(data.isActive, false);
        assert.match(data.passwordHash, /^\$argon2/);
        storedHash = data.invitations.create.tokenHash;
        return { id: 'invited', name: 'Synthetic', email: 'synthetic@example.invalid', role: UserRole.STAFF, isActive: false };
      } },
      auditLog: { createMany: async () => ({}) },
    }),
  };
  const oldUrl = process.env.WEB_URL;
  process.env.WEB_URL = 'https://mailhub.example.invalid';
  try {
    const result = await new UsersController(db as never).create({ name: 'Synthetic', email: 'synthetic@example.invalid', role: UserRole.STAFF, projectIds: [], mailboxIds: [] }, { user: user(UserRole.SUPER_ADMIN), ip: '127.0.0.1' } as never);
    const token = result.invitation.url.split('#')[1]!;
    assert.equal(result.invitation.url.split('#')[0], 'https://mailhub.example.invalid/invite');
    assert.equal(storedHash, createHash('sha256').update(token).digest('hex'));
    assert.equal(storedHash.includes(token), false);
  } finally { if (oldUrl === undefined) delete process.env.WEB_URL; else process.env.WEB_URL = oldUrl; }
});
