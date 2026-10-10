import { Controller, Delete, Get, HttpException, Inject, Param, Post, Put, Body, Req } from '@nestjs/common';
import { credentialSchema } from '@uni/shared';
import { ConnectionResult, Protocol, testImap, testSmtp } from '@uni/mail';
import { decodeEncryptionKey, decryptSecret, encryptSecret } from '@uni/security';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { AuthedRequest, Database, SuperAdmin, parse } from './core';

const idSchema = z.string().cuid();
const activeTests = new Set<string>();
const failure = (code: string, message: string): ConnectionResult => ({ status: 'FAILED', latencyMs: 0, errorCode: code, message });

@SuperAdmin()
@Controller('mailboxes/:id')
export class MailConnectivityController {
  private readonly key = decodeEncryptionKey(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY ?? '');
  constructor(@Inject(Database) private readonly db: Database) {}
  private async mailbox(rawId: string) {
    const mailbox = await this.db.mailbox.findUnique({ where: { id: parse(idSchema, rawId) }, include: { mailServer: true, credential: true } });
    if (!mailbox) throw new HttpException({ code: 'MAILBOX_NOT_FOUND', message: 'Mailbox not found' }, 404);
    return mailbox;
  }
  @Get('credentials/status') async credentialStatus(@Param('id') id: string) {
    const mailbox = await this.mailbox(id);
    const credential = mailbox.credential;
    return { mailboxId: mailbox.id, configured: !!credential, username: credential?.username ?? null, updatedAt: credential?.updatedAt ?? null, lastRotatedAt: credential?.lastRotatedAt ?? null };
  }
  @Put('credentials') @Throttle({ default: { limit: 5, ttl: 60_000 } }) async putCredential(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const mailbox = await this.mailbox(id);
    const { username, password } = parse(credentialSchema, body);
    const encrypted = encryptSecret(password, this.key);
    const action = mailbox.credential ? 'MAILBOX_CREDENTIAL_REPLACED' : 'MAILBOX_CREDENTIAL_CONFIGURED';
    const credential = await this.db.$transaction(async tx => {
      const saved = await tx.mailboxCredential.upsert({ where: { mailboxId: mailbox.id }, create: { mailboxId: mailbox.id, username, ...encrypted }, update: { username, ...encrypted, lastRotatedAt: new Date() }, select: { username: true, updatedAt: true, lastRotatedAt: true } });
      await tx.mailbox.update({ where: { id: mailbox.id }, data: { connectionConfigVersion: { increment: 1 }, status: mailbox.isActive && mailbox.mailServer?.status !== 'DISABLED' ? 'UNKNOWN' : 'DISABLED', lastError: null } });
      await tx.auditLog.create({ data: { userId: request.user.id, action, entityType: 'Mailbox', entityId: mailbox.id, ipAddress: request.ip } });
      return saved;
    });
    return { mailboxId: mailbox.id, configured: true, ...credential };
  }
  @Delete('credentials') async deleteCredential(@Param('id') id: string, @Req() request: AuthedRequest) {
    const mailbox = await this.mailbox(id);
    await this.db.$transaction(async tx => {
      await tx.mailboxCredential.deleteMany({ where: { mailboxId: mailbox.id } });
      await tx.mailbox.update({ where: { id: mailbox.id }, data: { connectionConfigVersion: { increment: 1 }, status: mailbox.isActive && mailbox.mailServer?.status !== 'DISABLED' ? 'UNKNOWN' : 'DISABLED', lastError: null } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'MAILBOX_CREDENTIAL_REMOVED', entityType: 'Mailbox', entityId: mailbox.id, ipAddress: request.ip } });
    });
    return { mailboxId: mailbox.id, configured: false };
  }
  @Get('connection-checks') async history(@Param('id') id: string) {
    const mailbox = await this.mailbox(id);
    return this.db.mailboxConnectionCheck.findMany({ where: { mailboxId: mailbox.id }, orderBy: { testedAt: 'desc' }, take: 50 });
  }
  @Post('test-imap') @Throttle({ default: { limit: 5, ttl: 60_000 } }) testImap(@Param('id') id: string, @Req() request: AuthedRequest) { return this.run(id, ['IMAP'], request); }
  @Post('test-smtp') @Throttle({ default: { limit: 5, ttl: 60_000 } }) testSmtp(@Param('id') id: string, @Req() request: AuthedRequest) { return this.run(id, ['SMTP'], request); }
  @Post('test-connection') @Throttle({ default: { limit: 5, ttl: 60_000 } }) testBoth(@Param('id') id: string, @Req() request: AuthedRequest) { return this.run(id, ['IMAP', 'SMTP'], request); }

  private async run(rawId: string, protocols: Protocol[], request: AuthedRequest) {
    const mailbox = await this.mailbox(rawId);
    if (!mailbox.isActive || mailbox.status === 'DISABLED') throw new HttpException({ code: 'MAILBOX_DISABLED', message: 'Enable this mailbox before testing' }, 409);
    if (activeTests.has(mailbox.id)) throw new HttpException({ code: 'MAILBOX_TEST_IN_PROGRESS', message: 'A connection test is already running' }, 409);
    activeTests.add(mailbox.id);
    try {
      const results: Partial<Record<'imap' | 'smtp', ConnectionResult>> = {};
      for (const protocol of protocols) {
        const server = mailbox.mailServer;
        let result: ConnectionResult;
        if (!server || server.status === 'DISABLED') result = failure('MAIL_SERVER_NOT_CONFIGURED', 'Assign an active mail server before testing.');
        else if (protocol === 'IMAP' && (!server.imapHost || !server.imapPort) || protocol === 'SMTP' && (!server.smtpHost || !server.smtpPort)) result = failure('MAIL_SERVER_NOT_CONFIGURED', `${protocol} endpoint is not configured.`);
        else if (!mailbox.credential && (protocol === 'IMAP' || server.smtpAuthMode === 'PASSWORD')) result = failure('MAIL_CREDENTIAL_NOT_CONFIGURED', 'Configure mailbox credentials before testing.');
        else {
          let password: string | null = null;
          try { if (mailbox.credential && (protocol === 'IMAP' || server.smtpAuthMode === 'PASSWORD')) password = decryptSecret(mailbox.credential, this.key); }
          catch { result = failure('CREDENTIAL_DECRYPTION_FAILED', 'Stored credentials could not be decrypted.'); }
          if (!result!) {
            if (protocol === 'IMAP') result = await testImap({ host: server.imapHost!, port: server.imapPort!, security: server.imapSecurity }, mailbox.credential!.username, password!);
            else result = await testSmtp({ host: server.smtpHost!, port: server.smtpPort!, security: server.smtpSecurity }, server.smtpAuthMode === 'PASSWORD' ? { user: mailbox.credential!.username, pass: password! } : null);
          }
        }
        results[protocol.toLowerCase() as 'imap' | 'smtp'] = result!;
        await this.db.$transaction(async tx => {
          await tx.mailboxConnectionCheck.create({ data: { mailboxId: mailbox.id, protocol, status: result!.status, latencyMs: result!.latencyMs, errorCode: result!.errorCode, errorMessage: result!.status === 'FAILED' ? result!.message : null, configVersion: mailbox.connectionConfigVersion, testedByUserId: request.user.id } });
          if (mailbox.mailServerId) await tx.mailServer.update({ where: { id: mailbox.mailServerId }, data: { lastTestAt: new Date() } });
          await tx.auditLog.create({ data: { userId: request.user.id, action: protocol === 'IMAP' ? 'MAILBOX_IMAP_TESTED' : 'MAILBOX_SMTP_TESTED', entityType: 'Mailbox', entityId: mailbox.id, metadata: { status: result!.status, errorCode: result!.errorCode }, ipAddress: request.ip } });
          const recent = await tx.mailboxConnectionCheck.findMany({ where: { mailboxId: mailbox.id, configVersion: mailbox.connectionConfigVersion }, orderBy: { testedAt: 'desc' }, take: 50 });
          const imap = recent.find(check => check.protocol === 'IMAP');
          const smtp = recent.find(check => check.protocol === 'SMTP');
          const successes = Number(imap?.status === 'SUCCESS') + Number(smtp?.status === 'SUCCESS');
          const status = !imap && !smtp ? 'UNKNOWN' : successes === 2 ? 'HEALTHY' : successes === 1 ? 'WARNING' : 'ERROR';
          await tx.mailbox.updateMany({ where: { id: mailbox.id, connectionConfigVersion: mailbox.connectionConfigVersion }, data: { status, lastError: result!.status === 'FAILED' ? result!.message : null, ...(protocol === 'IMAP' ? { lastImapCheckAt: new Date() } : { lastSmtpCheckAt: new Date() }) } });
        });
      }
      if (protocols.length === 2) await this.db.auditLog.create({ data: { userId: request.user.id, action: 'MAILBOX_CONNECTION_TESTED', entityType: 'Mailbox', entityId: mailbox.id, ipAddress: request.ip } });
      return results;
    } finally { activeTests.delete(mailbox.id); }
  }
}
