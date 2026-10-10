import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Req } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@uni/database';
import { CpanelClient, cpanelMailboxParts, cpanelQuota, classifyCpanelError, testImap, testSmtp, validateCpanelHost } from '@uni/mail';
import { decodeEncryptionKey, decryptSecret, encryptSecret } from '@uni/security';
import { z } from 'zod';
import { AuthedRequest, Database, SuperAdmin, parse } from './core';

const id = z.string().cuid();
const provisionInput = z.object({
  projectId: id, domainId: id, email: z.string().max(320),
  quotaMb: z.number().int().min(1).max(1048576).nullable(),
  mailServerId: id.optional(), mailHost: z.string().max(253).optional(),
}).strict().refine(value => Boolean(value.mailServerId) !== Boolean(value.mailHost), 'Select an existing mail server or enter a mail host.');
const confirmInput = z.object({ confirmEmail: z.string().max(320) }).strict();
const recoveryInput = confirmInput.extend({ confirmRemoteExists: z.boolean().optional() });
const quotaInput = z.object({ quotaMb: z.number().int().min(1).max(1048576).nullable() }).strict();
const suspensionInput = z.object({ suspended: z.boolean(), confirmEmail: z.string().max(320) }).strict();
const safeChange = { id: true, accountId: true, projectId: true, email: true, action: true, status: true, mailboxId: true, errorCode: true, createdAt: true, completedAt: true } as const;
const encryptionKey = decodeEncryptionKey(process.env.MAIL_CREDENTIAL_ENCRYPTION_KEY ?? '');
type Account = NonNullable<Awaited<ReturnType<Database['cpanelAccount']['findUnique']>>>;
type Change = NonNullable<Awaited<ReturnType<Database['cpanelMailboxChange']['findUnique']>>>;
const problem = (code: string, message: string, status = 409) => new HttpException({ code, message }, status);

export function generateMailboxPassword(): string {
  return randomBytes(48).toString('base64url');
}

@SuperAdmin()
@Controller('cpanel-accounts/:accountId/mailboxes')
export class CpanelProvisioningController {
  constructor(@Inject(Database) private readonly db: Database) {}

