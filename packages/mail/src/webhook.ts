import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

export const webhookEventTypes = ['webhook.test', 'mail.received', 'mail.smtp_accepted', 'mail.failed', 'mail.bounced', 'mailbox.sync_failed', 'monitoring.issue_opened', 'monitoring.issue_resolved'] as const;
export type WebhookEventType = typeof webhookEventTypes[number];

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['2001::', 32], ['2002::', 16], ['64:ff9b::', 96],
] as const) blocked.addSubnet(address, prefix, 'ipv6');

export function publicWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (!family || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')) return false;
  if (family === 6 && !/^[23]/i.test(address)) return false; // Only global unicast IPv6.
  return true;
}

export function webhookUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('WEBHOOK_ENDPOINT_INVALID'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.hash ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) ||
    /\.(?:localhost|local|internal|invalid|test|example)$/.test(hostname) || isIP(hostname)) throw new Error('WEBHOOK_ENDPOINT_INVALID');
  url.hostname = hostname;
  return url;
}

export async function resolveWebhookTarget(value: string, resolver: typeof lookup = lookup) {
  const url = webhookUrl(value);
  let answers: Array<{ address: string; family: number }>;
  let timer: NodeJS.Timeout | undefined;
  try { answers = await Promise.race([resolver(url.hostname, { all: true, verbatim: true }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('WEBHOOK_ENDPOINT_INVALID')), 5000); })]); }
  catch { throw new Error('WEBHOOK_ENDPOINT_INVALID'); }
  finally { if (timer) clearTimeout(timer); }
  if (!Array.isArray(answers) || !answers.length || answers.some(answer => !publicWebhookAddress(answer.address))) throw new Error('WEBHOOK_ENDPOINT_INVALID');
  return { url, address: answers[0]!.address, family: isIP(answers[0]!.address) as 4 | 6 };
}

export function pinnedWebhookLookupAnswer(resolved: { address: string; family: 4 | 6 }, all: boolean) {
  return all ? [resolved] : resolved.address;
}

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`;
}

export function verifyWebhookSignature(secret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type WebhookResponse = { status: number; durationMs: number; retryAfterSeconds: number | null };
export async function postWebhook(urlValue: string, eventType: string, eventId: string, rawBody: string, secret: string, timeoutMs: number, maxResponseBytes: number): Promise<WebhookResponse> {
  const target = await resolveWebhookTarget(urlValue);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { clearTimeout(deadline); reject(error); };
    const req = request(target.url, {
      method: 'POST',
      agent: false,
      servername: target.url.hostname,
      rejectUnauthorized: true,
      lookup: (_host, options, callback) => callback(null, pinnedWebhookLookupAnswer(target, Boolean(options.all)), options.all ? undefined : target.family),
      headers: {
        Host: target.url.host,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody, 'utf8'),
        'X-UniMail-Event': eventType,
        'X-UniMail-Event-Id': eventId,
        'X-UniMail-Timestamp': timestamp,
        'X-UniMail-Signature': signWebhook(secret, timestamp, rawBody),
      },
    }, response => {
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxResponseBytes) req.destroy(new Error('WEBHOOK_RESPONSE_TOO_LARGE'));
      });
      response.on('end', () => {
        const retry = response.headers['retry-after'];
        let retryAfterSeconds: number | null = null;
        if (typeof retry === 'string') {
          const seconds = Number(retry);
          if (Number.isFinite(seconds) && seconds >= 0) retryAfterSeconds = Math.min(3600, Math.ceil(seconds));
          else { const date = Date.parse(retry); if (Number.isFinite(date)) retryAfterSeconds = Math.min(3600, Math.max(0, Math.ceil((date - Date.now()) / 1000))); }
        }
        clearTimeout(deadline);
        resolve({ status: response.statusCode ?? 0, durationMs: Date.now() - started, retryAfterSeconds });
      });
      response.on('error', fail);
      response.on('aborted', () => fail(new Error('WEBHOOK_DELIVERY_FAILED')));
    });
    const deadline = setTimeout(() => req.destroy(new Error('WEBHOOK_DELIVERY_TIMEOUT')), timeoutMs);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('WEBHOOK_DELIVERY_TIMEOUT')));
    req.on('error', fail);
    req.end(rawBody);
  });
}
