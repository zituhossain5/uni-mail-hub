import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readSync, statSync, lstatSync, unlinkSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { resolve, basename, isAbsolute, join, relative, sep } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');
const archivePrefix = 'uni-mail-hub-';

export function databaseSettings(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL_MISSING');
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error('DATABASE_URL_INVALID');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (name.includes('/')) throw new Error('DATABASE_URL_INVALID');
  const environment = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(environment)) throw new Error('NODE_ENV_INVALID');
  const mode = env.BACKUP_PG_MODE ?? 'native';
  if (!['native', 'docker-compose'].includes(mode)) throw new Error('BACKUP_PG_MODE_INVALID');
  if (mode === 'docker-compose' && !(environment === 'development' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '15432' && name === 'unimailhub' && decodeURIComponent(url.username) === 'unimail')) throw new Error('DOCKER_MODE_REQUIRES_LOCAL_COMPOSE_DB');
  const backupDir = resolve(root, env.BACKUP_DIR ?? '.local-backups');
  if (environment === 'production') {
    const outside = relative(root, backupDir);
    if (!env.BACKUP_DIR || !isAbsolute(env.BACKUP_DIR) || !(outside === '..' || outside.startsWith('..' + sep) || isAbsolute(outside))) throw new Error('PRODUCTION_BACKUP_DIR_MUST_BE_EXTERNAL');
  }
  const retentionDays = Number(env.BACKUP_RETENTION_DAYS ?? 30);
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('BACKUP_RETENTION_DAYS_INVALID');
  return { url, host: url.hostname, port: url.port || '5432', user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), name, environment, mode, backupDir, retentionDays };
}

