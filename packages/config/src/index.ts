import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  WEB_URL: z.string().url(),
  API_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  MAIL_CREDENTIAL_ENCRYPTION_KEY: z.string().refine((value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32, 'Must be a Base64-encoded 32-byte key'),
  MAIL_API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10000).default(60),
  MAIL_API_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  MAIL_SEND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  MAIL_SEND_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(3600000).default(60000),
  MAIL_SEND_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
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
  WEBHOOK_RESPONSE_MAX_BYTES: z.coerce.number().int().min(256).max(65536).default(4096),
});

export function readConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  if (result.data.NODE_ENV === 'production' && result.data.JWT_SECRET.includes('replace-with')) {
    throw new Error('JWT_SECRET must be replaced in production.');
  }
  return result.data;
}
