import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { PrismaClient, UserRole } from '../packages/database/generated/client';
import { readConfig } from '../packages/config/src/index';
import { decodeEncryptionKey, decryptSecret } from '../packages/security/src/index';

const fail = (message: string) => { console.error('FAIL ' + message); process.exitCode = 1; };
const ok = (message: string) => console.log('OK ' + message);

async function main() {
  const config = readConfig();
  ok('Environment profile and secret formats validated (' + config.NODE_ENV + ')');
  const git = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  if (git.status !== 0) fail('Tracked-file check unavailable');
  else {
    const tracked = git.stdout.split('\0').filter(Boolean);
    const unsafe = tracked.filter(path => (/(^|\/)\.env(\.|$)/.test(path) && !['.env.example', '.env.production.example'].includes(path) || /\.(pem|key|p12|pfx|dump|backup|bak|sql\.gz)$/i.test(path)));
    if (unsafe.length) fail('Sensitive file types are tracked: ' + unsafe.join(', '));
    else ok('No tracked env, private-key, or database-dump files');
    const exposed = tracked.filter(path => existsSync(path) && statSync(path).size < 1024 * 1024 && /\.(?:txt|md|ts|tsx|js|mjs|py|json|yaml|yml|env)$/i.test(path) && /umh_(?:live|test)_[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(readFileSync(path, 'utf8')));
    if (exposed.length) fail('Potential raw credentials in tracked files: ' + exposed.join(', '));
    else ok('No high-confidence raw credentials in present tracked text files');
  }
  const db = new PrismaClient();
  try {
    await db.$connect();
    ok('Database connection');
    const key = decodeEncryptionKey(config.MAIL_CREDENTIAL_ENCRYPTION_KEY);
    let checked = 0;
    const verify = (value: { encryptedPassword: string; encryptionIv: string; encryptionAuthTag: string; encryptionVersion: number }) => { decryptSecret(value, key); checked++; };
    for (const value of await db.mailboxCredential.findMany({ select: { encryptedPassword: true, encryptionIv: true, encryptionAuthTag: true, encryptionVersion: true } })) verify(value);
    for (const value of await db.cpanelAccount.findMany({ select: { encryptedApiToken: true, encryptionIv: true, encryptionAuthTag: true, encryptionVersion: true } })) verify({ encryptedPassword: value.encryptedApiToken, ...value });
    for (const value of await db.webhookEndpoint.findMany({ select: { encryptedSecret: true, encryptionIv: true, encryptionAuthTag: true, encryptionVersion: true } })) verify({ encryptedPassword: value.encryptedSecret, ...value });
    ok('Stored secrets decrypted without displaying plaintext: ' + checked);
    if (config.NODE_ENV === 'production') {
      const admins = await db.user.count({ where: { role: UserRole.SUPER_ADMIN, isActive: true } });
      if (!admins) fail('No active SUPER_ADMIN account exists');
      else ok('Active SUPER_ADMIN account exists');
    }
  } catch {
    fail('Database or encrypted-secret verification failed; check key and migration status securely');
  } finally { await db.$disconnect(); }
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'status', '--schema', 'packages/database/prisma/schema.prisma'], { encoding: 'utf8', env: process.env });
  if (migration.status === 0 && migration.stdout.includes('Database schema is up to date')) ok('Prisma migration status clean');
  else fail('Prisma migration status is not clean or could not be checked');
}

main().catch(() => fail('Security check could not complete'));