  private async account(rawId: string) {
    const account = await this.db.cpanelAccount.findUnique({ where: { id: parse(id, rawId) } });
    if (!account) throw problem('CPANEL_ACCOUNT_NOT_FOUND', 'cPanel account not found.', 404);
    if (account.status !== 'ACTIVE') throw problem('CPANEL_ACCOUNT_DISABLED', 'Enable the cPanel account first.');
    return account;
  }
  private client(account: Account) {
    try {
      const apiToken = decryptSecret({ encryptedPassword: account.encryptedApiToken, encryptionIv: account.encryptionIv, encryptionAuthTag: account.encryptionAuthTag, encryptionVersion: account.encryptionVersion }, encryptionKey);
      return new CpanelClient({ host: account.host, port: account.port, username: account.username, apiToken });
    } catch { throw problem('CPANEL_CREDENTIAL_UNAVAILABLE', 'Stored cPanel token is unavailable.'); }
  }
  private async mapped(rawAccountId: string, rawMailboxId: string) {
    const account = await this.account(rawAccountId);
    const mailbox = await this.db.mailbox.findUnique({ where: { id: parse(id, rawMailboxId) }, include: { mailServer: true } });
    if (!mailbox) throw problem('MAILBOX_NOT_FOUND', 'Managed mailbox not found.', 404);
    const discovery = await this.db.cpanelDiscoveredMailbox.findFirst({ where: { accountId: account.id, managedMailboxId: mailbox.id, email: mailbox.email, state: 'MANAGED' } });
    if (!discovery) throw problem('CPANEL_MAPPING_REQUIRED', 'This mailbox is not mapped to the selected cPanel account.');
    return { account, mailbox, discovery };
  }
  private async noPending(email: string) {
    const pending = await this.db.cpanelMailboxChange.findFirst({ where: { email, status: { in: ['PREPARED', 'CRITICAL'] } }, select: { id: true } });
    if (pending) throw problem('CPANEL_RECOVERY_REQUIRED', 'Resolve the pending mailbox change before starting another.');
  }
  private async prepare(accountId: string, email: string, action: 'CREATE' | 'ROTATE', password: string, options: { projectId?: string; domainId?: string; mailServerId?: string; mailHost?: string; mailboxId?: string; quotaMb?: number | null }) {
    const encrypted = encryptSecret(password, encryptionKey);
    try {
      return await this.db.cpanelMailboxChange.create({ data: { accountId, email, activeEmail: email, action, status: 'PREPARED', projectId: options.projectId, domainId: options.domainId, mailServerId: options.mailServerId, mailHost: options.mailHost, mailboxId: options.mailboxId, quotaMb: options.quotaMb, ...encrypted } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw problem('CPANEL_CHANGE_IN_PROGRESS', 'A mailbox change is already in progress.');
      throw error;
    }
  }
  private async critical(changeId: string, code: string) {
    try { await this.db.cpanelMailboxChange.update({ where: { id: changeId }, data: { status: 'CRITICAL', errorCode: code } }); }
    catch { /* PREPARED escrow remains visible for recovery even if the database is unavailable. */ }
  }
  private async finish(change: Change, request: AuthedRequest) {
    if (!change.encryptedPassword || !change.encryptionIv || !change.encryptionAuthTag || !change.encryptionVersion) throw problem('CPANEL_RECOVERY_UNAVAILABLE', 'Encrypted recovery credential is missing.');
    const secret = { encryptedPassword: change.encryptedPassword, encryptionIv: change.encryptionIv, encryptionAuthTag: change.encryptionAuthTag, encryptionVersion: change.encryptionVersion };
    const mailbox = await this.db.$transaction(async tx => {
      let mailboxId = change.mailboxId;
      let serverId = change.mailServerId;
      if (change.action === 'CREATE') {
        if (!change.projectId || !change.domainId) throw new Error('Incomplete provisioning state');
        const mappedDomain = await tx.cpanelDiscoveredDomain.findUnique({ where: { accountId_domain: { accountId: change.accountId, domain: cpanelMailboxParts(change.email).domain } } });
        if (mappedDomain?.managedDomainId && mappedDomain.managedDomainId !== change.domainId) throw new Error('Domain mapping conflict');
        if (!serverId && change.mailHost) {
          let server = await tx.mailServer.findFirst({ where: { providerType: 'CPANEL', status: 'ACTIVE', imapHost: change.mailHost, imapPort: 993, smtpHost: change.mailHost, smtpPort: 465 } });
          if (!server) server = await tx.mailServer.create({ data: { name: `${change.mailHost} mail`, providerType: 'CPANEL', imapHost: change.mailHost, imapPort: 993, smtpHost: change.mailHost, smtpPort: 465, imapSecurity: 'TLS', smtpSecurity: 'TLS', smtpAuthMode: 'PASSWORD' } });
          serverId = server.id;
        }
        if (!serverId) throw new Error('Mail server missing');
        const selectedServer = await tx.mailServer.findUnique({ where: { id: serverId }, select: { status: true, providerType: true, imapHost: true, imapPort: true, smtpHost: true, smtpPort: true } });
        if (!selectedServer || selectedServer.status !== 'ACTIVE' || selectedServer.providerType !== 'CPANEL' || !selectedServer.imapHost || !selectedServer.imapPort || !selectedServer.smtpHost || !selectedServer.smtpPort) throw new Error('Mail server invalid');
        const existing = await tx.mailbox.findUnique({ where: { email: change.email }, select: { id: true, projectId: true, domainId: true } });
        if (existing) throw new Error('Unexpected existing mailbox');
        const discovered = await tx.cpanelDiscoveredMailbox.findUnique({ where: { accountId_email: { accountId: change.accountId, email: change.email } }, select: { managedMailboxId: true } });
        if (discovered?.managedMailboxId) throw new Error('Mailbox discovery mapping conflict');
        const created = await tx.mailbox.create({ data: { email: change.email, projectId: change.projectId, domainId: change.domainId, mailServerId: serverId, status: 'UNKNOWN' }, select: { id: true, projectId: true, domainId: true } });
        mailboxId = created.id;
        const domain = cpanelMailboxParts(change.email).domain;
        await tx.cpanelDiscoveredDomain.upsert({ where: { accountId_domain: { accountId: change.accountId, domain } }, create: { accountId: change.accountId, domain, state: 'MANAGED', managedDomainId: change.domainId }, update: { state: 'MANAGED', managedDomainId: change.domainId, lastSeenAt: new Date() } });
        await tx.cpanelDiscoveredMailbox.upsert({ where: { accountId_email: { accountId: change.accountId, email: change.email } }, create: { accountId: change.accountId, email: change.email, domain, state: 'MANAGED', managedMailboxId: mailboxId, quotaBytes: change.quotaMb === null ? null : BigInt(change.quotaMb!) * 1048576n, unlimitedQuota: change.quotaMb === null }, update: { state: 'MANAGED', managedMailboxId: mailboxId, quotaBytes: change.quotaMb === null ? null : BigInt(change.quotaMb!) * 1048576n, unlimitedQuota: change.quotaMb === null, lastSeenAt: new Date() } });
      }
      if (!mailboxId) throw new Error('Mailbox missing');
      const current = await tx.mailbox.findUnique({ where: { id: mailboxId }, select: { email: true, isActive: true, mailServer: { select: { status: true } } } });
      if (current?.email !== change.email) throw new Error('Mailbox mapping conflict');
      await tx.mailboxCredential.upsert({ where: { mailboxId }, create: { mailboxId, username: change.email, ...secret }, update: { username: change.email, ...secret, lastRotatedAt: new Date() } });
      await tx.mailbox.update({ where: { id: mailboxId }, data: { connectionConfigVersion: { increment: 1 }, status: current.isActive && current.mailServer?.status !== 'DISABLED' ? 'UNKNOWN' : 'DISABLED', lastError: null } });
      await tx.cpanelMailboxChange.update({ where: { id: change.id }, data: { status: 'COMPLETED', activeEmail: null, mailboxId, encryptedPassword: null, encryptionIv: null, encryptionAuthTag: null, encryptionVersion: null, errorCode: null, completedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: change.action === 'CREATE' ? 'CPANEL_MAILBOX_CREATED' : 'CPANEL_MAILBOX_PASSWORD_ROTATED', entityType: 'Mailbox', entityId: mailboxId, ipAddress: request.ip, metadata: { accountId: change.accountId, changeId: change.id } } });
      return { id: mailboxId, email: change.email };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return mailbox;
  }
  private async verify(mailboxId: string, password: string, request: AuthedRequest) {
    const mailbox = await this.db.mailbox.findUnique({ where: { id: mailboxId }, include: { mailServer: true } });
    const server = mailbox?.mailServer;
    if (!mailbox || !server) return null;
    const imap = server.imapHost && server.imapPort ? await testImap({ host: server.imapHost, port: server.imapPort, security: server.imapSecurity }, mailbox.email, password) : null;
    const smtp = server.smtpHost && server.smtpPort ? await testSmtp({ host: server.smtpHost, port: server.smtpPort, security: server.smtpSecurity }, server.smtpAuthMode === 'PASSWORD' ? { user: mailbox.email, pass: password } : null) : null;
    await this.db.$transaction(async tx => {
      for (const [protocol, result] of [['IMAP', imap], ['SMTP', smtp]] as const) {
        if (result) await tx.mailboxConnectionCheck.create({ data: { mailboxId, protocol, status: result.status, latencyMs: result.latencyMs, errorCode: result.errorCode, errorMessage: result.status === 'FAILED' ? result.message : null, configVersion: mailbox.connectionConfigVersion, testedByUserId: request.user.id } });
      }
      const successes = Number(imap?.status === 'SUCCESS') + Number(smtp?.status === 'SUCCESS');
      await tx.mailbox.update({ where: { id: mailboxId }, data: { status: mailbox.isActive ? successes === 2 ? 'HEALTHY' : successes === 1 ? 'WARNING' : imap || smtp ? 'ERROR' : 'UNKNOWN' : 'DISABLED', lastError: imap?.status === 'FAILED' ? imap.message : smtp?.status === 'FAILED' ? smtp.message : null, lastImapCheckAt: imap ? new Date() : undefined, lastSmtpCheckAt: smtp ? new Date() : undefined } });
    });
    return { imap, smtp };
  }
  @Get('changes')
  async changes(@Param('accountId') accountId: string) {
    const account = await this.account(accountId);
    return this.db.cpanelMailboxChange.findMany({ where: { accountId: account.id }, select: safeChange, orderBy: { createdAt: 'desc' }, take: 100 });
  }
  @Post('provision')
  async provision(@Param('accountId') accountId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const account = await this.account(accountId);
    const input = parse(provisionInput, body);
    const mailbox = cpanelMailboxParts(input.email);
    cpanelQuota(input.quotaMb);
    const domain = await this.db.domain.findUnique({ where: { id: input.domainId } });
    if (!domain || domain.projectId !== input.projectId || domain.domain !== mailbox.domain) throw problem('CPANEL_DOMAIN_PROJECT_CONFLICT', 'Select a domain belonging to the project.');
    const link = await this.db.cpanelDiscoveredDomain.findUnique({ where: { accountId_domain: { accountId: account.id, domain: domain.domain } } });
    if (link?.managedDomainId && link.managedDomainId !== domain.id) throw problem('CPANEL_DOMAIN_MAPPING_CONFLICT', 'This cPanel domain is mapped to a different project.');
    if (await this.db.mailbox.findFirst({ where: { email: { equals: mailbox.email, mode: 'insensitive' } } })) throw problem('CPANEL_MAILBOX_EXISTS', 'This mailbox is already managed.');
    await this.noPending(mailbox.email);
    let mailHost: string | undefined;
    if (input.mailHost) {
      try { mailHost = validateCpanelHost(input.mailHost); } catch { throw problem('CPANEL_INVALID_MAIL_HOST', 'Enter a valid public mail host.', 400); }
    } else {
      const server = await this.db.mailServer.findUnique({ where: { id: input.mailServerId } });
      if (!server || server.status !== 'ACTIVE' || server.providerType !== 'CPANEL' || !server.imapHost || !server.imapPort || !server.smtpHost || !server.smtpPort) throw problem('CPANEL_MAIL_SERVER_INVALID', 'Select an active cPanel mail server with IMAP and SMTP.');
    }
    const client = this.client(account);
    if (!(await client.listDomains()).includes(domain.domain)) throw problem('CPANEL_DOMAIN_NOT_FOUND', 'The selected cPanel account does not manage this domain.');
    if ((await client.listMailboxes()).some(item => item.email === mailbox.email)) throw problem('CPANEL_MAILBOX_EXISTS', 'This mailbox already exists in cPanel.');
    const password = generateMailboxPassword();
    const change = await this.prepare(account.id, mailbox.email, 'CREATE', password, { projectId: input.projectId, domainId: domain.id, mailServerId: input.mailServerId, mailHost, quotaMb: input.quotaMb });
    try { await client.createMailbox(mailbox.email, password, input.quotaMb); }
    catch (error) { await this.critical(change.id, classifyCpanelError(error).code); throw problem('CPANEL_RECOVERY_REQUIRED', 'cPanel did not confirm mailbox creation. Check the pending change before retrying.'); }
    let saved;
    try { saved = await this.finish(change, request); }
    catch { await this.critical(change.id, 'CPANEL_VAULT_UPDATE_FAILED'); throw problem('CPANEL_RECOVERY_REQUIRED', 'CRITICAL: cPanel created the mailbox, but local credential storage needs recovery.'); }
    let checks = null;
    try { checks = await this.verify(saved.id, password, request); } catch { /* Credential is committed; tests can be retried from mailbox detail. */ }
    return { ...saved, credentialConfigured: true, checks };
  }
  @Post(':mailboxId/rotate')
  async rotate(@Param('accountId') accountId: string, @Param('mailboxId') mailboxId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const { account, mailbox } = await this.mapped(accountId, mailboxId);
    const { confirmEmail } = parse(confirmInput, body);
    if (confirmEmail !== mailbox.email) throw problem('CONFIRMATION_REQUIRED', 'Type the exact mailbox address to confirm password rotation.', 400);
    await this.noPending(mailbox.email);
    const password = generateMailboxPassword();
    const change = await this.prepare(account.id, mailbox.email, 'ROTATE', password, { projectId: mailbox.projectId, mailboxId: mailbox.id });
    try { await this.client(account).changeMailboxPassword(mailbox.email, password); }
    catch (error) { await this.critical(change.id, classifyCpanelError(error).code); throw problem('CPANEL_RECOVERY_REQUIRED', 'cPanel did not confirm rotation. Check the pending change before retrying.'); }
    try { await this.finish(change, request); }
    catch { await this.critical(change.id, 'CPANEL_VAULT_UPDATE_FAILED'); throw problem('CPANEL_RECOVERY_REQUIRED', 'CRITICAL: cPanel changed the password, but local credential storage needs recovery.'); }
    let checks = null;
    try { checks = await this.verify(mailbox.id, password, request); } catch { /* Credential is committed; tests can be retried. */ }
    return { mailboxId: mailbox.id, credentialConfigured: true, checks };
  }
  @Post('changes/:changeId/recover')
  async recover(@Param('accountId') accountId: string, @Param('changeId') changeId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const account = await this.account(accountId);
    const change = await this.db.cpanelMailboxChange.findFirst({ where: { id: parse(id, changeId), accountId: account.id } });
    if (!change || change.status === 'COMPLETED') throw problem('CPANEL_CHANGE_NOT_FOUND', 'Unresolved mailbox change not found.', 404);
    const { confirmEmail, confirmRemoteExists } = parse(recoveryInput, body);
    if (confirmEmail !== change.email) throw problem('CONFIRMATION_REQUIRED', 'Type the exact mailbox address to recover this change.', 400);
    if (!change.encryptedPassword || !change.encryptionIv || !change.encryptionAuthTag || !change.encryptionVersion) throw problem('CPANEL_RECOVERY_UNAVAILABLE', 'Encrypted recovery credential is missing.');
    if (change.action === 'CREATE' && change.errorCode !== 'CPANEL_VAULT_UPDATE_FAILED' && confirmRemoteExists !== true) throw problem('CPANEL_REVIEW_REQUIRED', 'Inspect the mailbox in cPanel and explicitly confirm it exists before recovery.');
    const password = decryptSecret({ encryptedPassword: change.encryptedPassword, encryptionIv: change.encryptionIv, encryptionAuthTag: change.encryptionAuthTag, encryptionVersion: change.encryptionVersion }, encryptionKey);
    const client = this.client(account);
    if (change.action === 'CREATE' && !(await client.listMailboxes()).some(item => item.email === change.email)) throw problem('CPANEL_MAILBOX_NOT_FOUND', 'Mailbox is absent in cPanel; no password was changed.');
    try { await client.changeMailboxPassword(change.email, password); }
    catch (error) { await this.critical(change.id, classifyCpanelError(error).code); throw problem('CPANEL_RECOVERY_REQUIRED', 'cPanel did not confirm the recovery password update.'); }
    try {
      const mailbox = await this.finish({ ...change, status: 'CRITICAL' }, request);
      return { ...mailbox, recovered: true, credentialConfigured: true };
    } catch { await this.critical(change.id, 'CPANEL_VAULT_UPDATE_FAILED'); throw problem('CPANEL_RECOVERY_REQUIRED', 'CRITICAL: cPanel password changed but local credential storage still needs recovery.'); }
  }
  @Post('changes/:changeId/abandon')
  async abandon(@Param('accountId') accountId: string, @Param('changeId') changeId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const account = await this.account(accountId);
    const change = await this.db.cpanelMailboxChange.findFirst({ where: { id: parse(id, changeId), accountId: account.id } });
    if (!change || change.status === 'COMPLETED') throw problem('CPANEL_CHANGE_NOT_FOUND', 'Unresolved mailbox change not found.', 404);
    const { confirmEmail } = parse(confirmInput, body);
    if (confirmEmail !== change.email) throw problem('CONFIRMATION_REQUIRED', 'Type the exact mailbox address to confirm.', 400);
    if (change.action !== 'CREATE' || change.errorCode === 'CPANEL_VAULT_UPDATE_FAILED') throw problem('CPANEL_REVIEW_REQUIRED', 'This change cannot be abandoned automatically.');
    if ((await this.client(account).listMailboxes()).some(item => item.email === change.email)) throw problem('CPANEL_MAILBOX_EXISTS', 'The mailbox exists in cPanel. Recovery is required.');
    await this.db.$transaction(async tx => {
      await tx.cpanelMailboxChange.update({ where: { id: change.id }, data: { status: 'COMPLETED', activeEmail: null, encryptedPassword: null, encryptionIv: null, encryptionAuthTag: null, encryptionVersion: null, errorCode: 'CPANEL_CHANGE_ABANDONED', completedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: request.user.id, action: 'CPANEL_MAILBOX_CHANGE_ABANDONED', entityType: 'CpanelMailboxChange', entityId: change.id, ipAddress: request.ip, metadata: { accountId: account.id, email: change.email } } });
    });
    return { abandoned: true };
  }
  @Post(':mailboxId/quota')
  async quota(@Param('accountId') accountId: string, @Param('mailboxId') mailboxId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const { account, mailbox, discovery } = await this.mapped(accountId, mailboxId);
    const { quotaMb } = parse(quotaInput, body);
    cpanelQuota(quotaMb);
    await this.noPending(mailbox.email);
    try { await this.client(account).changeMailboxQuota(mailbox.email, quotaMb); }
    catch (error) { const failure = classifyCpanelError(error); throw problem(failure.code, failure.message); }
    try {
      await this.db.$transaction(async tx => {
        await tx.cpanelDiscoveredMailbox.update({ where: { id: discovery.id }, data: { quotaBytes: quotaMb === null ? null : BigInt(quotaMb) * 1048576n, unlimitedQuota: quotaMb === null } });
        await tx.auditLog.create({ data: { userId: request.user.id, action: 'CPANEL_MAILBOX_QUOTA_CHANGED', entityType: 'Mailbox', entityId: mailbox.id, ipAddress: request.ip, metadata: { accountId: account.id, quotaMb } } });
      });
    } catch { throw problem('CPANEL_LOCAL_UPDATE_FAILED', 'cPanel changed the quota, but local status did not update. Run discovery to reconcile.'); }
    return { mailboxId: mailbox.id, quotaMb, unlimited: quotaMb === null };
  }
  @Post(':mailboxId/suspension')
  async suspension(@Param('accountId') accountId: string, @Param('mailboxId') mailboxId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const { account, mailbox, discovery } = await this.mapped(accountId, mailboxId);
    const input = parse(suspensionInput, body);
    if (input.confirmEmail !== mailbox.email) throw problem('CONFIRMATION_REQUIRED', 'Type the exact mailbox address to confirm.', 400);
    await this.noPending(mailbox.email);
    try { await this.client(account).setMailboxSuspended(mailbox.email, input.suspended); }
    catch { throw problem('CPANEL_SUSPENSION_UNCERTAIN', 'cPanel did not confirm every suspension step. Inspect cPanel and run discovery before retrying.'); }
    try {
      await this.db.$transaction(async tx => {
        await tx.cpanelDiscoveredMailbox.update({ where: { id: discovery.id }, data: { suspended: input.suspended } });
        await tx.mailbox.update({ where: { id: mailbox.id }, data: { isActive: !input.suspended, status: input.suspended ? 'DISABLED' : 'UNKNOWN' } });
        await tx.auditLog.create({ data: { userId: request.user.id, action: input.suspended ? 'CPANEL_MAILBOX_SUSPENDED' : 'CPANEL_MAILBOX_UNSUSPENDED', entityType: 'Mailbox', entityId: mailbox.id, ipAddress: request.ip, metadata: { accountId: account.id } } });
      });
    } catch { throw problem('CPANEL_LOCAL_UPDATE_FAILED', 'cPanel changed suspension, but local status did not update. Reconcile manually.'); }
    return { mailboxId: mailbox.id, suspended: input.suspended };
  }
  @Post(':mailboxId/delete-from-cpanel')
  @HttpCode(200)
  async remove(@Param('accountId') accountId: string, @Param('mailboxId') mailboxId: string, @Body() body: unknown, @Req() request: AuthedRequest) {
    const { account, mailbox, discovery } = await this.mapped(accountId, mailboxId);
    const { confirmEmail } = parse(confirmInput, body);
    if (confirmEmail !== mailbox.email) throw problem('CONFIRMATION_REQUIRED', 'Type the exact mailbox address to confirm deletion.', 400);
    await this.noPending(mailbox.email);
    try { await this.client(account).deleteMailbox(mailbox.email); }
    catch (error) { const failure = classifyCpanelError(error); throw problem(failure.code, failure.message); }
    try {
      await this.db.$transaction(async tx => {
        await tx.mailbox.update({ where: { id: mailbox.id }, data: { isActive: false, status: 'DISABLED', lastError: 'Mailbox deleted from cPanel.' } });
        await tx.cpanelDiscoveredMailbox.update({ where: { id: discovery.id }, data: { state: 'MISSING' } });
        await tx.auditLog.create({ data: { userId: request.user.id, action: 'CPANEL_MAILBOX_DELETED', entityType: 'Mailbox', entityId: mailbox.id, ipAddress: request.ip, metadata: { accountId: account.id } } });
      });
    } catch { throw problem('CPANEL_LOCAL_UPDATE_FAILED', 'cPanel deleted the mailbox, but local status did not update. Run discovery to reconcile.'); }
    return { deletedFromCpanel: true, managedHistoryPreserved: true, mailboxId: mailbox.id };
  }
}
