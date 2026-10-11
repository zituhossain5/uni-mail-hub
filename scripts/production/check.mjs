import { createHash } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { readConfig } = require('@uni/config');
const { PrismaClient, UserRole } = require('@uni/database');
const { decodeEncryptionKey, decryptSecret } = require('@uni/security');
const Redis = require('ioredis');
const root = resolve(import.meta.dirname, '../..');
const phase = process.argv.includes('--pre-migrate') ? 'pre-migrate' : 'ready';
const configOnly = process.argv.includes('--config-only');
const requireEnrolled = process.argv.includes('--require-enrolled');
const fail = code => { throw new Error(code); };
const pass = value => console.log('OK ' + value);

async function migrationLedger(db) {
  const rows = await db.$queryRaw`SELECT to_regclass('public._prisma_migrations')::text AS name`;
  if (!rows[0]?.name) {
    if (phase === 'pre-migrate') return pass('Fresh migration ledger');
    fail('MIGRATION_LEDGER_MISSING');
  }
  const applied = await db.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations`;
  const files = await readdir(resolve(root, 'packages/database/prisma/migrations'), { withFileTypes: true });
  const names = new Set(files.filter(item => item.isDirectory()).map(item => item.name));
  const complete = new Set();
  for (const row of applied) {
    if (row.rolled_back_at) continue;
    if (!row.finished_at) fail('FAILED_MIGRATION');
    if (!names.has(row.migration_name)) fail('APPLIED_MIGRATION_MISSING_LOCALLY');
    const sql = await readFile(resolve(root, 'packages/database/prisma/migrations', row.migration_name, 'migration.sql'));
    if (createHash('sha256').update(sql).digest('hex') !== row.checksum) fail('MIGRATION_CHECKSUM_MISMATCH');
    complete.add(row.migration_name);
  }
  if (phase === 'ready' && [...names].some(name => !complete.has(name))) fail('PENDING_MIGRATIONS');
  pass(`Migration ledger valid (${complete.size} applied)`);
}

async function main() {
  const config = readConfig();
  if (config.NODE_ENV !== 'production') fail('NODE_ENV_NOT_PRODUCTION');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/.test(process.env.APP_VERSION ?? '') || /replace|latest|test|dev/i.test(process.env.APP_VERSION ?? '')) fail('APP_VERSION_INVALID');
  if (config.API_URL !== 'http://api:4000' && config.API_URL !== 'http://api:4000/') fail('COMPOSE_API_URL_INVALID');
  if (process.env.BACKUP_DIR !== '/backups' || process.env.BACKUP_PG_MODE !== 'native') fail('BACKUP_CONFIGURATION_INVALID');
  await access('/backups', constants.R_OK | constants.W_OK);
  for (const file of ['/etc/nginx/tls/fullchain.pem', '/etc/nginx/tls/privkey.pem']) {
    if (!(await stat(file)).isFile()) fail('TLS_CERTIFICATE_MISSING');
  }
  const dbUrl = new URL(config.DATABASE_URL);
  if (dbUrl.hostname !== 'postgres' || dbUrl.port && dbUrl.port !== '5432' || decodeURIComponent(dbUrl.username) !== process.env.POSTGRES_USER || decodeURIComponent(dbUrl.password) !== process.env.POSTGRES_PASSWORD || decodeURIComponent(dbUrl.pathname.slice(1)) !== process.env.POSTGRES_DB) fail('DATABASE_SETTINGS_MISMATCH');
  const redisUrl = new URL(config.REDIS_URL);
  if (redisUrl.hostname !== 'redis' || redisUrl.port && redisUrl.port !== '6379') fail('REDIS_HOST_INVALID');
  pass('Production configuration and secret formats');
  pass('Private database, Redis, and backup configuration');
  pass('TLS certificate files mounted');
  if (configOnly) return;

  const db = new PrismaClient();
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5000 });
  try {
    await db.$connect();
    await redis.connect();
    if (await redis.ping() !== 'PONG') fail('REDIS_PING_FAILED');
    pass('PostgreSQL and Redis reachable');
    await migrationLedger(db);
    if (phase === 'ready') {
      const [admins, unprotected, users] = await Promise.all([
        db.user.count({ where: { role: UserRole.SUPER_ADMIN, isActive: true } }),
        db.user.count({ where: { role: UserRole.SUPER_ADMIN, isActive: true, OR: [{ security: null }, { security: { totpEnabledAt: null } }] } }),
        db.user.count(),
      ]);
      if (!admins || unprotected && !(config.PRODUCTION_2FA_BOOTSTRAP && admins === 1 && unprotected === 1 && users === 1)) fail('ADMIN_2FA_REQUIRED');
      if (requireEnrolled && (unprotected || config.PRODUCTION_2FA_BOOTSTRAP)) fail('ADMIN_2FA_ENROLLMENT_INCOMPLETE');
      pass(unprotected ? 'Restricted first-install 2FA enrollment ready' : 'Administrator 2FA enforced');
      const encryptionKey = decodeEncryptionKey(config.MAIL_CREDENTIAL_ENCRYPTION_KEY);
      let verified = 0;
      const verify = value => { decryptSecret(value, encryptionKey); verified++; };
      for (const row of await db.mailboxCredential.findMany({ select: { encryptedPassword: true, encryptionIv: true, encryptionAuthTag: true, encryptionVersion: true } })) verify(row);
      for (const row of await db.cpanelAccount.findMany({ select: { encryptedApiToken: true, encryptionIv: true, encryptionAuthTag: true, encryptionVersion: true } })) verify({ encryptedPassword: row.encryptedApiToken, encryptionIv: row.encryptionIv, encryptionAuthTag: row.encryptionAuthTag, encryptionVersion: row.encryptionVersion });
      for (const row of await db.webhookEndpoint.findMany({ select: { encryptedSecret: true, encryptionIv: true, encryptionAuthTag: true, encryptionVersion: true } })) verify({ encryptedPassword: row.encryptedSecret, encryptionIv: row.encryptionIv, encryptionAuthTag: row.encryptionAuthTag, encryptionVersion: row.encryptionVersion });
      for (const row of await db.userSecurity.findMany({ where: { totpEnabledAt: { not: null } }, select: { totpSecretCiphertext: true, totpSecretIv: true, totpSecretTag: true } })) {
        if (!row.totpSecretCiphertext || !row.totpSecretIv || !row.totpSecretTag) fail('INCOMPLETE_2FA_SECRET');
        verify({ encryptedPassword: row.totpSecretCiphertext, encryptionIv: row.totpSecretIv, encryptionAuthTag: row.totpSecretTag, encryptionVersion: 1 });
      }
      pass(`Encrypted records decryptable (${verified} checked)`);
      const status = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'status', '--schema', 'packages/database/prisma/schema.prisma'], { cwd: root, env: process.env, stdio: 'ignore' });
      if (status.status !== 0) fail('PRISMA_MIGRATION_STATUS_FAILED');
      pass('Prisma migration status clean');
    }
  } finally {
    redis.disconnect();
    await db.$disconnect();
  }
}

main().catch(error => { console.error('FAIL ' + (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PRODUCTION_CHECK_FAILED')); process.exitCode = 1; });
