import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

export type CpanelEndpoint = { host: string; port: number; username: string; apiToken: string };
export type DiscoveredMailbox = { email: string; domain: string; usedBytes: bigint | null; quotaBytes: bigint | null; unlimitedQuota: boolean; suspended: boolean | null };
export type DiscoveredForwarder = { domain: string; source: string; destination: string };
export class CpanelError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CpanelError'; }
}

const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const emailPattern = /^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
export function normalizeDomain(value: unknown): string | null { const domain = String(value ?? '').trim().toLowerCase(); return domainPattern.test(domain) && domain.length <= 253 ? domain : null; }
export function normalizeEmail(value: unknown): string | null { const email = String(value ?? '').trim().toLowerCase(); return emailPattern.test(email) && email.length <= 320 ? email : null; }
export function validateCpanelHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (!(domainPattern.test(host) || isIP(host) === 4) || host.length > 253 || host.endsWith('.local') || host.endsWith('.internal') || isIP(host) === 4 && !publicAddress(host)) throw new CpanelError('CPANEL_INVALID_HOST', 'Enter a public cPanel hostname or IPv4 address.');
  return host;
}
function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 100 && b! >= 64 && b! <= 127 || a === 192 && b === 0 && c === 0 || a === 198 && b! >= 18 && b! <= 19);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    return !(lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff') || lower.startsWith('::ffff:'));
  }
  return false;
}
export async function resolveCpanelHost(host: string): Promise<{ address: string; family: 4 | 6 }> {
  validateCpanelHost(host);
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([lookup(host, { all: true, verbatim: true }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new CpanelError('CPANEL_TIMEOUT', 'cPanel DNS lookup timed out.')), 5000); })]);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new CpanelError('CPANEL_INVALID_HOST', 'cPanel host resolves to a blocked address.');
    return { address: addresses[0]!.address, family: addresses[0]!.family as 4 | 6 };
  } catch (error) {
    if (error instanceof CpanelError) throw error;
    throw new CpanelError('CPANEL_CONNECTION_FAILED', 'cPanel host could not be resolved.');
  } finally { if (timer) clearTimeout(timer); }
}
type Data = Record<string, unknown>;
function record(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}; }
function rows(value: unknown): Data[] { return Array.isArray(value) ? value.map(record) : []; }
function bytes(value: unknown): bigint | null { if (typeof value !== 'string' && typeof value !== 'number') return null; const raw = String(value); return /^\d+$/.test(raw) ? BigInt(raw) : null; }
export function parseUapiResponse(payload: string): unknown {
  let envelope: Data;
  try { envelope = record(JSON.parse(payload)); } catch { throw new CpanelError('CPANEL_API_ERROR', 'cPanel returned an invalid response.'); }
  const result = record(envelope.result);
  if (result.status !== 1 && result.status !== true) {
    const errors = Array.isArray(result.errors) ? result.errors.map(String).join(' ').toLowerCase() : '';
    const code = errors.includes('permission') || errors.includes('feature') ? 'CPANEL_PERMISSION_DENIED' : errors.includes('auth') || errors.includes('token') ? 'CPANEL_AUTH_FAILED' : 'CPANEL_API_ERROR';
    throw new CpanelError(code, code === 'CPANEL_PERMISSION_DENIED' ? 'cPanel access to this feature is disabled.' : code === 'CPANEL_AUTH_FAILED' ? 'cPanel rejected the API token.' : 'cPanel API request failed.');
  }
  return result.data;
}

