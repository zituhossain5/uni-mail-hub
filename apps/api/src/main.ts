import 'reflect-metadata';
import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { readConfig } from '@uni/config';
import { ApiExceptionFilter, AuthGuard, Database, JsonLogger, Public, RedisConnection, requestLogger } from './core';
import { AuthController } from './auth';
import { DashboardController, DomainsController, MailboxesController, ProjectsController } from './registry';
import { MailServersController } from './mail-servers';
import { MailConnectivityController } from './mail-connectivity';
import { ApiKeysController } from './api-keys';
import { AdminComposeController, AdminMessagesController, ApiKeyGuard, ClientMessagesController, MailQueue } from './sending';
import { ImapSyncController, ImapSyncQueue } from './imap-sync';
import { WebmailContextController, WebmailMessagesController } from './webmail';
import { MailActionsController } from './mail-actions';

const config = readConfig();

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
  imports: [JwtModule.register({ secret: config.JWT_SECRET }), ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
  controllers: [HealthController, AuthController, DashboardController, ProjectsController, DomainsController, MailboxesController, MailServersController, MailConnectivityController, ImapSyncController, WebmailContextController, WebmailMessagesController, MailActionsController, ApiKeysController, ClientMessagesController, AdminComposeController, AdminMessagesController],
  providers: [Database, RedisConnection, MailQueue, ImapSyncQueue, ApiKeyGuard, { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.enableCors({ origin: config.WEB_URL, credentials: false });
  app.use((request: { method: string; originalUrl: string; id?: string; headers: Record<string, string | string[] | undefined> }, response: { setHeader: (name: string, value: string) => void; statusCode: number; on: (event: string, callback: () => void) => void }, next: () => void) => {
    const started = Date.now();
    request.id = randomUUID();
    response.setHeader('X-Request-Id', request.id);
    response.on('finish', () => requestLogger.info({ requestId: request.id, method: request.method, path: request.originalUrl.split('?')[0], statusCode: response.statusCode, durationMs: Date.now() - started }, 'request'));
    next();
  });
  await app.listen(config.API_PORT, '127.0.0.1');
}

bootstrap().catch((error: unknown) => { console.error(error); process.exit(1); });
