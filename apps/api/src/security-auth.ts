import { Body, Controller, Get, Header, HttpException, Inject, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import argon2 from 'argon2';
import { z } from 'zod';
import { AuthedRequest, Database, parse } from './core';

const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(16).max(256) }).strict();
const idSchema = z.string().cuid();

@Controller('auth')
export class SecurityAuthController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get('security')
  @Header('Cache-Control', 'private, no-store')
  async status(@Req() request: AuthedRequest) {
    const userId = request.user.id;
    const [user, sessions] = await Promise.all([
      this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { lastLoginAt: true } }),
      this.db.userSession.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, ipAddress: true, userAgent: true }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return { lastLoginAt: user.lastLoginAt, sessions: sessions.map(session => ({ ...session, current: session.id === request.user.sessionId })) };
  }

  @Post('password/change')
  @Throttle({ default: { limit: 3, ttl: 60_000, blockDuration: 60_000 } })
  async changePassword(@Req() request: AuthedRequest, @Body() body: unknown) {
    const { currentPassword, newPassword } = parse(changePasswordSchema, body);
    if (currentPassword === newPassword) throw new HttpException({ code: 'PASSWORD_REUSE', message: 'Choose a different password' }, 400);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: request.user.id } });
    if (!(await argon2.verify(user.passwordHash, currentPassword))) throw new UnauthorizedException('Invalid credentials');
    const passwordHash = await argon2.hash(newPassword);
    await this.db.$transaction(async tx => {
      const updated = await tx.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash }, data: { passwordHash } });
      if (updated.count !== 1) throw new UnauthorizedException('Invalid credentials');
      await tx.userSession.updateMany({ where: { userId: user.id, id: { not: request.user.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: user.id, action: 'USER_PASSWORD_CHANGED', entityType: 'User', entityId: user.id, ipAddress: request.ip } });
    });
    return { success: true };
  }

  @Post('sessions/revoke-others')
  async revokeOthers(@Req() request: AuthedRequest) {
    const result = await this.db.userSession.updateMany({ where: { userId: request.user.id, id: { not: request.user.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.db.auditLog.create({ data: { userId: request.user.id, action: 'OTHER_SESSIONS_REVOKED', entityType: 'User', entityId: request.user.id, ipAddress: request.ip } });
    return { revoked: result.count };
  }

  @Post('sessions/:id/revoke')
  async revoke(@Req() request: AuthedRequest, @Param('id') rawId: string) {
    const id = parse(idSchema, rawId);
    const result = await this.db.userSession.updateMany({ where: { id, userId: request.user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (result.count) await this.db.auditLog.create({ data: { userId: request.user.id, action: 'SESSION_REVOKED', entityType: 'UserSession', entityId: id, ipAddress: request.ip } });
    return { revoked: result.count, current: id === request.user.sessionId };
  }
}
