export type Health = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
export type Check = { status: Health; summary: string; errorCode: string | null; details?: Record<string, unknown>; latencyMs?: number };
export function issueDecision(hasOpenIssue: boolean, status: Health): 'CREATE' | 'UPDATE' | 'RESOLVE' | 'KEEP' {
  if (status === 'UNKNOWN') return 'KEEP';
  if (status === 'HEALTHY') return hasOpenIssue ? 'RESOLVE' : 'KEEP';
  return hasOpenIssue ? 'UPDATE' : 'CREATE';
}

export function syncHealth(latest: { status: string; completedAt: Date | null; errorCode?: string | null } | null, now: Date, warningMinutes: number, criticalMinutes: number, intervalMinutes: number): Check {
  if (!latest) return { status: 'UNKNOWN', summary: 'No synchronization has completed yet.', errorCode: null };
  if (latest.status === 'FAILED') return { status: 'CRITICAL', summary: 'Latest synchronization failed.', errorCode: latest.errorCode ?? 'SYNC_FAILED' };
  if (latest.status === 'RUNNING') return { status: 'UNKNOWN', summary: 'Synchronization is running.', errorCode: null };
  if (!latest.completedAt) return { status: 'UNKNOWN', summary: 'Synchronization completion time is unavailable.', errorCode: null };
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - latest.completedAt.getTime()) / 60000));
  const critical = Math.max(criticalMinutes, intervalMinutes * 3);
  const warning = Math.max(warningMinutes, intervalMinutes * 2);
  if (ageMinutes >= critical) return { status: 'CRITICAL', summary: `Synchronization is ${ageMinutes} minutes old.`, errorCode: 'SYNC_STALE', details: { ageMinutes } };
  if (ageMinutes >= warning || latest.status === 'PARTIAL') return { status: 'WARNING', summary: latest.status === 'PARTIAL' ? 'Latest synchronization was partial.' : `Synchronization is ${ageMinutes} minutes old.`, errorCode: latest.status === 'PARTIAL' ? 'SYNC_PARTIAL' : 'SYNC_STALE', details: { ageMinutes } };
  return { status: 'HEALTHY', summary: `Synchronized ${ageMinutes} minutes ago.`, errorCode: null, details: { ageMinutes } };
}

export function quotaHealth(input: { usedBytes: bigint | null; quotaBytes: bigint | null; unlimitedQuota: boolean } | null, warning: number, critical: number): Check {
  if (!input) return { status: 'UNKNOWN', summary: 'No cPanel quota data is available.', errorCode: null };
  if (input.unlimitedQuota) return { status: 'UNKNOWN', summary: 'Quota is unlimited; usage percentage does not apply.', errorCode: null, details: { unlimited: true } };
  if (input.usedBytes === null || input.quotaBytes === null || input.quotaBytes <= 0n || input.usedBytes < 0n) return { status: 'UNKNOWN', summary: 'Quota is unknown.', errorCode: null };
  const percent = Number(input.usedBytes * 10000n / input.quotaBytes) / 100;
  const details = { usedBytes: input.usedBytes.toString(), quotaBytes: input.quotaBytes.toString(), percent };
  if (percent >= critical) return { status: 'CRITICAL', summary: `Mailbox quota is ${percent}% used.`, errorCode: 'MAILBOX_QUOTA_CRITICAL', details };
  if (percent >= warning) return { status: 'WARNING', summary: `Mailbox quota is ${percent}% used.`, errorCode: 'MAILBOX_QUOTA_WARNING', details };
  return { status: 'HEALTHY', summary: `Mailbox quota is ${percent}% used.`, errorCode: null, details };
}

export function connectionHealth(check: { status: string; errorCode: string | null; configVersion: number } | null, configVersion: number, protocol: 'IMAP' | 'SMTP', credentialReady: boolean): Check {
  if (!credentialReady) return { status: 'WARNING', summary: `${protocol} credentials are not configured.`, errorCode: 'MAIL_CREDENTIAL_NOT_CONFIGURED' };
  if (!check || check.configVersion !== configVersion) return { status: 'UNKNOWN', summary: `${protocol} has not been tested with current settings.`, errorCode: null };
  return check.status === 'SUCCESS'
    ? { status: 'HEALTHY', summary: `${protocol} connection and authentication succeeded.`, errorCode: null }
    : { status: 'CRITICAL', summary: `${protocol} connection test failed.`, errorCode: check.errorCode ?? `${protocol}_CONNECTION_FAILED` };
}

