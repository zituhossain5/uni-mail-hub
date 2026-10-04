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
