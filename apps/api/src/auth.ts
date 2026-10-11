import { Body, Controller, Get, Header, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { loginSchema } from '@uni/shared';
import { AuthedRequest, Database, Public, parse } from './core';
import { consumeSecondFactor } from './security-auth';

const loginWithCodeSchema = loginSchema.extend({ code: z.string().trim().min(6).max(64).optional() });
const dummyHash = argon2.hash(randomBytes(32).toString('hex'));

@Controller('auth')
export class AuthController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(JwtService) private readonly jwt: JwtService) {}

  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000, blockDuration: 60_000 } })
  @Post('login')
  async login(@Body() body: unknown, @Req() request: AuthedRequest) {
    const { email, password, code } = parse(loginWithCodeSchema, body);
    const user = await this.db.user.findUnique({ where: { email: email.toLowerCase() }, include: { security: true } });
    const validPassword = await argon2.verify(user?.passwordHash ?? await dummyHash, password);
    if (!user?.isActive || !validPassword) {
      await this.db.auditLog.create({ data: { action: 'LOGIN_FAILURE', entityType: 'User', ipAddress: request.ip } });
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.security?.totpEnabledAt) {
      if (!code) return { requiresTwoFactor: true };
      if (!(await consumeSecondFactor(this.db, user.id, code, user.security))) {
        await this.db.auditLog.create({ data: { action: 'LOGIN_FAILURE', entityType: 'User', ipAddress: request.ip } });
        throw new UnauthorizedException('Invalid credentials');
      }
    }
    const session = await this.db.$transaction(async tx => {
      const created = await tx.userSession.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 8 * 60 * 60_000), ipAddress: request.ip, userAgent: request.headers['user-agent']?.slice(0, 300) } });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await tx.auditLog.create({ data: { userId: user.id, action: 'LOGIN_SUCCESS', entityType: 'UserSession', entityId: created.id, ipAddress: request.ip } });
      return created;
    });
    const token = await this.jwt.signAsync({ sub: user.id, sid: session.id }, { expiresIn: '8h' });
    return { token, requiresTwoFactorSetup: process.env.NODE_ENV === 'production' && process.env.PRODUCTION_2FA_BOOTSTRAP === 'true' && user.role === 'SUPER_ADMIN' && !user.security?.totpEnabledAt, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }

  @Get('me')
  me(@Req() request: AuthedRequest) { return request.user; }

  @Post('logout')
  async logout(@Req() request: AuthedRequest) {
    await this.db.userSession.updateMany({ where: { id: request.user.sessionId, userId: request.user.id }, data: { revokedAt: new Date() } });
    await this.db.auditLog.create({ data: { userId: request.user.id, action: 'LOGOUT', entityType: 'UserSession', entityId: request.user.sessionId, ipAddress: request.ip } });
    return { success: true };
  }
}