function ensureBackupDir(settings) {
  mkdirSync(settings.backupDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(settings.backupDir, 0o700);
}

function writeStatus(settings, filename, data) {
  ensureBackupDir(settings);
  const target = join(settings.backupDir, filename);
  const temporary = target + '.' + randomBytes(4).toString('hex') + '.tmp';
  writeFileSync(temporary, JSON.stringify({ checkedAt: new Date().toISOString(), ...data }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, target);
}

function childEnv(settings, extra = {}) {
  return { ...process.env, PGHOST: settings.host, PGPORT: settings.port, PGUSER: settings.user, PGPASSWORD: settings.password, ...(settings.url.searchParams.get('sslmode') ? { PGSSLMODE: settings.url.searchParams.get('sslmode') } : {}), ...extra };
}

export function runTool(settings, tool, args, { inputFile, outputFile, capture = false, extraEnv = {}, timeout = 7_200_000 } = {}) {
  const command = settings.mode === 'docker-compose' ? 'docker' : tool;
  const base = settings.mode === 'docker-compose' ? ['compose', 'exec', '-T', 'postgres', tool, '-U', settings.user] : ['-h', settings.host, '-p', settings.port, '-U', settings.user];
  const fullArgs = [...base, ...args];
  let inputFd;
  let outputFd;
  try {
    if (inputFile) inputFd = openSync(inputFile, 'r');
    if (outputFile) outputFd = openSync(outputFile, 'wx', 0o600);
    const result = spawnSync(command, fullArgs, {
      cwd: root,
      env: childEnv(settings, extraEnv),
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024,
      stdio: [inputFd ?? 'ignore', outputFd ?? (capture ? 'pipe' : 'ignore'), 'ignore'],
    });
    if (result.error?.code === 'ENOENT') throw new Error(`${tool.toUpperCase().replaceAll('-', '_')}_MISSING`);
    if (result.error || result.status !== 0) throw new Error(`${tool.toUpperCase().replaceAll('-', '_')}_FAILED`);
    return capture ? String(result.stdout ?? '').trim() : undefined;
  } finally {
    if (inputFd !== undefined) closeSync(inputFd);
    if (outputFd !== undefined) closeSync(outputFd);
  }
}

function sha256(file) {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function regularFile(file) {
  try { const stat = lstatSync(file); return stat.isFile() && stat.size > 0; } catch { return false; }
}

export function verifyArchive(settings, file, requireSidecars = true, tool = runTool) {
  const archive = resolve(file);
  if (!regularFile(archive)) throw new Error('BACKUP_FILE_INVALID');
  if (requireSidecars) {
    if (!regularFile(archive + '.json') || !regularFile(archive + '.sha256')) throw new Error('BACKUP_METADATA_MISSING');
    let metadata;
    try { metadata = JSON.parse(readFileSync(archive + '.json', 'utf8')); } catch { throw new Error('BACKUP_METADATA_INVALID'); }
    if (metadata.verified !== true || metadata.filename !== basename(archive) || !/^[a-f0-9]{64}$/.test(metadata.checksum)) throw new Error('BACKUP_METADATA_INVALID');
    const sidecar = readFileSync(archive + '.sha256', 'utf8').trim();
    if (sidecar !== `${metadata.checksum}  ${basename(archive)}` || sha256(archive) !== metadata.checksum) throw new Error('BACKUP_CHECKSUM_MISMATCH');
  }
  tool(settings, 'pg_restore', ['--list'], { inputFile: archive });
  return { archive, sizeBytes: statSync(archive).size };
}

export function rotateBackups(settings, protectedArchive, now = new Date(), tool = runTool) {
  ensureBackupDir(settings);
  verifyArchive(settings, protectedArchive, true, tool);
  const candidates = readdirSync(settings.backupDir)
    .filter(name => /^uni-mail-hub-[0-9TZ-]+-[a-f0-9]{8}\.dump\.json$/.test(name))
    .map(name => {
      const archive = join(settings.backupDir, name.slice(0, -5));
      if (!regularFile(archive) || !regularFile(archive + '.json') || !regularFile(archive + '.sha256')) return null;
      try {
        const metadata = JSON.parse(readFileSync(archive + '.json', 'utf8'));
        return metadata.verified === true && metadata.filename === basename(archive) && Number.isFinite(Date.parse(metadata.createdAt)) ? { archive, createdAt: Date.parse(metadata.createdAt) } : null;
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  const cutoff = now.getTime() - settings.retentionDays * 86_400_000;
  let removed = 0;
  for (const item of candidates.slice(2)) {
    if (item.archive === resolve(protectedArchive)) continue;
    if (item.createdAt >= cutoff) continue;
    try { verifyArchive(settings, item.archive, true, tool); } catch { continue; }
    for (const suffix of ['', '.sha256', '.json']) {
      const file = item.archive + suffix;
      if (lstatSync(file).isFile()) unlinkSync(file);
    }
    removed++;
  }
  return removed;
}

export function createBackup(settings = databaseSettings(), { rotate = true, tool = runTool } = {}) {
  ensureBackupDir(settings);
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const archive = join(settings.backupDir, `${archivePrefix}${timestamp}-${randomBytes(4).toString('hex')}.dump`);
  try {
    tool(settings, 'pg_dump', ['-Fc', '--no-owner', '--no-privileges', '-d', settings.name], { outputFile: archive });
    if (!regularFile(archive)) throw new Error('BACKUP_EMPTY');
    if (process.platform !== 'win32') chmodSync(archive, 0o600);
    tool(settings, 'pg_restore', ['--list'], { inputFile: archive });
  } catch (error) {
    if (existsSync(archive)) writeFileSync(archive + '.json', JSON.stringify({ filename: basename(archive), createdAt: new Date().toISOString(), environment: settings.environment, databaseHost: settings.host, databaseName: settings.name, sizeBytes: statSync(archive).size, verified: false, errorCode: error instanceof Error ? error.message : 'UNKNOWN' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeStatus(settings, 'backup-attempt-status.json', { status: 'FAILED', archive: basename(archive) });
    throw error;
  }
  const checksum = sha256(archive);
  const metadata = { filename: basename(archive), createdAt: new Date().toISOString(), environment: settings.environment, databaseHost: settings.host, databaseName: settings.name, sizeBytes: statSync(archive).size, checksum, verified: true, applicationVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version };
  try {
    writeFileSync(archive + '.sha256', `${checksum}  ${basename(archive)}\n`, { flag: 'wx', mode: 0o600 });
    writeFileSync(archive + '.json', JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    verifyArchive(settings, archive, true, tool);
    const removed = rotate ? rotateBackups(settings, archive, new Date(), tool) : 0;
    writeStatus(settings, 'backup-attempt-status.json', { status: 'SUCCESS', archive: basename(archive) });
    return { archive, metadata, rotated: removed };
  } catch (error) {
    writeStatus(settings, 'backup-attempt-status.json', { status: 'FAILED', archive: basename(archive) });
    throw error;
  }
}

export function writeRestoreTestStatus(settings, status, archive) {
  writeStatus(settings, 'restore-test-status.json', { status, archive: basename(archive) });
}

export function writeVerificationStatus(settings, status, archive) {
  writeStatus(settings, 'backup-verification-status.json', { status, archive: basename(archive) });
}

export function backupStatus(settings = databaseSettings(), now = new Date()) {
  ensureBackupDir(settings);
  const entries = readdirSync(settings.backupDir)
    .filter(name => /^uni-mail-hub-[0-9TZ-]+-[a-f0-9]{8}\.dump\.json$/.test(name))
    .map(name => {
      const archive = join(settings.backupDir, name.slice(0, -5));
      try {
        const data = JSON.parse(readFileSync(join(settings.backupDir, name), 'utf8'));
        return data.verified === true && regularFile(archive) && data.filename === basename(archive) && Number.isFinite(Date.parse(data.createdAt)) ? { archive: basename(archive), createdAt: data.createdAt } : null;
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  let restoreTest = null;
  try { restoreTest = JSON.parse(readFileSync(join(settings.backupDir, 'restore-test-status.json'), 'utf8')); } catch { /* no test yet */ }
  let lastAttempt = null;
  try { lastAttempt = JSON.parse(readFileSync(join(settings.backupDir, 'backup-attempt-status.json'), 'utf8')); } catch { /* no attempt yet */ }
  let lastVerification = null;
  try { lastVerification = JSON.parse(readFileSync(join(settings.backupDir, 'backup-verification-status.json'), 'utf8')); } catch { /* no manual verification yet */ }
  const latest = entries[0] ?? null;
  const ageHours = latest ? Math.round((now.getTime() - Date.parse(latest.createdAt)) / 3_600_000 * 10) / 10 : null;
  const failedAttempt = lastAttempt?.status === 'FAILED';
  return { latestVerifiedBackup: latest, ageHours, backupHealth: failedAttempt || lastVerification?.status === 'FAILED' || ageHours === null ? 'CRITICAL' : ageHours > 26 ? 'WARNING' : 'HEALTHY', lastAttempt, lastVerification, restoreTest };
}

export function checkReachable(settings, dbName = settings.name) {
  if (runTool(settings, 'psql', ['-d', dbName, '-At', '-c', 'SELECT 1'], { capture: true }) !== '1') throw new Error('DATABASE_UNREACHABLE');
}

export function activeConnections(settings) {
  const result = runTool(settings, 'psql', ['-d', settings.name, '-At', '-c', 'SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()'], { capture: true });
  const count = Number(result);
  if (!Number.isInteger(count)) throw new Error('DATABASE_CONNECTION_CHECK_FAILED');
  return count;
}

export function validateRestoreConfirmation(settings, options) {
  if (!options.backup || options.environment !== settings.environment || options.database !== settings.name || options.confirm !== 'RESTORE UNI MAIL HUB' || options.workersStopped !== true) throw new Error('RESTORE_CONFIRMATION_REQUIRED');
}

export function assertRestoreTestTarget(settings) {
  if (settings.environment === 'production') throw new Error('RESTORE_TEST_REQUIRES_NON_PRODUCTION');
}

export function restoreArchive(settings, archive, targetDb, clean = false) {
  const args = ['--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', ...(clean ? ['--clean', '--if-exists'] : []), '-d', targetDb];
  runTool(settings, 'pg_restore', args, { inputFile: archive });
}

export function temporaryDatabaseUrl(settings, name) {
  const url = new URL(settings.url);
  url.pathname = '/' + name;
  return url.toString();
}

export function createTemporaryDatabase(settings, name) {
  if (!/^umh_restore_[a-f0-9]{12}$/.test(name) || name === settings.name) throw new Error('TEMP_DATABASE_NAME_INVALID');
  runTool(settings, 'createdb', ['-T', 'template0', name]);
}

export function dropTemporaryDatabase(settings, name) {
  if (!/^umh_restore_[a-f0-9]{12}$/.test(name) || name === settings.name) throw new Error('TEMP_DATABASE_NAME_INVALID');
  runTool(settings, 'dropdb', ['--if-exists', name]);
}

export function integrityCounts(settings, name) {
  const sql = 'SELECT (SELECT count(*) FROM "User" WHERE role = \'SUPER_ADMIN\' AND "isActive"), (SELECT count(*) FROM "Project"), (SELECT count(*) FROM "Mailbox"), (SELECT count(*) FROM "MailboxCredential" WHERE "encryptedPassword" = \'\' OR "encryptionIv" = \'\' OR "encryptionAuthTag" = \'\'), (SELECT count(*) FROM "CpanelAccount" WHERE "encryptedApiToken" = \'\' OR "encryptionIv" = \'\' OR "encryptionAuthTag" = \'\'), (SELECT count(*) FROM "WebhookEndpoint" WHERE "encryptedSecret" = \'\' OR "encryptionIv" = \'\' OR "encryptionAuthTag" = \'\'), (SELECT count(*) FROM pg_constraint WHERE contype = \'f\' AND NOT convalidated)';
  const result = runTool(settings, 'psql', ['-d', name, '-At', '-F', ',', '-c', sql], { capture: true });
  const counts = result.split(',').map(Number);
  if (counts.length !== 7 || counts.some(value => !Number.isInteger(value)) || counts[0] < 1 || counts.slice(3).some(value => value > 0)) throw new Error('RESTORE_INTEGRITY_FAILED');
  return { superAdmins: counts[0], projects: counts[1], mailboxes: counts[2], malformedEncryptedRecords: counts.slice(3).reduce((a, b) => a + b, 0) };
}

export function prismaMigrationStatus(databaseUrl) {
  const cli = join(root, 'node_modules', 'prisma', 'build', 'index.js');
  if (!existsSync(cli)) throw new Error('PRISMA_CLI_MISSING');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'status', '--schema', join(root, 'packages', 'database', 'prisma', 'schema.prisma')], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, windowsHide: true, stdio: 'ignore', timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error('RESTORED_MIGRATIONS_NOT_CURRENT');
}