export function parseDomains(data: unknown): string[] {
  const source = record(data);
  const domains = [source.main_domain, ...(['addon_domains', 'sub_domains', 'parked_domains'] as const).flatMap(key => Array.isArray(source[key]) ? source[key] as unknown[] : [])];
  return [...new Set(domains.map(normalizeDomain).filter((value): value is string => !!value))];
}
export function parseMailboxes(data: unknown): DiscoveredMailbox[] {
  const seen = new Set<string>();
  return rows(data).flatMap(item => {
    const email = normalizeEmail(item.email ?? item.login);
    if (!email || seen.has(email)) return [];
    seen.add(email);
    const quotaText = String(item.diskquota ?? item.txtdiskquota ?? '').toLowerCase();
    const unlimitedQuota = quotaText === 'unlimited' || quotaText === '∞';
    const quotaMb = bytes(item.diskquota ?? item.txtdiskquota);
    const usedMb = bytes(item.diskused);
    const quotaBytes = unlimitedQuota ? null : bytes(item._diskquota) ?? (quotaMb === null ? null : quotaMb * 1048576n);
    const usedBytes = bytes(item._diskused) ?? (usedMb === null ? null : usedMb * 1048576n);
    const flags = [item.suspended_login, item.suspended_incoming, item.suspended_outgoing];
    const suspended = flags.some(v => v === 1 || v === '1' || v === true) ? true : flags.some(v => v === 0 || v === '0' || v === false) ? false : null;
    return [{ email, domain: email.split('@')[1]!, usedBytes, quotaBytes, unlimitedQuota, suspended }];
  });
}
export function parseForwarders(data: unknown, domain: string): DiscoveredForwarder[] {
  return rows(data).flatMap(item => {
    const source = normalizeEmail(item.dest ?? item.email);
    const destination = typeof item.forward === 'string' ? item.forward.trim() : typeof item.to === 'string' ? item.to.trim() : '';
    return source && destination && destination.length <= 1000 ? [{ domain, source, destination }] : [];
  });
}
export function classifyCpanelError(error: unknown): CpanelError {
  if (error instanceof CpanelError) return error;
  const item = error as { code?: string; message?: string };
  const code = String(item?.code ?? '').toUpperCase();
  const message = String(item?.message ?? '').toLowerCase();
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code) || message.includes('timeout')) return new CpanelError('CPANEL_TIMEOUT', 'cPanel request timed out.');
  if (code.includes('CERT') || code.includes('TLS') || code.includes('SSL') || message.includes('certificate')) return new CpanelError('CPANEL_TLS_FAILED', 'cPanel TLS validation failed.');
  return new CpanelError('CPANEL_CONNECTION_FAILED', 'Could not connect to cPanel.');
}
export class CpanelClient {
  private readonly host: string;
  constructor(private readonly endpoint: CpanelEndpoint) {
    this.host = validateCpanelHost(endpoint.host);
    if (endpoint.port !== 2083 || !/^[a-z0-9_-]{1,32}$/.test(endpoint.username) || !endpoint.apiToken) throw new CpanelError('CPANEL_INVALID_CONFIG', 'Invalid cPanel connection settings.');
  }
  private async call(module: 'DomainInfo' | 'Email', fn: 'list_domains' | 'list_pops_with_disk' | 'list_forwarders', params?: Record<string, string>): Promise<unknown> {
    const resolved = await resolveCpanelHost(this.host);
    const query = new URLSearchParams(params).toString();
    const path = `/execute/${module}/${fn}${query ? `?${query}` : ''}`;
    const payload = await new Promise<string>((resolve, reject) => {
      const req = request({ hostname: this.host, port: 2083, path, method: 'GET', servername: this.host, agent: false,
        lookup: (_host, _opts, callback) => callback(null, resolved.address, resolved.family),
        headers: { Authorization: `cpanel ${this.endpoint.username}:${this.endpoint.apiToken}`, Accept: 'application/json' }, timeout: 10000 }, response => {
        if (response.statusCode === 401 || response.statusCode === 403) { response.resume(); reject(new CpanelError('CPANEL_AUTH_FAILED', 'cPanel rejected the API token.')); return; }
        if (response.statusCode !== 200) { response.resume(); reject(new CpanelError('CPANEL_API_ERROR', 'cPanel API request failed.')); return; }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(new CpanelError('CPANEL_API_ERROR', 'cPanel response exceeded the size limit.')); });
        response.on('end', () => resolve(body)); response.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new CpanelError('CPANEL_TIMEOUT', 'cPanel request timed out.')));
      req.on('error', reject); req.end();
    }).catch(error => { throw classifyCpanelError(error); });
    return parseUapiResponse(payload);
  }
  async testConnection() { await this.listDomains(); return { status: 'CONNECTED' as const }; }
  async listDomains() {
    const data = await this.call('DomainInfo', 'list_domains');
    const domains = parseDomains(data);
    if (!domains.length) throw new CpanelError('CPANEL_API_ERROR', 'cPanel returned no readable domains.');
    return domains;
  }
  async listMailboxes() {
    const data = await this.call('Email', 'list_pops_with_disk', { get_restrictions: '1' });
    if (!Array.isArray(data)) throw new CpanelError('CPANEL_API_ERROR', 'cPanel returned an invalid mailbox list.');
    if (data.some(item => {
      const row = record(item);
      return String(row.email ?? '').toLowerCase() !== 'main account' && !normalizeEmail(row.email ?? row.login);
    })) throw new CpanelError('CPANEL_API_ERROR', 'cPanel returned an unrecognized mailbox record.');
    return parseMailboxes(data);
  }
  async listForwarders(domain: string) {
    const data = await this.call('Email', 'list_forwarders', { domain });
    if (!Array.isArray(data)) throw new CpanelError('CPANEL_API_ERROR', 'cPanel returned an invalid forwarder list.');
    return parseForwarders(data, domain);
  }
}
