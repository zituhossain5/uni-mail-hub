import type { PrismaClient } from '@uni/database';
import { CpanelClient, CpanelError, classifyCpanelError, type DiscoveredForwarder, type DiscoveredMailbox } from '@uni/mail';
import { decryptSecret } from '@uni/security';
import type pino from 'pino';

export function reconcileMailboxState(managedMailboxId: string | null, ignored: boolean): 'MANAGED' | 'DISCOVERED' | 'IGNORED' {
  return managedMailboxId ? 'MANAGED' : ignored ? 'IGNORED' : 'DISCOVERED';
}
export function missingEmails(previous: string[], current: string[]): string[] {
  const seen = new Set(current.map(value => value.toLowerCase()));
  return previous.filter(value => !seen.has(value.toLowerCase()));
}
export async function collectCpanelDiscovery(client: Pick<CpanelClient, 'listDomains' | 'listMailboxes' | 'listForwarders'>): Promise<{ domains: string[] | null; mailboxes: DiscoveredMailbox[] | null; forwardersByDomain: Map<string, DiscoveredForwarder[]>; failures: CpanelError[] }> {
  const [domainResult, mailboxResult] = await Promise.allSettled([client.listDomains(), client.listMailboxes()]);
  const domains = domainResult.status === 'fulfilled' ? domainResult.value : null;
  const mailboxes = mailboxResult.status === 'fulfilled' ? mailboxResult.value : null;
  const failures: CpanelError[] = [];
  if (domainResult.status === 'rejected') failures.push(classifyCpanelError(domainResult.reason));
  if (mailboxResult.status === 'rejected') failures.push(classifyCpanelError(mailboxResult.reason));
  const forwardersByDomain = new Map<string, DiscoveredForwarder[]>();
  if (domains) for (const domain of domains) {
    try { forwardersByDomain.set(domain, await client.listForwarders(domain)); }
    catch (error) { failures.push(classifyCpanelError(error)); }
  }
  return { domains, mailboxes, forwardersByDomain, failures };
}

