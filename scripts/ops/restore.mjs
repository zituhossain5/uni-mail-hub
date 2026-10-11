import { databaseSettings, verifyArchive, checkReachable, activeConnections, createBackup, restoreArchive, prismaMigrationStatus, validateRestoreConfirmation } from './db-tools.mjs';

const args = process.argv.slice(2).filter(arg => arg !== '--');
const option = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

try {
  const settings = databaseSettings();
  validateRestoreConfirmation(settings, { backup: option('--backup'), environment: option('--target-environment'), database: option('--target-database'), confirm: option('--confirm'), workersStopped: args.includes('--workers-stopped') });
  const archive = verifyArchive(settings, option('--backup')).archive;
  checkReachable(settings);
  if (activeConnections(settings) > 0) throw new Error('RESTORE_TARGET_HAS_ACTIVE_CONNECTIONS');
  console.log(JSON.stringify({ targetEnvironment: settings.environment, targetHost: settings.host, targetDatabase: settings.name, archive }));
  const before = createBackup(settings, { rotate: false });
  console.log(JSON.stringify({ preRestoreBackup: before.archive, verified: true }));
  restoreArchive(settings, archive, settings.name, true);
  prismaMigrationStatus(settings.url.toString());
  console.log(JSON.stringify({ restored: true, migrationsCurrent: true, targetDatabase: settings.name }));
} catch (error) {
  console.error(`Restore stopped: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
  process.exitCode = 1;
}
