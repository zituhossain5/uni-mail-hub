import { Body, Controller, Get, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { loginSchema } from '@uni/shared';
import { AuthedRequest, Database, Public, parse } from './core';

@Controller('auth')
export class AuthController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(JwtService) private readonly jwt: JwtService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(@Body() body: unknown) {
    const { email, password } = parse(loginSchema, body);
    const user = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user?.isActive || !(await argon2.verify(user.passwordHash, password))) throw new UnauthorizedException('Invalid email or password');
    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = await this.jwt.signAsync({ sub: user.id }, { expiresIn: '8h' });
    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }

  @Get('me')
  me(@Req() request: AuthedRequest) { return request.user; }
}
