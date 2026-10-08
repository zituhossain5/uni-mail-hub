import { resolveMx, resolveTxt } from 'node:dns/promises';
import { Check, dkimHealth, dmarcHealth, mxHealth, spfHealth } from './monitoring-rules';

type Resolver = { mx: typeof resolveMx; txt: typeof resolveTxt };
const defaultResolver: Resolver = { mx: resolveMx, txt: resolveTxt };

async function optional<T>(call: () => Promise<T>, empty: T): Promise<T> {
  try { return await call(); }
  catch (error) {
    if (['ENODATA', 'ENOTFOUND', 'NXDOMAIN'].includes(String((error as { code?: string }).code ?? ''))) return empty;
    throw error;
  }
}

function dnsFailure(): Check { return { status: 'UNKNOWN', summary: 'DNS lookup failed; result is unavailable.', errorCode: 'DNS_LOOKUP_FAILED' }; }
async function txt(name: string, resolver: Resolver): Promise<string[]> {
  return (await optional(() => resolver.txt(name), [] as string[][])).map(parts => parts.join('')).map(value => value.slice(0, 4501));
}

export async function domainChecks(domain: string, selectors: string[], resolver: Resolver = defaultResolver): Promise<Record<string, Check>> {
  const checks: Record<string, Check> = {};
  try { checks.MX = mxHealth(await optional(() => resolver.mx(domain), [])); }
  catch { checks.MX = dnsFailure(); }
  try { checks.SPF = spfHealth(await txt(domain, resolver)); }
  catch { checks.SPF = dnsFailure(); }
  try { checks.DMARC = dmarcHealth(await txt(`_dmarc.${domain}`, resolver)); }
  catch { checks.DMARC = dnsFailure(); }
  if (!selectors.length) checks.DKIM = dkimHealth(null, []);
  for (const selector of selectors.slice(0, 10)) {
    const type = `DKIM:${selector}`;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(selector)) { checks[type] = { status: 'WARNING', summary: 'Configured DKIM selector is invalid.', errorCode: 'DKIM_SELECTOR_INVALID' }; continue; }
    try { checks[type] = dkimHealth(selector, await txt(`${selector}._domainkey.${domain}`, resolver)); }
    catch { checks[type] = dnsFailure(); }
  }
  return checks;
}
