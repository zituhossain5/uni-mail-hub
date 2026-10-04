import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, Inject, LoggerService, OnModuleDestroy, OnModuleInit, CanActivate, ExecutionContext, SetMetadata, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Prisma, PrismaClient, UserRole } from '@uni/database';
import type { Request, Response } from 'express';
import Redis from 'ioredis';
import pino from 'pino';
import { ZodError, type ZodSchema } from 'zod';

export const Public = () => SetMetadata('public', true);
export const SuperAdmin = () => SetMetadata('superAdmin', true);

@Injectable()
export class Database extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}

@Injectable()
export class RedisConnection implements OnModuleInit, OnModuleDestroy {
  readonly client = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
  async onModuleInit() { await this.client.connect(); }
  async onModuleDestroy() { this.client.disconnect(); }
}

export type AuthUser = { id: string; role: UserRole; email: string; name: string };
export type AuthedRequest = Request & { user: AuthUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector, @Inject(JwtService) private readonly jwt: JwtService, @Inject(Database) private readonly db: Database) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>('public', [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw new UnauthorizedException();
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      const user = await this.db.user.findUnique({ where: { id: payload.sub }, select: { id: true, role: true, email: true, name: true, isActive: true } });
      if (!user?.isActive) throw new UnauthorizedException();
      if (this.reflector.getAllAndOverride<boolean>('superAdmin', [context.getHandler(), context.getClass()]) && user.role !== UserRole.SUPER_ADMIN) throw new ForbiddenException();
      request.user = { id: user.id, role: user.role, email: user.email, name: user.name };
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException();
    }
  }
}

export function parse<T>(schema: ZodSchema<T>, value: unknown): T {
  try { return schema.parse(value); }
  catch (error) { if (error instanceof ZodError) throw new HttpException({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: error.flatten() }, 400); throw error; }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: unknown;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = HttpStatus[status] ?? 'HTTP_ERROR';
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const data = body as Record<string, unknown>;
        code = typeof data.code === 'string' ? data.code : code;
        message = typeof data.message === 'string' ? data.message : message;
        details = data.details;
      } else if (typeof body === 'string') message = body;
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') { status = 409; code = 'CONFLICT'; message = 'A record with this value already exists'; }
      else if (exception.code === 'P2003') { status = 409; code = 'RELATION_CONFLICT'; message = 'Related records prevent this change'; }
      else if (exception.code === 'P2025') { status = 404; code = 'NOT_FOUND'; message = 'Record not found'; }
    }
    if (status === 500) requestLogger.error({ errorType: exception instanceof Error ? exception.name : typeof exception, ...(exception instanceof TypeError ? { errorMessage: exception.message } : {}) }, 'unhandled request error');
    response.status(status).json({ statusCode: status, code, message, ...(details ? { details } : {}) });
  }
}

const logger = pino({ redact: ['req.headers.authorization', 'password', 'token', 'keyHash'], level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string) { logger.info({ context }, String(message)); }
  error(message: unknown, trace?: string, context?: string) { logger.error({ context, ...(process.env.NODE_ENV === 'production' ? {} : { trace }) }, String(message)); }
  warn(message: unknown, context?: string) { logger.warn({ context }, String(message)); }
  debug(message: unknown, context?: string) { logger.debug({ context }, String(message)); }
  verbose(message: unknown, context?: string) { logger.trace({ context }, String(message)); }
}

export const requestLogger = logger;