export function heartbeatHealth(lastAt: Date | null, now: Date, timeoutSeconds: number): Check {
  if (!lastAt || now.getTime() - lastAt.getTime() > timeoutSeconds * 1000) return { status: 'CRITICAL', summary: 'Worker heartbeat is missing or stale.', errorCode: 'WORKER_HEARTBEAT_STALE' };
  return { status: 'HEALTHY', summary: 'Worker heartbeat is current.', errorCode: null, details: { lastHeartbeatAt: lastAt.toISOString() } };
}

export function queueHealth(counts: { waiting: number; active: number; delayed: number; failed: number }, backlog: number): Check {
  if (counts.failed > 0) return { status: 'WARNING', summary: `${counts.failed} queue jobs failed.`, errorCode: 'QUEUE_FAILED_JOBS', details: counts };
  if (counts.waiting > backlog) return { status: 'WARNING', summary: `${counts.waiting} jobs are waiting.`, errorCode: 'QUEUE_BACKLOG', details: counts };
  return { status: 'HEALTHY', summary: 'Queue is responding within configured limits.', errorCode: null, details: counts };
}

export function tlsHealth(validTo: Date, now: Date, warningDays: number): Check {
  const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / 86400000);
  if (daysRemaining < 0) return { status: 'CRITICAL', summary: 'TLS certificate has expired.', errorCode: 'TLS_CERT_EXPIRED', details: { daysRemaining } };
  if (daysRemaining < warningDays) return { status: 'WARNING', summary: `TLS certificate expires in ${daysRemaining} days.`, errorCode: 'TLS_CERT_EXPIRING', details: { daysRemaining } };
  return { status: 'HEALTHY', summary: `TLS certificate is valid for ${daysRemaining} more days.`, errorCode: null, details: { daysRemaining } };
}

export function mxHealth(records: { exchange: string; priority: number }[]): Check {
  if (!records.length) return { status: 'CRITICAL', summary: 'No MX records were found.', errorCode: 'MX_MISSING' };
  return { status: 'HEALTHY', summary: `${records.length} MX record${records.length === 1 ? '' : 's'} found.`, errorCode: null, details: { records: records.slice(0, 10) } };
}

export function spfHealth(records: string[]): Check {
  const spf = records.filter(value => /^v=spf1(?:\s|$)/i.test(value));
  if (!spf.length) return { status: 'WARNING', summary: 'No SPF record was found.', errorCode: 'SPF_MISSING' };
  if (spf.length > 1) return { status: 'WARNING', summary: 'Multiple SPF records were found.', errorCode: 'SPF_MULTIPLE_RECORDS', details: { records: spf.slice(0, 5) } };
  if (spf[0]!.length > 4500 || /[\r\n]/.test(spf[0]!)) return { status: 'WARNING', summary: 'SPF record appears malformed.', errorCode: 'SPF_INVALID' };
  return { status: 'HEALTHY', summary: 'One SPF record was found.', errorCode: null, details: { record: spf[0] } };
}

export function dmarcHealth(records: string[]): Check {
  const dmarc = records.filter(value => /^v=DMARC1(?:;|\s|$)/i.test(value));
  if (!dmarc.length) return { status: 'WARNING', summary: 'No DMARC record was found.', errorCode: 'DMARC_MISSING' };
  if (dmarc.length > 1) return { status: 'WARNING', summary: 'Multiple DMARC records were found.', errorCode: 'DMARC_MULTIPLE_RECORDS' };
  const policy = dmarc[0]!.match(/(?:^|;)\s*p\s*=\s*(none|quarantine|reject)(?:\s*;|\s*$)/i)?.[1]?.toLowerCase();
  if (!policy) return { status: 'WARNING', summary: 'DMARC policy is missing or malformed.', errorCode: 'DMARC_INVALID' };
  return { status: 'HEALTHY', summary: `DMARC policy is ${policy}.`, errorCode: null, details: { policy, record: dmarc[0] } };
}

export function dkimHealth(selector: string | null, records: string[]): Check {
  if (!selector) return { status: 'UNKNOWN', summary: 'No DKIM selector is configured.', errorCode: 'DKIM_NOT_CONFIGURED' };
  const keys = records.filter(value => {
    if (/\bv\s*=/.test(value) && !/(?:^|;)\s*v\s*=\s*DKIM1(?:\s*;|\s*$)/i.test(value)) return false;
    const key = value.match(/(?:^|;)\s*p\s*=\s*([^\s;]+)/i)?.[1];
    return !!key && key.length >= 40 && /^[A-Za-z0-9+/]+={0,2}$/.test(key);
  });
  if (keys.length !== 1) return { status: 'WARNING', summary: keys.length ? 'Multiple DKIM keys were found.' : `DKIM key for ${selector} was not found.`, errorCode: 'DKIM_RECORD_MISSING' };
  return { status: 'HEALTHY', summary: `DKIM key for ${selector} was found.`, errorCode: null, details: { selector } };
}
