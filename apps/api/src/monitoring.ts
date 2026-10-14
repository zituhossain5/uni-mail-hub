import { Body, Controller, Get, HttpException, Inject, Injectable, OnModuleDestroy, OnModuleInit, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { Prisma, UserRole } from '@uni/database';
import { z } from 'zod';
import { AuthedRequest, Database, RedisConnection, SuperAdmin, parse } from './core';
import { RequirePermission, mailboxWhere, projectWhere } from './access';

const id = z.string().cuid();
const selectorsInput = z.object({ selectors: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)).max(10) }).strict();

export class MonitoringQueue implements OnModuleDestroy {
  private readonly connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  private readonly queue = new Queue('monitoring', { connection: this.connection });
  async enqueue(runId: string) { await this.queue.add('run', { runId }, { jobId: runId, attempts: 1, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 86400, count: 1000 } }); }
  async onModuleDestroy() { await this.queue.close(); await this.connection.quit(); }
}

@Injectable()
export class MonitoringWatchdog implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(@Inject(Database) private readonly db: Database, @Inject(RedisConnection) private readonly redis: RedisConnection) {}
  onModuleInit() {
    this.timer = setInterval(() => { void this.check().catch(() => undefined); }, 30000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private async reconcile(targetType: string, targetId: string, targetName: string, checkType: string, healthy: boolean, summary: string, errorCode: string) {
    const open = await this.db.monitoringIssue.findFirst({ where: { targetType, targetId, checkType, status: 'OPEN' } });
    if (healthy) {
      if (open) await this.db.monitoringIssue.updateMany({ where: { id: open.id, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: new Date(), lastHealthyAt: new Date() } });
      return;
    }
    if (open) {
      if (Date.now() - open.lastDetectedAt.getTime() > 60000) await this.db.monitoringIssue.updateMany({ where: { id: open.id, status: 'OPEN' }, data: { lastDetectedAt: new Date(), severity: 'CRITICAL', summary, errorCode } });
      return;
    }
    try { await this.db.monitoringIssue.create({ data: { targetType, targetId, targetName, checkType, severity: 'CRITICAL', summary, errorCode } }); }
    catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error; }
  }
  private async check() {
    let redisHealthy = false; let workerHealthy = false;
    try {
      await this.redis.client.ping(); redisHealthy = true;
      const raw = await this.redis.client.get('monitor:worker:last');
      const value = raw ? JSON.parse(raw) as { lastHeartbeatAt?: string } : null;
      workerHealthy = !!value?.lastHeartbeatAt && Date.now() - new Date(value.lastHeartbeatAt).getTime() <= Number(process.env.MONITOR_WORKER_HEARTBEAT_SECONDS ?? 90) * 1000;
    } catch { /* connectivity or heartbeat unavailable */ }
    await this.reconcile('SYSTEM', 'redis', 'Redis', 'CONNECTIVITY', redisHealthy, 'Redis is unavailable.', 'REDIS_UNAVAILABLE');
    await this.reconcile('WORKER', 'mail-worker', 'Mail worker', 'HEARTBEAT', workerHealthy, 'Worker heartbeat is missing or stale.', 'WORKER_HEARTBEAT_STALE');
  }
}