export async function processCpanelDiscovery(db: PrismaClient, key: Buffer, log: pino.Logger, runId: string) {
  const claimed = await db.cpanelDiscoveryRun.updateMany({ where: { id: runId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
  if (!claimed.count) return;
  const run = await db.cpanelDiscoveryRun.findUniqueOrThrow({ where: { id: runId }, include: { account: true } });
  const account = run.account;
  if (account.status !== 'ACTIVE') {
    await db.cpanelDiscoveryRun.update({ where: { id: runId }, data: { status: 'FAILED', completedAt: new Date(), errorCode: 'CPANEL_ACCOUNT_DISABLED', errorMessage: 'Account is disabled.' } });
    return;
  }
  let domains: string[] | null = null;
  let mailboxes: DiscoveredMailbox[] | null = null;
  let forwardersFound = 0;
  try {
    const client = new CpanelClient({ host: account.host, port: account.port, username: account.username, apiToken: decryptSecret({ encryptedPassword: account.encryptedApiToken, encryptionIv: account.encryptionIv, encryptionAuthTag: account.encryptionAuthTag, encryptionVersion: account.encryptionVersion }, key) });
    const collected = await collectCpanelDiscovery(client);
    domains = collected.domains;
    mailboxes = collected.mailboxes;
    const failures = collected.failures;
    // Forwarders are optional. A role restriction does not erase other discovery results.
    for (const [domain, forwarders] of collected.forwardersByDomain) {
        await db.$transaction(async tx => {
          for (const item of forwarders) await tx.cpanelDiscoveredForwarder.upsert({ where: { accountId_domain_source_destination: { accountId: account.id, domain: item.domain, source: item.source, destination: item.destination } }, create: { accountId: account.id, ...item }, update: { lastSeenAt: new Date() } });
          await tx.cpanelDiscoveredForwarder.deleteMany({ where: { accountId: account.id, domain, lastSeenAt: { lt: run.startedAt! } } });
        });
        forwardersFound += forwarders.length;
    }
    let newItems = 0;
    let missingItems = 0;
    const now = new Date();
    if (domains) {
      const managed = await db.domain.findMany({ where: { domain: { in: domains } }, select: { id: true, domain: true } });
      const byDomain = new Map(managed.map(item => [item.domain.toLowerCase(), item.id]));
      const prior = await db.cpanelDiscoveredDomain.findMany({ where: { accountId: account.id }, select: { domain: true, state: true } });
      const priorMap = new Map(prior.map(item => [item.domain, item.state]));
      await db.$transaction(async tx => {
        for (const domain of domains!) {
          const managedDomainId = byDomain.get(domain) ?? null;
          const state = managedDomainId ? 'MANAGED' : priorMap.get(domain) === 'IGNORED' ? 'IGNORED' : 'DISCOVERED';
          if (!priorMap.has(domain) && !managedDomainId) newItems++;
          await tx.cpanelDiscoveredDomain.upsert({ where: { accountId_domain: { accountId: account.id, domain } }, create: { accountId: account.id, domain, state, managedDomainId, lastSeenAt: now }, update: { state, managedDomainId, lastSeenAt: now } });
        }
        for (const domain of missingEmails(prior.filter(item => item.state !== 'IGNORED').map(item => item.domain), domains!)) {
          await tx.cpanelDiscoveredDomain.update({ where: { accountId_domain: { accountId: account.id, domain } }, data: { state: 'MISSING' } });
          missingItems++;
        }
      });
    }
    if (mailboxes) {
      const existing = await db.mailbox.findMany({ where: { email: { in: mailboxes.map(item => item.email), mode: 'insensitive' } }, select: { id: true, email: true } });
      const managed = new Map(existing.map(item => [item.email.toLowerCase(), item.id]));
      const prior = await db.cpanelDiscoveredMailbox.findMany({ where: { accountId: account.id }, select: { email: true, state: true } });
      const priorMap = new Map(prior.map(item => [item.email, item.state]));
      await db.$transaction(async tx => {
        for (const item of mailboxes!) {
          const managedMailboxId = managed.get(item.email) ?? null;
          const state = reconcileMailboxState(managedMailboxId, priorMap.get(item.email) === 'IGNORED');
          if (!priorMap.has(item.email) && !managedMailboxId) newItems++;
          await tx.cpanelDiscoveredMailbox.upsert({ where: { accountId_email: { accountId: account.id, email: item.email } }, create: { accountId: account.id, ...item, state, managedMailboxId, lastSeenAt: now }, update: { ...item, state, managedMailboxId, lastSeenAt: now } });
        }
        for (const email of domains ? missingEmails(prior.filter(item => item.state !== 'IGNORED').map(item => item.email), mailboxes!.map(item => item.email)) : []) {
          await tx.cpanelDiscoveredMailbox.update({ where: { accountId_email: { accountId: account.id, email } }, data: { state: 'MISSING' } });
          missingItems++;
        }
      });
    }
    const status = failures.length ? domains || mailboxes ? 'PARTIAL' : 'FAILED' : 'SUCCESS';
    const primary = failures[0];
    await db.$transaction(async tx => {
      await tx.cpanelDiscoveryRun.update({ where: { id: runId }, data: { status, completedAt: new Date(), domainsFound: domains?.length ?? 0, mailboxesFound: mailboxes?.length ?? 0, forwardersFound, newItems, missingItems, errorCode: primary?.code ?? null, errorMessage: primary?.message ?? null } });
      await tx.cpanelAccount.update({ where: { id: account.id }, data: { lastDiscoveryAt: new Date(), lastError: primary?.message ?? null, connectionStatus: status === 'FAILED' ? 'CONNECTION_FAILED' : 'CONNECTED', ...(status !== 'FAILED' ? { lastConnectedAt: new Date() } : {}) } });
      await tx.auditLog.create({ data: { userId: run.requestedByUserId, action: 'CPANEL_DISCOVERY_COMPLETED', entityType: 'CpanelAccount', entityId: account.id, metadata: { runId, status, domainsFound: domains?.length ?? 0, mailboxesFound: mailboxes?.length ?? 0, forwardersFound } } });
    });
  } catch (error) {
    const failure = classifyCpanelError(error);
    log.warn({ accountId: account.id, runId, errorCode: failure.code }, 'cPanel discovery failed');
    await db.$transaction(async tx => {
      await tx.cpanelDiscoveryRun.update({ where: { id: runId }, data: { status: 'FAILED', completedAt: new Date(), errorCode: failure.code, errorMessage: failure.message } });
      await tx.cpanelAccount.update({ where: { id: account.id }, data: { lastError: failure.message, connectionStatus: 'CONNECTION_FAILED' } });
      await tx.auditLog.create({ data: { userId: run.requestedByUserId, action: 'CPANEL_DISCOVERY_COMPLETED', entityType: 'CpanelAccount', entityId: account.id, metadata: { runId, status: 'FAILED', errorCode: failure.code } } });
    });
  }
}
