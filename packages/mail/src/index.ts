import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

export type Protocol = 'IMAP' | 'SMTP';
export type Security = 'NONE' | 'STARTTLS' | 'TLS';
export type ConnectionResult = { status: 'SUCCESS' | 'FAILED'; latencyMs: number; errorCode: string | null; message: string };
export type Endpoint = { host: string; port: number; security: Security };

export function classifyConnectionError(protocol: Protocol, error: unknown): { errorCode: string; message: string } {
  const e = error as { code?: string; responseCode?: number; message?: string };
  const code = String(e?.code ?? '').toUpperCase();
  const message = String(e?.message ?? '').toLowerCase();
  let reason = 'CONNECTION_FAILED';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) reason = 'DNS_FAILED';
  else if (code === 'ECONNREFUSED') reason = 'CONNECTION_REFUSED';
  else if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ETIMEOUT'].includes(code) || message.includes('timeout')) reason = 'TIMEOUT';
  else if (code.includes('TLS') || code.includes('CERT') || message.includes('certificate') || message.includes('tls') || message.includes('ssl')) reason = 'TLS_FAILED';
  else if (['EAUTH', 'AUTHENTICATIONFAILED'].includes(code) || e?.responseCode === 535 || message.includes('authentication failed') || message.includes('invalid credentials') || message.includes('login failed')) reason = 'AUTH_FAILED';
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
    const transport = nodemailer.createTransport({ host: endpoint.host, port: endpoint.port, secure: endpoint.security === 'TLS', requireTLS: endpoint.security === 'STARTTLS', ignoreTLS: endpoint.security === 'NONE', auth: auth ?? undefined, connectionTimeout: 6000, greetingTimeout: 6000, socketTimeout: 6000 });
    try { await transport.verify(); } finally { transport.close(); }
  });
  if (result.status === 'SUCCESS' && !auth) result.message = 'Connected successfully; authentication is disabled for this server.';
  return result;
}
