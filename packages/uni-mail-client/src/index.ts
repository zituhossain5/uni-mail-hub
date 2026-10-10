import { randomUUID } from 'node:crypto';

export type MailAddress = string | { email: string; name?: string };
export type SendMessage = {
  to: MailAddress | MailAddress[];
  cc?: MailAddress | MailAddress[];
  bcc?: MailAddress | MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  text?: string;
  html?: string;
};
export type SendResult = { id: string; status: string; createdAt: string; idempotencyKey: string };
export type MessageResult = {
  id: string; status: string; subject: string; createdAt: string;
  queuedAt: string | null; processingAt: string | null; smtpAcceptedAt: string | null; failedAt: string | null;
  lastErrorCode: string | null;
  fromMailbox: { id: string; email: string };
  recipients: Array<{ type: 'TO' | 'CC'; email: string; name: string | null; smtpStatus: string }>;
};
export class UniMailError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
    readonly idempotencyKey: string | null = null,
  ) { super(message); this.name = 'UniMailError'; }
}
export type UniMailOptions = { baseUrl: string; apiKey: string; mailboxId: string; fetch?: typeof fetch };

const safeMessages: Record<string, string> = {
  API_KEY_INVALID: 'The Uni Mail Hub API key is invalid.',
  API_KEY_REVOKED: 'The Uni Mail Hub API key has been revoked.',
  SENDER_NOT_AUTHORIZED: 'This API key cannot send from the selected mailbox.',
  RECIPIENT_SUPPRESSED: 'One or more recipients are suppressed.',
  RATE_LIMIT_EXCEEDED: 'Uni Mail Hub rate limit exceeded.',
  IDEMPOTENCY_CONFLICT: 'This idempotency key was used for a different message.',
  VALIDATION_ERROR: 'The message request is invalid.',
  MESSAGE_NOT_FOUND: 'Message not found.',
};
function address(value: MailAddress) { return typeof value === 'string' ? { email: value } : { email: value.email, ...(value.name ? { name: value.name } : {}) }; }
function addresses(value: MailAddress | MailAddress[] | undefined) { return value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(address); }
function decodeError(status: number, payload: unknown, idempotencyKey: string | null): UniMailError {
  const item = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const code = typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(item.code) ? item.code : 'API_ERROR';
  const details = code === 'VALIDATION_ERROR' && item.details && typeof item.details === 'object' ? item.details : null;
  return new UniMailError(status, code, safeMessages[code] ?? 'Uni Mail Hub request failed.', details, idempotencyKey);
}

export class UniMail {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly mailboxId: string;
  private readonly request: typeof fetch;
  constructor(options: UniMailOptions) {
    let parsed: URL;
    try { parsed = new URL(options.baseUrl); } catch { throw new TypeError('baseUrl must be a valid HTTP URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new TypeError('baseUrl must be an HTTP origin without credentials, path, or query');
    if (!options.apiKey || !options.mailboxId) throw new TypeError('apiKey and mailboxId are required');
    this.baseUrl = parsed.origin;
    this.apiKey = options.apiKey;
    this.mailboxId = options.mailboxId;
    this.request = options.fetch ?? fetch;
  }
  async send(message: SendMessage, options: { idempotencyKey?: string } = {}): Promise<SendResult> {
    const key = options.idempotencyKey ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new TypeError('idempotencyKey must contain 1–128 safe characters');
    const body = {
      fromMailboxId: this.mailboxId,
      to: addresses(message.to), cc: addresses(message.cc), bcc: addresses(message.bcc),
      ...(message.replyTo ? { replyTo: address(message.replyTo) } : {}),
      subject: message.subject,
      ...(message.text !== undefined ? { text: message.text } : {}),
      ...(message.html !== undefined ? { html: message.html } : {}),
    };
    const result = await this.call<{ id: string; status: string; createdAt: string }>('messages', {
      method: 'POST', headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, key);
    return { ...result, idempotencyKey: key };
  }
  async getMessage(id: string): Promise<MessageResult> {
    if (!/^[a-z0-9]{20,40}$/.test(id)) throw new TypeError('Invalid message id');
    return this.call<MessageResult>(`messages/${id}`, { method: 'GET' }, null);
  }
  private async call<T>(path: string, init: RequestInit, idempotencyKey: string | null): Promise<T> {
    let response: Response;
    try {
      response = await this.request(`${this.baseUrl}/api/v1/${path}`, {
        ...init, headers: { Authorization: `Bearer ${this.apiKey}`, ...init.headers }, redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new UniMailError(null, 'NETWORK_ERROR', 'Could not reach Uni Mail Hub. Retry with the same idempotency key.', null, idempotencyKey);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new UniMailError(response.status, 'INVALID_RESPONSE', 'Uni Mail Hub returned an invalid response.', null, idempotencyKey); }
    if (!response.ok) throw decodeError(response.status, payload, idempotencyKey);
    return payload as T;
  }
}
