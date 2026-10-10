import 'reflect-metadata';
import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { UserRole } from '@uni/database';
import { readConfig } from '@uni/config';
import { ApiExceptionFilter, AuthGuard, Database, JsonLogger, Public, RedisConnection, requestLogger } from './core';
import { AuthController } from './auth';
import { SecurityAuthController } from './security-auth';
import { RedisThrottleStorage } from './redis-throttle';
import { DashboardController, DomainsController, MailboxesController, ProjectsController } from './registry';
import { MailServersController } from './mail-servers';
import { MailConnectivityController } from './mail-connectivity';
import { ApiKeysController } from './api-keys';
import { AdminComposeController, AdminMessagesController, ApiKeyGuard, ClientMessagesController, MailQueue } from './sending';
import { ImapSyncController, ImapSyncQueue } from './imap-sync';
import { WebmailContextController, WebmailMessagesController } from './webmail';
import { MailActionsController } from './mail-actions';
import { MailSearchController } from './mail-search';
import { CpanelController, CpanelDiscoveryQueue } from './cpanel';
import { CpanelProvisioningController } from './cpanel-provisioning';
import { ProjectIntegrationController } from './project-integration';
import { MonitoringController, MonitoringQueue, MonitoringWatchdog } from './monitoring';
import { WebhooksController, SuppressionsController } from './webhooks';

const config = readConfig();
const throttleStorage = new RedisThrottleStorage(config.REDIS_URL);

@Controller('health')
class HealthController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(RedisConnection) private readonly redis: RedisConnection) {}
  @Public()
  @Get()
  async health() {
    const [database, redis] = await Promise.allSettled([this.db.$queryRaw`SELECT 1`, this.redis.client.ping()]);
    const result = { status: database.status === 'fulfilled' && redis.status === 'fulfilled' ? 'ok' : 'degraded', database: database.status === 'fulfilled' ? 'connected' : 'unavailable', redis: redis.status === 'fulfilled' ? 'connected' : 'unavailable' };
    if (result.status !== 'ok') throw new ServiceUnavailableException({ code: 'DEPENDENCY_UNAVAILABLE', message: 'Service dependencies unavailable', details: result });
    return result;
  }
}

@Module({
  imports: [JwtModule.register({ secret: config.JWT_SECRET }), ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }], storage: throttleStorage, errorMessage: 'Rate limit exceeded' })],
  controllers: [HealthController, AuthController, SecurityAuthController, DashboardController, ProjectsController, ProjectIntegrationController, DomainsController, MailboxesController, MailServersController, MailConnectivityController, ImapSyncController, WebmailContextController, WebmailMessagesController, MailSearchController, MailActionsController, ApiKeysController, ClientMessagesController, AdminComposeController, AdminMessagesController, CpanelController, CpanelProvisioningController, MonitoringController, WebhooksController, SuppressionsController],
  providers: [Database, RedisConnection, { provide: RedisThrottleStorage, useValue: throttleStorage }, MailQueue, ImapSyncQueue, CpanelDiscoveryQueue, MonitoringQueue, MonitoringWatchdog, ApiKeyGuard, { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: new JsonLogger() });
  app.setGlobalPrefix('api/v1');
  app.useBodyParser('json', { limit: '2mb' });
  app.use(helmet({ hsts: config.NODE_ENV === 'production' }));
  app.use((_request: unknown, response: { setHeader: (name: string, value: string) => void }, next: () => void) => { response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); next(); });
  const allowedOrigins = config.ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean);
  app.enableCors({ origin: allowedOrigins?.length ? allowedOrigins : [config.WEB_URL], credentials: false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });
  app.use((request: { method: string; originalUrl: string; id?: string; headers: Record<string, string | string[] | undefined> }, response: { setHeader: (name: string, value: string) => void; statusCode: number; on: (event: string, callback: () => void) => void }, next: () => void) => {
    const started = Date.now();
    request.id = randomUUID();
    response.setHeader('X-Request-Id', request.id);
    response.on('finish', () => requestLogger.info({ requestId: request.id, method: request.method, path: request.originalUrl.split('?')[0], statusCode: response.statusCode, durationMs: Date.now() - started }, 'request'));
    next();
  });
  await app.init();
  if (config.NODE_ENV === 'production') {
    const database = app.get(Database);
    const [admins, unprotected] = await Promise.all([
      database.user.count({ where: { role: UserRole.SUPER_ADMIN, isActive: true } }),
      database.user.count({ where: { role: UserRole.SUPER_ADMIN, isActive: true, OR: [{ security: null }, { security: { totpEnabledAt: null } }] } }),
    ]);
    if (!admins || unprotected) throw new Error('Production requires an active SUPER_ADMIN with 2FA enabled');
  }
  await app.listen(config.API_PORT, '127.0.0.1');
}

bootstrap().catch((error: unknown) => { if (process.env.NODE_ENV === 'production') requestLogger.error({ errorType: error instanceof Error ? error.name : typeof error }, 'API startup failed'); else console.error(error); process.exit(1); });
