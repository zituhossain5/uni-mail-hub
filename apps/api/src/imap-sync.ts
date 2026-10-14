import { Controller, Get, HttpException, Inject, Injectable, OnModuleDestroy, Param, Post, Req } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { z } from 'zod';
import { AuthedRequest, Database, SuperAdmin, parse } from './core';
import { RequirePermission } from './access';

const idSchema = z.string().cuid();

@Injectable()
export class ImapSyncQueue implements OnModuleDestroy {
  private readonly connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  private readonly queue = new Queue('mail-sync', { connection: this.connection });
  async enqueue(mailboxId: string) {
    const job = await this.queue.add('sync', { mailboxId }, { jobId: `sync-${mailboxId}`, attempts: 4, backoff: { type: 'exponential', delay: 30000 }, removeOnComplete: true, removeOnFail: true });
    return { status: 'QUEUED' as const, jobId: job.id };
  }
  async onModuleDestroy() { await this.queue.close(); await this.connection.quit(); }
}

@SuperAdmin()
@RequirePermission('mail.read')
@Controller('mailboxes/:id')
export class ImapSyncController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(ImapSyncQueue) private readonly queue: ImapSyncQueue) {}
  private async mailbox(rawId: string) {
    const mailbox = await this.db.mailbox.findUnique({ where: { id: parse(idSchema, rawId) }, select: { id: true, isActive: true, status: true, credential: { select: { id: true } }, mailServer: { select: { status: true, imapHost: true, imapPort: true } } } });
    if (!mailbox) throw new HttpException({ code: 'MAILBOX_NOT_FOUND', message: 'Mailbox not found' }, 404);
    return mailbox;
  }
  @Post('sync') @RequirePermission('mail.sync') async sync(@Param('id') rawId: string, @Req() request: AuthedRequest) {
    const mailbox = await this.mailbox(rawId);
    if (!mailbox.isActive || mailbox.status === 'DISABLED') throw new HttpException({ code: 'MAILBOX_DISABLED', message: 'Enable this mailbox before synchronizing.' }, 409);
    if (!mailbox.credential) throw new HttpException({ code: 'MAIL_CREDENTIAL_NOT_CONFIGURED', message: 'Configure mailbox credentials before synchronizing.' }, 409);
    if (!mailbox.mailServer || mailbox.mailServer.status !== 'ACTIVE' || !mailbox.mailServer.imapHost || !mailbox.mailServer.imapPort) throw new HttpException({ code: 'MAIL_SERVER_NOT_CONFIGURED', message: 'Assign an active IMAP server before synchronizing.' }, 409);
    const queued = await this.queue.enqueue(mailbox.id);
    await this.db.auditLog.create({ data: { userId: request.user.id, action: 'MAILBOX_SYNC_QUEUED', entityType: 'Mailbox', entityId: mailbox.id, ipAddress: request.ip } });
    return queued;
  }
  @Get('sync-status') async status(@Param('id') rawId: string) {
    const mailbox = await this.mailbox(rawId);
    const [latest, folderCount, messageCount] = await Promise.all([
      this.db.mailSyncRun.findFirst({ where: { mailboxId: mailbox.id }, orderBy: { startedAt: 'desc' } }),
      this.db.mailFolder.count({ where: { mailboxId: mailbox.id } }),
      this.db.mailMessage.count({ where: { mailboxId: mailbox.id } }),
    ]);
    return { mailboxId: mailbox.id, latest, folderCount, messageCount };
  }
  @Get('sync-history') async history(@Param('id') rawId: string) {
    const mailbox = await this.mailbox(rawId);
    return this.db.mailSyncRun.findMany({ where: { mailboxId: mailbox.id }, orderBy: { startedAt: 'desc' }, take: 50 });
  }
  @Get('folders') async folders(@Param('id') rawId: string) {
    const mailbox = await this.mailbox(rawId);
    const folders = await this.db.mailFolder.findMany({ where: { mailboxId: mailbox.id }, orderBy: { path: 'asc' } });
    return folders.map(folder => ({ ...folder, uidNext: folder.uidNext?.toString() ?? null, highestSyncedUid: folder.highestSyncedUid.toString() }));
  }
}
