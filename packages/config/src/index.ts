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
