import { ForbiddenException, SetMetadata } from '@nestjs/common';
import { Prisma, UserRole } from '@uni/database';
import type { Database, AuthUser } from './core';

export type Permission = 'users.manage' | 'projects.read' | 'projects.manage' | 'mailbox.manage' | 'mail.read' | 'mail.write' | 'mail.sync' | 'outgoing.read' | 'outgoing.retry' | 'monitoring.read' | 'monitoring.run' | 'system.manage';
export const RequirePermission = (permission: Permission) => SetMetadata('permission', permission);

const global = (role: UserRole) => role === UserRole.SUPER_ADMIN || role === UserRole.ADMIN;
export function can(role: UserRole, permission: Permission): boolean {
  if (role === UserRole.SUPER_ADMIN) return true;
  if (permission === 'system.manage') return false;
  if (permission === 'users.manage' || permission === 'projects.manage' || permission === 'monitoring.run' || permission === 'outgoing.retry') return role === UserRole.ADMIN;
  if (role === UserRole.ADMIN) return true;
  if (permission === 'projects.read' || permission === 'mail.read' || permission === 'outgoing.read' || permission === 'monitoring.read') return [UserRole.MANAGER, UserRole.STAFF, UserRole.VIEWER].includes(role);
  if (permission === 'mail.write') return role === UserRole.MANAGER || role === UserRole.STAFF;
  if (permission === 'mail.sync') return role === UserRole.MANAGER;
  if (permission === 'mailbox.manage') return role === UserRole.MANAGER;
  return false;
}

export function projectWhere(user: AuthUser): Prisma.ProjectWhereInput {
  return global(user.role) ? {} : { members: { some: { userId: user.id } } };
}

export function mailboxWhere(user: AuthUser): Prisma.MailboxWhereInput {
  if (global(user.role)) return {};
  const project = { members: { some: { userId: user.id } } };
  return user.role === UserRole.MANAGER ? { project } : { project, userGrants: { some: { userId: user.id } } };
}

export class AccessPolicy {
  constructor(private readonly db: Database) {}
  assertRole(user: AuthUser, permission: Permission) {
    if (!can(user.role, permission)) throw new ForbiddenException();
  }
  async project(user: AuthUser, id: string, permission: Permission = 'projects.read') {
    this.assertRole(user, permission);
    if (!await this.db.project.findFirst({ where: { id, ...projectWhere(user) }, select: { id: true } })) throw new ForbiddenException();
  }
  async mailbox(user: AuthUser, id: string, permission: Permission = 'mail.read') {
    this.assertRole(user, permission);
    if (!await this.db.mailbox.findFirst({ where: { id, ...mailboxWhere(user) }, select: { id: true } })) throw new ForbiddenException();
  }
}
