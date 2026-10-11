import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { root, databaseSettings, runTool, createBackup, verifyArchive, rotateBackups, backupStatus, writeVerificationStatus, validateRestoreConfirmation, assertRestoreTestTarget, createTemporaryDatabase } from './db-tools.mjs';

const fixtureRoot = join(root, '.local-backups');
mkdirSync(fixtureRoot, { recursive: true });
const config = dir => databaseSettings({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:15432/unimailhub', BACKUP_PG_MODE: 'native', BACKUP_DIR: dir, BACKUP_RETENTION_DAYS: '30' });
const fakeTool = (_settings, tool, _args, options) => {
  if (tool === 'pg_dump') writeFileSync(options.outputFile, Buffer.from('PGDMP synthetic fixture only'));
  if (tool !== 'pg_dump' && tool !== 'pg_restore') throw new Error('UNEXPECTED_TOOL');
};
function fixture(t) {
  const dir = mkdtempSync(join(fixtureRoot, 'ops-test-'));
  t.after(() => {
    if (!resolve(dir).startsWith(resolve(fixtureRoot) + sep)) throw new Error('Unsafe test cleanup path');
    rmSync(dir, { recursive: true, force: true });
  });
  return config(dir);
}

test('production backup path must be absolute and outside the repository', () => {
  assert.throws(() => databaseSettings({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.internal/app', BACKUP_DIR: '.local-backups' }), /PRODUCTION_BACKUP_DIR_MUST_BE_EXTERNAL/);
  assert.throws(() => databaseSettings({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://u:p@remote.example/app', BACKUP_PG_MODE: 'docker-compose' }), /DOCKER_MODE_REQUIRES_LOCAL_COMPOSE_DB/);
});

test('missing PostgreSQL tool fails without a database call', t => {
  const settings = fixture(t);
  assert.throws(() => runTool(settings, 'pg_dump', ['--version'], { extraEnv: { PATH: '' } }), /PG_DUMP_MISSING/);
});

test('backup records a verified archive and detects changed bytes', t => {
  const settings = fixture(t);
  const { archive, metadata } = createBackup(settings, { rotate: false, tool: fakeTool });
  assert.equal(metadata.verified, true);
  assert.equal(metadata.sizeBytes > 0, true);
  assert.equal(verifyArchive(settings, archive, true, fakeTool).sizeBytes, metadata.sizeBytes);
  writeFileSync(archive, Buffer.from('PGDMP changed'));
  assert.throws(() => verifyArchive(settings, archive, true, fakeTool), /BACKUP_CHECKSUM_MISMATCH/);
});

test('failed archive verification stays marked unverified', t => {
  const settings = fixture(t);
  assert.throws(() => createBackup(settings, { tool: (s, tool, args, options) => { fakeTool(s, tool, args, options); if (tool === 'pg_restore') throw new Error('PG_RESTORE_FAILED'); } }), /PG_RESTORE_FAILED/);
  const sidecar = readdirSync(settings.backupDir).find(name => name.endsWith('.dump.json'));
  assert.ok(sidecar);
  assert.equal(JSON.parse(readFileSync(join(settings.backupDir, sidecar), 'utf8')).verified, false);
  assert.equal(backupStatus(settings).backupHealth, 'CRITICAL');
});

test('rotation preserves newest valid backups and leaves unverified archives', t => {
  const settings = fixture(t);
  const archives = Array.from({ length: 4 }, () => createBackup(settings, { rotate: false, tool: fakeTool }).archive);
  archives.forEach((archive, index) => {
    const file = archive + '.json';
    const metadata = JSON.parse(readFileSync(file, 'utf8'));
    metadata.createdAt = new Date(Date.now() - (60 - index * 10) * 86_400_000).toISOString();
    writeFileSync(file, JSON.stringify(metadata));
  });
  const newest = archives[3];
  const invalid = join(settings.backupDir, 'uni-mail-hub-20260101T000000Z-deadbeef.dump');
  writeFileSync(invalid, Buffer.from('PGDMP invalid fixture'));
  writeFileSync(invalid + '.json', JSON.stringify({ filename: 'uni-mail-hub-20260101T000000Z-deadbeef.dump', createdAt: '2026-01-01T00:00:00Z', verified: false }));
  assert.equal(rotateBackups(settings, newest, new Date(), fakeTool), 2);
  assert.equal(existsSync(newest), true);
  assert.equal(existsSync(archives[2]), true);
  assert.equal(existsSync(archives[0]), false);
  assert.equal(existsSync(invalid), true);
});

test('backup status identifies a newer failed attempt', t => {
  const settings = fixture(t);
  const { archive } = createBackup(settings, { rotate: false, tool: fakeTool });
  assert.equal(backupStatus(settings, new Date()).backupHealth, 'HEALTHY');
  assert.throws(() => createBackup(settings, { tool: () => { throw new Error('PG_DUMP_FAILED'); } }), /PG_DUMP_FAILED/);
  assert.equal(backupStatus(settings, new Date()).backupHealth, 'CRITICAL');
  assert.equal(existsSync(archive), true);
});

test('failed manual verification makes health critical until a successful recheck', t => {
  const settings = fixture(t);
  const { archive } = createBackup(settings, { rotate: false, tool: fakeTool });
  writeVerificationStatus(settings, 'FAILED', archive);
  assert.equal(backupStatus(settings).backupHealth, 'CRITICAL');
  writeVerificationStatus(settings, 'SUCCESS', archive);
  assert.equal(backupStatus(settings).backupHealth, 'HEALTHY');
});

test('restore verification rejects archives without metadata', t => {
  const settings = fixture(t);
  const archive = join(settings.backupDir, 'unverified.dump');
  writeFileSync(archive, Buffer.from('PGDMP fixture'));
  assert.throws(() => verifyArchive(settings, archive, true, fakeTool), /BACKUP_METADATA_MISSING/);
});

test('restore requires exact target and phrase; restore test rejects production and active DB names', t => {
  const settings = fixture(t);
  assert.throws(() => validateRestoreConfirmation(settings, { backup: 'x', environment: 'production', database: settings.name, confirm: 'RESTORE UNI MAIL HUB', workersStopped: true }), /RESTORE_CONFIRMATION_REQUIRED/);
  assert.throws(() => validateRestoreConfirmation(settings, { backup: 'x', environment: 'development', database: settings.name, confirm: 'yes', workersStopped: true }), /RESTORE_CONFIRMATION_REQUIRED/);
  assert.doesNotThrow(() => validateRestoreConfirmation(settings, { backup: 'x', environment: 'development', database: settings.name, confirm: 'RESTORE UNI MAIL HUB', workersStopped: true }));
  assert.throws(() => assertRestoreTestTarget({ ...settings, environment: 'production' }), /RESTORE_TEST_REQUIRES_NON_PRODUCTION/);
  assert.throws(() => createTemporaryDatabase(settings, settings.name), /TEMP_DATABASE_NAME_INVALID/);
});
