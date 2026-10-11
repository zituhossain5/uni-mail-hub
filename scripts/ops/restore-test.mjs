import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { databaseSettings, verifyArchive, checkReachable, createTemporaryDatabase, restoreArchive, integrityCounts, prismaMigrationStatus, temporaryDatabaseUrl, dropTemporaryDatabase, assertRestoreTestTarget, writeRestoreTestStatus } from './db-tools.mjs';

const args = process.argv.slice(2).filter(arg => arg !== '--');
const index = args.indexOf('--backup');
let created = false;
let settings;
let temporary;
let archive;
let successful = false;
try {
  settings = databaseSettings();
  assertRestoreTestTarget(settings);
  if (index < 0 || !args[index + 1]) throw new Error('BACKUP_PATH_REQUIRED');
  archive = resolve(args[index + 1]);
  verifyArchive(settings, archive);
  checkReachable(settings);
  temporary = `umh_restore_${randomBytes(6).toString('hex')}`;
  createTemporaryDatabase(settings, temporary);
  created = true;
  console.log(JSON.stringify({ temporaryDatabase: temporary, activeDatabase: settings.name }));
  restoreArchive(settings, archive, temporary);
  const counts = integrityCounts(settings, temporary);
  prismaMigrationStatus(temporaryDatabaseUrl(settings, temporary));
  successful = true;
  console.log(JSON.stringify({ restoredToTemporaryDatabase: true, migrationsCurrent: true, counts }));
} catch (error) {
  console.error(`Restore test failed: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
  process.exitCode = 1;
} finally {
  if (created && settings && temporary) {
    try { dropTemporaryDatabase(settings, temporary); console.log(JSON.stringify({ temporaryDatabaseRemoved: true })); }
    catch { console.error(`Temporary database cleanup failed: DROPDB_FAILED (${temporary})`); process.exitCode = 1; }
  }
  if (settings && archive) {
    try { writeRestoreTestStatus(settings, successful && process.exitCode !== 1 ? 'SUCCESS' : 'FAILED', archive); }
    catch { console.error('Restore-test status write failed'); process.exitCode = 1; }
  }
}
