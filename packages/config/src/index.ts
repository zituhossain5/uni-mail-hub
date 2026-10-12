import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url().refine(value => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), 'Must use PostgreSQL'),
  REDIS_URL: z.string().url().refine(value => ['redis:', 'rediss:'].includes(new URL(value).protocol), 'Must use Redis'),
  JWT_SECRET: z.string().min(32),
  WEB_URL: z.string().url(),
  API_URL: z.string().url(),
  UNI_MAIL_HUB_PUBLIC_URL: z.string().url().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_BIND_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  PRODUCTION_2FA_BOOTSTRAP: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  MAIL_CREDENTIAL_ENCRYPTION_KEY: z.string().refine((value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value, 'Must be a Base64-encoded 32-byte key'),
  MAIL_API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10000).default(60),
  MAIL_API_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  MAIL_SEND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  MAIL_SEND_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(3600000).default(60000),
  MAIL_SEND_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  MAIL_PROCESSING_STALE_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
  MAIL_MAX_RECIPIENTS: z.coerce.number().int().min(1).max(500).default(50),
  MAIL_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(10485760).default(1048576),
  MAIL_SYNC_INITIAL_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  MAIL_SYNC_INITIAL_MAX_MESSAGES: z.coerce.number().int().min(1).max(10000).default(1000),
  MAIL_SYNC_MAX_MESSAGE_BYTES: z.coerce.number().int().min(1024).max(104857600).default(26214400),
  MAIL_SYNC_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  MAIL_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  MAIL_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(250),
  MAIL_SYNC_FLAG_REFRESH_LIMIT: z.coerce.number().int().min(0).max(5000).default(500),
  MAIL_ATTACHMENT_MAX_BYTES: z.coerce.number().int().min(1024).max(104857600).default(10485760),
  MONITORING_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  MONITORING_RUN_STALE_SECONDS: z.coerce.number().int().min(60).max(3600).default(180),
  MONITORING_QUEUED_STALE_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
  MONITOR_SYNC_WARNING_MINUTES: z.coerce.number().int().min(1).default(15),
  MONITOR_SYNC_CRITICAL_MINUTES: z.coerce.number().int().min(1).default(60),
  MONITOR_QUOTA_WARNING_PERCENT: z.coerce.number().int().min(1).max(99).default(80),
  MONITOR_QUOTA_CRITICAL_PERCENT: z.coerce.number().int().min(1).max(100).default(95),
  MONITOR_QUOTA_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(8760).default(24),
  MONITOR_WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().min(10).max(3600).default(90),
  MONITOR_QUEUE_BACKLOG_WARNING: z.coerce.number().int().min(1).max(100000).default(100),
  MONITOR_TLS_WARNING_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  WEBHOOK_DELIVERING_STALE_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
  WEBHOOK_RESPONSE_MAX_BYTES: z.coerce.number().int().min(256).max(65536).default(4096),
  RETENTION_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(500),
  RETENTION_MAX_ROWS_PER_RUN: z.coerce.number().int().min(1).max(100000).default(10000),
  RETENTION_MONITORING_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(30).default(365),
  RETENTION_WEBHOOK_DELIVERY_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_WEBHOOK_EVENT_DAYS: z.coerce.number().int().min(1).default(180),
  RETENTION_SYNC_RUN_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_CONNECTION_CHECK_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_SMTP_ATTEMPT_DAYS: z.coerce.number().int().min(1).default(180),
  RETENTION_OUTGOING_MESSAGE_DAYS: z.coerce.number().int().min(1).default(365),
});

export function readConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  if (result.data.NODE_ENV === 'production') {
    const issues: string[] = [];
    const { JWT_SECRET, WEB_URL, API_URL, UNI_MAIL_HUB_PUBLIC_URL, ALLOWED_ORIGINS } = result.data;
    if (!process.env.NODE_ENV) issues.push('NODE_ENV');
    if (JWT_SECRET.length < 48 || /replace|change|example|secret|password|test|dev/i.test(JWT_SECRET) || new Set(JWT_SECRET).size < 16 || JWT_SECRET === process.env.SEED_ADMIN_PASSWORD) issues.push('JWT_SECRET');
    const safeBase = (value: string) => { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'; };
    const loopback = (value: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
    if (new URL(WEB_URL).protocol !== 'https:' || loopback(WEB_URL) || !safeBase(WEB_URL)) issues.push('WEB_URL');
    if (!UNI_MAIL_HUB_PUBLIC_URL || new URL(UNI_MAIL_HUB_PUBLIC_URL).protocol !== 'https:' || loopback(UNI_MAIL_HUB_PUBLIC_URL) || !safeBase(UNI_MAIL_HUB_PUBLIC_URL)) issues.push('UNI_MAIL_HUB_PUBLIC_URL');
    const internalApi = loopback(API_URL);
    const composeApi = ['http://uni-mail-hub-api:4000', 'http://uni-mail-hub-api:4000/'].includes(API_URL)
      || (process.env.EXTERNAL_TLS_TERMINATION !== 'true' && ['http://api:4000', 'http://api:4000/'].includes(API_URL));
    if (new URL(API_URL).protocol !== 'https:' && !((internalApi || composeApi) && new URL(API_URL).protocol === 'http:') || !safeBase(API_URL)) issues.push('API_URL');
    if (!ALLOWED_ORIGINS || !ALLOWED_ORIGINS.split(',').every(origin => { try { return new URL(origin.trim()).origin === origin.trim() && new URL(origin.trim()).protocol === 'https:'; } catch { return false; } })) issues.push('ALLOWED_ORIGINS');
    if (ALLOWED_ORIGINS && !ALLOWED_ORIGINS.split(',').map(value => value.trim()).includes(new URL(WEB_URL).origin)) issues.push('ALLOWED_ORIGINS');
    if (issues.length) throw new Error('Invalid production environment configuration: ' + [...new Set(issues)].join(', '));
  }
  return result.data;
}
