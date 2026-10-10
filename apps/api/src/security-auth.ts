import { Body, Controller, Get, Header, HttpException, Inject, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@uni/database';
import { decodeEncryptionKey, decryptSecret, encryptSecret } from '@uni/security';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { z } from 'zod';
import { AuthedRequest, Database, parse } from './core';

const otpSchema = z.object({ code: z.string().trim().min(6).max(64) }).strict();
const confirmationSchema = otpSchema.extend({ password: z.string().min(1) });
const passwordSchema = z.object({ password: z.string().min(1) }).strict();
const idSchema = z.string().cuid();
const encryptionKey = () => decodeEncryptionKey(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY ?? '');
const hashCode = (value: string) => createHash('sha256').update(value.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
const makeCodes = () => Array.from({ length: 10 }, () => randomBytes(12).toString('hex').toUpperCase());

type Factor = { totpSecretCiphertext: string | null; totpSecretIv: string | null; totpSecretTag: string | null; lastTotpStep: number | null };
export async function consumeSecondFactor(db: Database, userId: string, code: string, factor: Factor): Promise<boolean> {
  if (/^\d{6}$/.test(code) && factor.totpSecretCiphertext && factor.totpSecretIv && factor.totpSecretTag) {
    const secret = decryptSecret({ encryptedPassword: factor.totpSecretCiphertext, encryptionIv: factor.totpSecretIv, encryptionAuthTag: factor.totpSecretTag, encryptionVersion: 1 }, encryptionKey());
    const delta = authenticator.checkDelta(code, secret);
    if (delta !== null) {
      const step = Math.floor(Date.now() / 30_000) + delta;
      const updated = await db.userSecurity.updateMany({ where: { userId, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] }, data: { lastTotpStep: step } });
      return updated.count === 1;
    }
  }
  const removed = await db.recoveryCode.deleteMany({ where: { userId, codeHash: hashCode(code) } });
  if (removed.count === 1) {
    await db.auditLog.create({ data: { userId, action: 'RECOVERY_CODE_USED', entityType: 'User', entityId: userId } });
    return true;
  }
  return false;
}

@Controller('auth')
export class SecurityAuthController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get('security')
  @Header('Cache-Control', 'private, no-store')
  async status(@Req() request: AuthedRequest) {
    const userId = request.user.id;
    const [user, factor, count, sessions] = await Promise.all([
      this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { lastLoginAt: true } }),
      this.db.userSecurity.findUnique({ where: { userId }, select: { totpEnabledAt: true } }),
      this.db.recoveryCode.count({ where: { userId } }),
      this.db.userSession.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, ipAddress: true, userAgent: true }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return { twoFactorEnabled: !!factor?.totpEnabledAt, recoveryCodeCount: count, lastLoginAt: user.lastLoginAt, sessions: sessions.map(session => ({ ...session, current: session.id === request.user.sessionId })) };
  }

  @Post('2fa/setup')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async setup(@Req() request: AuthedRequest, @Body() body: unknown) {
    if (request.user.role !== UserRole.SUPER_ADMIN) throw new HttpException({ code: 'FORBIDDEN', message: 'Administrator account required' }, 403);
    const userId = request.user.id;
    const { password } = parse(passwordSchema, body);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
    if (!(await argon2.verify(user.passwordHash, password))) throw new UnauthorizedException('Invalid credentials');
    const existing = await this.db.userSecurity.findUnique({ where: { userId } });
    if (existing?.totpEnabledAt) throw new HttpException({ code: 'TWO_FACTOR_ENABLED', message: 'Two-factor authentication is already enabled' }, 409);
    const secret = authenticator.generateSecret();
    const encrypted = encryptSecret(secret, encryptionKey());
    const pending = { pendingTotpCiphertext: encrypted.encryptedPassword, pendingTotpIv: encrypted.encryptionIv, pendingTotpTag: encrypted.encryptionAuthTag, pendingTotpExpiresAt: new Date(Date.now() + 10 * 60_000) };
    await this.db.userSecurity.upsert({ where: { userId }, create: { userId, ...pending }, update: pending });
    const otpauthUri = authenticator.keyuri(request.user.email, 'Uni Mail Hub', secret);
    return { secret, otpauthUri, qrCodeDataUrl: await QRCode.toDataURL(otpauthUri) };
  }

  @Post('2fa/verify')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000, blockDuration: 60_000 } })
  async verify(@Req() request: AuthedRequest, @Body() body: unknown) {
    const { code } = parse(otpSchema, body);
    const userId = request.user.id;
    const factor = await this.db.userSecurity.findUnique({ where: { userId } });
    if (!factor?.pendingTotpCiphertext || !factor.pendingTotpIv || !factor.pendingTotpTag || !factor.pendingTotpExpiresAt || factor.pendingTotpExpiresAt <= new Date() || factor.totpEnabledAt) throw new HttpException({ code: 'TWO_FACTOR_SETUP_EXPIRED', message: 'Start setup again' }, 400);
    const secret = decryptSecret({ encryptedPassword: factor.pendingTotpCiphertext, encryptionIv: factor.pendingTotpIv, encryptionAuthTag: factor.pendingTotpTag, encryptionVersion: 1 }, encryptionKey());
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) throw new HttpException({ code: 'INVALID_VERIFICATION_CODE', message: 'Invalid verification code' }, 400);
    const encrypted = encryptSecret(secret, encryptionKey());
    const codes = makeCodes();
    await this.db.$transaction(async tx => {
      const result = await tx.userSecurity.updateMany({ where: { userId, totpEnabledAt: null, pendingTotpExpiresAt: { gt: new Date() } }, data: { totpSecretCiphertext: encrypted.encryptedPassword, totpSecretIv: encrypted.encryptionIv, totpSecretTag: encrypted.encryptionAuthTag, totpEnabledAt: new Date(), lastTotpStep: Math.floor(Date.now() / 30_000) + delta, pendingTotpCiphertext: null, pendingTotpIv: null, pendingTotpTag: null, pendingTotpExpiresAt: null } });
      if (result.count !== 1) throw new HttpException({ code: 'TWO_FACTOR_SETUP_EXPIRED', message: 'Start setup again' }, 400);
      await tx.recoveryCode.createMany({ data: codes.map(value => ({ userId, codeHash: hashCode(value) })) });
      await tx.userSession.updateMany({ where: { userId, id: { not: request.user.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { userId, action: '2FA_ENABLED', entityType: 'User', entityId: userId, ipAddress: request.ip } });
    });
    return { recoveryCodes: codes };
  }

  private async confirm(request: AuthedRequest, body: unknown) {
    const { code, password } = parse(confirmationSchema, body);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: request.user.id }, include: { security: true } });
    if (!(await argon2.verify(user.passwordHash, password)) || !user.security?.totpEnabledAt || !(await consumeSecondFactor(this.db, user.id, code, user.security))) throw new UnauthorizedException('Invalid credentials');
  }

  @Post('2fa/recovery-codes')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async regenerate(@Req() request: AuthedRequest, @Body() body: unknown) {
    await this.confirm(request, body);
    const codes = makeCodes();
    await this.db.$transaction(async tx => {
      await tx.recoveryCode.deleteMany({ where: { userId: request.user.id } });
      await tx.recoveryCode.createMany({ data: codes.map(value => ({ userId: request.user.id, codeHash: hashCode(value) })) });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'RECOVERY_CODES_REGENERATED', entityType: 'User', entityId: request.user.id, ipAddress: request.ip } });
    });
    return { recoveryCodes: codes };
  }

  @Post('2fa/disable')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async disable(@Req() request: AuthedRequest, @Body() body: unknown) {
    if (process.env.NODE_ENV === 'production') throw new HttpException({ code: 'TWO_FACTOR_REQUIRED', message: 'Two-factor authentication must remain enabled in production' }, 403);
    await this.confirm(request, body);
    await this.db.$transaction(async tx => {
      await tx.userSecurity.update({ where: { userId: request.user.id }, data: { totpSecretCiphertext: null, totpSecretIv: null, totpSecretTag: null, totpEnabledAt: null, lastTotpStep: null } });
      await tx.recoveryCode.deleteMany({ where: { userId: request.user.id } });
      await tx.userSession.updateMany({ where: { userId: request.user.id, id: { not: request.user.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: '2FA_DISABLED', entityType: 'User', entityId: request.user.id, ipAddress: request.ip } });
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
