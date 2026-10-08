import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
export * from './cpanel';

export type Protocol = 'IMAP' | 'SMTP';
export type Security = 'NONE' | 'STARTTLS' | 'TLS';
export type ConnectionResult = { status: 'SUCCESS' | 'FAILED'; latencyMs: number; errorCode: string | null; message: string };
export type Endpoint = { host: string; port: number; security: Security };
export function createSmtpTransport(endpoint: Endpoint, auth: { user: string; pass: string } | null) {
  return nodemailer.createTransport({ host: endpoint.host, port: endpoint.port, secure: endpoint.security === 'TLS', requireTLS: endpoint.security === 'STARTTLS', ignoreTLS: endpoint.security === 'NONE', auth: auth ?? undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
}

export function classifyConnectionError(protocol: Protocol, error: unknown): { errorCode: string; message: string } {
  const e = error as { code?: string; responseCode?: number; message?: string; authenticationFailed?: boolean };
  const code = String(e?.code ?? '').toUpperCase();
  const message = String(e?.message ?? '').toLowerCase();
  let reason = 'CONNECTION_FAILED';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) reason = 'DNS_FAILED';
  else if (code === 'ECONNREFUSED') reason = 'CONNECTION_REFUSED';
  else if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ETIMEOUT'].includes(code) || message.includes('timeout')) reason = 'TIMEOUT';
  else if (code.includes('TLS') || code.includes('CERT') || message.includes('certificate') || message.includes('tls') || message.includes('ssl')) reason = 'TLS_FAILED';
  else if (e?.authenticationFailed === true || ['EAUTH', 'AUTHENTICATIONFAILED'].includes(code) || e?.responseCode === 535 || message.includes('authentication failed') || message.includes('invalid credentials') || message.includes('login failed')) reason = 'AUTH_FAILED';
  const messages: Record<string, string> = { DNS_FAILED: 'Mail host could not be resolved.', CONNECTION_REFUSED: 'Mail server refused the connection.', TIMEOUT: 'Mail server connection timed out.', TLS_FAILED: 'TLS negotiation or certificate validation failed.', AUTH_FAILED: 'Authentication failed. Verify the mailbox username and password.', CONNECTION_FAILED: 'Mail server connection failed.' };
  return { errorCode: `${protocol}_${reason}`, message: messages[reason] ?? messages.CONNECTION_FAILED! };
}

async function measure(protocol: Protocol, operation: () => Promise<void>): Promise<ConnectionResult> {
  const started = Date.now();
  try { await operation(); return { status: 'SUCCESS', latencyMs: Date.now() - started, errorCode: null, message: 'Connected and authenticated successfully.' }; }
  catch (error) { return { status: 'FAILED', latencyMs: Date.now() - started, ...classifyConnectionError(protocol, error) }; }
}

export async function testImap(endpoint: Endpoint, username: string, password: string): Promise<ConnectionResult> {
  return measure('IMAP', async () => {
    const client = new ImapFlow({ host: endpoint.host, port: endpoint.port, secure: endpoint.security === 'TLS', doSTARTTLS: endpoint.security === 'STARTTLS', auth: { user: username, pass: password }, logger: false, disableAutoIdle: true, connectionTimeout: 6000, greetingTimeout: 6000, socketTimeout: 6000 });
    try { await client.connect(); }
    finally { if (client.usable) { try { await client.logout(); } catch { /* connection may already be closed */ } } try { client.close(); } catch { /* cleanup is best effort */ } }
  });
}

export async function testSmtp(endpoint: Endpoint, auth: { user: string; pass: string } | null): Promise<ConnectionResult> {
  const result = await measure('SMTP', async () => {
    const transport = createSmtpTransport(endpoint, auth);
    try { await transport.verify(); } finally { transport.close(); }
  });
  if (result.status === 'SUCCESS' && !auth) result.message = 'Connected successfully; authentication is disabled for this server.';
  return result;
}

export type SendRecipient = { email: string; name?: string | null };
export function classifySendError(error: unknown): { code: string; message: string; retryable: boolean; smtpResponseCode: number | null } {
  const e = error as { code?: string; responseCode?: number; message?: string };
  const responseCode = Number.isInteger(e?.responseCode) ? e.responseCode! : null;
  if (e?.code === 'EENVELOPE' && responseCode && responseCode >= 500) return { code: 'SMTP_RECIPIENT_REJECTED', message: `SMTP rejected the recipient (${responseCode}).`, retryable: false, smtpResponseCode: responseCode };
  if (responseCode && responseCode >= 400 && responseCode < 500) return { code: 'SMTP_TEMPORARY_FAILURE', message: `SMTP temporary failure (${responseCode}).`, retryable: true, smtpResponseCode: responseCode };
  if (responseCode && responseCode >= 500 && responseCode < 600) return { code: responseCode === 535 ? 'SMTP_AUTH_FAILED' : 'SMTP_PERMANENT_FAILURE', message: responseCode === 535 ? 'SMTP authentication failed.' : `SMTP permanent failure (${responseCode}).`, retryable: false, smtpResponseCode: responseCode };
  const mapped = classifyConnectionError('SMTP', error);
  const retryable = ['SMTP_TIMEOUT', 'SMTP_DNS_FAILED', 'SMTP_CONNECTION_REFUSED', 'SMTP_CONNECTION_FAILED'].includes(mapped.errorCode);
  return { code: mapped.errorCode, message: mapped.message, retryable, smtpResponseCode: responseCode };
}

export async function sendSmtp(input: { endpoint: Endpoint; auth: { user: string; pass: string } | null; from: SendRecipient; to: SendRecipient[]; cc: SendRecipient[]; bcc: SendRecipient[]; replyTo?: SendRecipient | null; subject: string; text?: string | null; html?: string | null; inReplyTo?: string | null; references?: string[] }) {
  const transport = createSmtpTransport(input.endpoint, input.auth);
  const format = (recipient: SendRecipient) => ({ address: recipient.email, name: recipient.name ?? '' });
  try {
    const result = await transport.sendMail({ from: format(input.from), to: input.to.map(format), cc: input.cc.map(format), bcc: input.bcc.map(format), replyTo: input.replyTo ? format(input.replyTo) : undefined, subject: input.subject, text: input.text ?? undefined, html: input.html ?? undefined, inReplyTo: input.inReplyTo ?? undefined, references: input.references?.length ? input.references : undefined });
    return { accepted: result.accepted.map(String).map(value => value.toLowerCase()), rejected: result.rejected.map(String).map(value => value.toLowerCase()), pending: result.pending?.map(String).map(value => value.toLowerCase()) ?? [], messageId: result.messageId, responseCode: Number(result.response?.match(/^([0-9]{3})/)?.[1]) || null };
  } finally { transport.close(); }
}

export { createSyncClient, folderSpecialUse, initialUids, advanceCursor, classifySyncError, parseSyncMessage } from './imap-sync';
export type { SyncMessage, SyncRecipient, SyncAttachment } from './imap-sync';
export { headerId, headerThreadKey, threadKeyFor } from './threading';
export { withMailboxSyncLease } from './mailbox-lease';
export { replyRecipients, responseHeaders, responseSubject, forwardedBlock } from './respond';
export { webhookEventTypes, webhookUrl, publicWebhookAddress, resolveWebhookTarget, pinnedWebhookLookupAnswer, signWebhook, verifyWebhookSignature, postWebhook } from './webhook';
export { parseDsn } from './dsn';
export type { DsnEvidence } from './dsn';