@SuperAdmin()
@RequirePermission('monitoring.read')
@Controller('monitoring')
export class MonitoringController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(RedisConnection) private readonly redis: RedisConnection, @Inject(MonitoringQueue) private readonly queue: MonitoringQueue) {}

  private async targetScope(request: AuthedRequest) {
    const [projects, domains, mailboxes] = await Promise.all([
      this.db.project.findMany({ where: projectWhere(request.user), select: { id: true } }),
      this.db.domain.findMany({ where: { project: projectWhere(request.user) }, select: { id: true } }),
      this.db.mailbox.findMany({ where: mailboxWhere(request.user), select: { id: true } }),
    ]);
    return { OR: [
      { targetType: 'PROJECT', targetId: { in: projects.map(row => row.id) } },
      { targetType: 'DOMAIN', targetId: { in: domains.map(row => row.id) } },
      { targetType: 'MAILBOX', targetId: { in: mailboxes.map(row => row.id) } },
    ] };
  }

  @Get() async summary(@Req() request: AuthedRequest) {
    if (request.user.role !== UserRole.SUPER_ADMIN && request.user.role !== UserRole.ADMIN) {
      const scope = await this.targetScope(request);
      const [issues, run] = await Promise.all([
        this.db.monitoringIssue.findMany({ where: { status: 'OPEN', ...scope }, orderBy: { lastDetectedAt: 'desc' }, take: 200 }),
        this.db.monitoringRun.findFirst({ where: { status: { in: ['SUCCESS', 'PARTIAL'] } }, orderBy: { completedAt: 'desc' }, select: { id: true } }),
      ]);
      const results = run ? await this.db.monitoringResult.findMany({ where: { runId: run.id, ...scope }, orderBy: { checkedAt: 'desc' }, take: 3000 }) : [];
      return { lastRun: null, lastResultRun: null, runs: [], issues, results, live: { redis: 'UNKNOWN', worker: 'UNKNOWN' } };
    }
    const [lastRun, lastResultRun, issues, runs] = await Promise.all([
      this.db.monitoringRun.findFirst({ orderBy: { createdAt: 'desc' } }),
      this.db.monitoringRun.findFirst({ where: { status: { in: ['SUCCESS', 'PARTIAL'] } }, orderBy: { completedAt: 'desc' } }),
      this.db.monitoringIssue.findMany({ where: { status: 'OPEN' }, orderBy: [{ severity: 'asc' }, { lastDetectedAt: 'desc' }], take: 200 }),
      this.db.monitoringRun.findMany({ orderBy: { createdAt: 'desc' }, take: 15 }),
    ]);
    const results = lastResultRun ? await this.db.monitoringResult.findMany({ where: { runId: lastResultRun.id }, orderBy: [{ targetType: 'asc' }, { targetName: 'asc' }, { checkType: 'asc' }], take: 3000 }) : [];
    let redis = 'CRITICAL'; let worker = 'CRITICAL';
    try {
      await this.redis.client.ping(); redis = 'HEALTHY';
      const raw = await this.redis.client.get('monitor:worker:last');
      const value = raw ? JSON.parse(raw) as { lastHeartbeatAt?: string } : null;
      const age = value?.lastHeartbeatAt ? Date.now() - new Date(value.lastHeartbeatAt).getTime() : Infinity;
      if (age <= Number(process.env.MONITOR_WORKER_HEARTBEAT_SECONDS ?? 90) * 1000) worker = 'HEALTHY';
    } catch { /* live health remains critical */ }
    return { lastRun, lastResultRun, runs, issues, results, live: { redis, worker } };
  }

  @Get('issues') async issues(@Req() request: AuthedRequest, @Query('status') rawStatus?: string, @Query('cursor') rawCursor?: string) {
    const status = parse(z.enum(['OPEN', 'RESOLVED']), rawStatus ?? 'OPEN');
    const cursor = rawCursor ? parse(id, rawCursor) : undefined;
    const scope = request.user.role === UserRole.SUPER_ADMIN || request.user.role === UserRole.ADMIN ? {} : await this.targetScope(request);
    const [rows, total] = await Promise.all([
      this.db.monitoringIssue.findMany({ where: { status, ...scope }, orderBy: [{ lastDetectedAt: 'desc' }, { id: 'desc' }], take: 101, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
      this.db.monitoringIssue.count({ where: { status, ...scope } }),
    ]);
    return { items: rows.slice(0, 100), nextCursor: rows.length > 100 ? rows[99]!.id : null, total };
  }
  @Get('runs') runs(@Req() request: AuthedRequest) { return request.user.role === UserRole.SUPER_ADMIN || request.user.role === UserRole.ADMIN ? this.db.monitoringRun.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }) : []; }

  @Post('runs') @RequirePermission('monitoring.run') async run(@Req() request: AuthedRequest) {
    let active = await this.db.monitoringRun.findFirst({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
    if (active && !await this.redis.client.exists('monitor:run:lease')) {
      const stale = active.status === 'RUNNING' ? !!active.startedAt && Date.now() - active.startedAt.getTime() > 30000 : Date.now() - active.createdAt.getTime() > 120000;
      if (stale) {
        await this.db.monitoringRun.updateMany({ where: { id: active.id, status: active.status }, data: { status: 'FAILED', completedAt: new Date(), errorCode: 'MONITORING_INTERRUPTED' } });
        active = null;
      }
    }
    if (active) throw new HttpException({ code: 'MONITORING_IN_PROGRESS', message: 'A monitoring run is already in progress.', details: { runId: active.id } }, 409);
    const run = await this.db.monitoringRun.create({ data: { trigger: 'MANUAL', requestedByUserId: request.user.id } });
    try { await this.queue.enqueue(run.id); }
    catch {
      await this.db.monitoringRun.update({ where: { id: run.id }, data: { status: 'FAILED', completedAt: new Date(), errorCode: 'MONITORING_QUEUE_UNAVAILABLE' } });
      throw new HttpException({ code: 'MONITORING_QUEUE_UNAVAILABLE', message: 'Monitoring queue is unavailable.' }, 503);
    }
    await this.db.auditLog.create({ data: { userId: request.user.id, action: 'MONITORING_RUN_REQUESTED', entityType: 'MonitoringRun', entityId: run.id, ipAddress: request.ip } });
    return run;
  }

  @Get('domains/:id') async domain(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const domainId = parse(id, rawId);
    const domain = await this.db.domain.findFirst({ where: { id: domainId, project: projectWhere(request.user) }, select: { id: true, domain: true, dkimSelectors: true, status: true } });
    if (!domain) throw new HttpException({ code: 'DOMAIN_NOT_FOUND', message: 'Domain not found.' }, 404);
    const history = await this.db.monitoringResult.findMany({ where: { targetType: 'DOMAIN', targetId: domainId }, orderBy: { checkedAt: 'desc' }, take: 100 });
    const latest = [...new Map(history.reverse().map(result => [result.checkType, result])).values()];
    return { domain, results: latest };
  }

  @Put('domains/:id/dkim-selectors') @RequirePermission('monitoring.run') async selectors(@Param('id') rawId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const domainId = parse(id, rawId);
    const { selectors } = parse(selectorsInput, body);
    const unique = [...new Set(selectors)];
    const domain = await this.db.domain.update({ where: { id: domainId }, data: { dkimSelectors: unique }, select: { id: true, domain: true, dkimSelectors: true } });
    const oldDkimIssues = await this.db.monitoringIssue.findMany({ where: { targetType: 'DOMAIN', targetId: domainId, status: 'OPEN', checkType: { startsWith: 'DKIM:' } }, select: { id: true, checkType: true } });
    for (const issue of oldDkimIssues) if (!unique.includes(issue.checkType.slice(5))) await this.db.monitoringIssue.update({ where: { id: issue.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    await this.db.auditLog.create({ data: { userId: request.user.id, action: 'DOMAIN_DKIM_SELECTORS_UPDATED', entityType: 'Domain', entityId: domain.id, metadata: { selectors: unique }, ipAddress: request.ip } });
    return domain;
  }
}
