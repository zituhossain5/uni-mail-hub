import net from 'node:net';
import tls from 'node:tls';
import { Check, tlsHealth } from './monitoring-rules';

type Protocol = 'IMAP' | 'SMTP';
type Security = 'NONE' | 'STARTTLS' | 'TLS';

function lines(socket: net.Socket) {
  let buffer = '';
  const ready: string[] = [];
  const waiting: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 16384) { socket.destroy(new Error('TLS_GREETING_TOO_LARGE')); return; }
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end).trimEnd();
      buffer = buffer.slice(end + 1);
      const next = waiting.shift();
      if (next) next.resolve(line); else ready.push(line);
    }
  };
  const onError = (error: Error) => { while (waiting.length) waiting.shift()!.reject(error); };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', () => onError(new Error('TLS_CONNECTION_CLOSED')));
  return {
    read: () => ready.length ? Promise.resolve(ready.shift()!) : new Promise<string>((resolve, reject) => waiting.push({ resolve, reject })),
    close: () => { socket.off('data', onData); socket.off('error', onError); },
  };
}

async function plainSocket(host: string, port: number) {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timeout = setTimeout(() => socket.destroy(new Error('TLS_TIMEOUT')), 8000);
    socket.once('connect', () => { clearTimeout(timeout); socket.setTimeout(8000, () => socket.destroy(new Error('TLS_TIMEOUT'))); resolve(socket); });
    socket.once('error', error => { clearTimeout(timeout); reject(error); });
  });
}

async function startTls(socket: net.Socket, protocol: Protocol) {
  const reader = lines(socket);
  try {
    const greeting = await reader.read();
    if (protocol === 'IMAP') {
      if (!/^\* OK\b/i.test(greeting)) throw new Error('TLS_PROTOCOL_FAILED');
      socket.write('a1 STARTTLS\r\n');
      let response = await reader.read();
      for (let index = 0; index < 20 && !/^a1\s/i.test(response); index++) response = await reader.read();
      if (!/^a1 OK\b/i.test(response)) throw new Error('TLS_STARTTLS_UNAVAILABLE');
    } else {
      if (!/^220[ -]/.test(greeting)) throw new Error('TLS_PROTOCOL_FAILED');
      socket.write('EHLO monitoring.local\r\n');
      let response = await reader.read();
      let capabilities = response;
      while (/^250-/.test(response)) { response = await reader.read(); capabilities += `\n${response}`; }
      if (!/^250 /.test(response) || !/\bSTARTTLS\b/i.test(capabilities)) throw new Error('TLS_STARTTLS_UNAVAILABLE');
      socket.write('STARTTLS\r\n');
      if (!/^220[ -]/.test(await reader.read())) throw new Error('TLS_STARTTLS_UNAVAILABLE');
    }
  } finally { reader.close(); }
}

async function verifiedSocket(host: string, port: number, protocol: Protocol, security: Security) {
  const raw = security === 'STARTTLS' ? await plainSocket(host, port) : null;
  try {
    if (raw) await startTls(raw, protocol);
    return await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect({ ...(raw ? { socket: raw } : { host, port }), servername: host, rejectUnauthorized: true });
      const timeout = setTimeout(() => socket.destroy(new Error('TLS_TIMEOUT')), 8000);
      socket.once('secureConnect', () => { clearTimeout(timeout); resolve(socket); });
      socket.once('error', error => { clearTimeout(timeout); reject(error); });
    });
  } catch (error) { raw?.destroy(); throw error; }
}

export async function inspectMailTls(host: string, port: number, protocol: Protocol, security: Security, now: Date, warningDays: number): Promise<Check> {
  if (security === 'NONE') return { status: 'UNKNOWN', summary: 'TLS is not configured for this endpoint.', errorCode: null };
  const started = Date.now();
  try {
    const socket = await verifiedSocket(host, port, protocol, security);
    try {
      const certificate = socket.getPeerCertificate();
      if (!certificate?.valid_to) return { status: 'CRITICAL', summary: 'TLS peer certificate is unavailable.', errorCode: 'TLS_CERT_INVALID' };
      const result = tlsHealth(new Date(certificate.valid_to), now, warningDays);
      return { ...result, latencyMs: Date.now() - started, details: { ...result.details, subject: String(certificate.subject?.CN ?? '').slice(0, 200), issuer: String(certificate.issuer?.CN ?? '').slice(0, 200), validFrom: certificate.valid_from, validTo: certificate.valid_to, hostnameValidated: true } };
    } finally { socket.destroy(); }
  } catch (error) {
    return tlsFailure(error);
  }
}

export function tlsFailure(error: unknown): Check {
  const code = String((error as { code?: string }).code ?? (error as Error).message ?? '');
  const normalized = code.includes('EXPIRED') ? 'TLS_CERT_EXPIRED' : code.includes('ALTNAME') || code.includes('CERT') || code.includes('VERIFY') ? 'TLS_CERT_INVALID' : code === 'TLS_STARTTLS_UNAVAILABLE' ? code : 'TLS_CONNECTION_FAILED';
  return { status: 'CRITICAL', summary: normalized === 'TLS_CERT_INVALID' ? 'TLS certificate or hostname validation failed.' : normalized === 'TLS_CERT_EXPIRED' ? 'TLS certificate has expired.' : 'TLS connection failed.', errorCode: normalized };
}
