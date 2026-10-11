import { databaseSettings, createBackup, verifyArchive, backupStatus, writeVerificationStatus } from './db-tools.mjs';

try {
  const settings = databaseSettings();
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  if (args[0] === '--status' && args.length === 1) {
    console.log(JSON.stringify(backupStatus(settings)));
  } else if (args[0] === '--verify' && args.length === 2) {
    try {
      const result = verifyArchive(settings, args[1]);
      writeVerificationStatus(settings, 'SUCCESS', result.archive);
      console.log(JSON.stringify({ verified: true, filename: result.archive, sizeBytes: result.sizeBytes }));
    } catch (error) {
      writeVerificationStatus(settings, 'FAILED', args[1]);
      throw error;
    }
  } else if (args.length === 0) {
    console.log(JSON.stringify({ environment: settings.environment, databaseHost: settings.host, databaseName: settings.name, mode: settings.mode }));
    const result = createBackup(settings);
    console.log(JSON.stringify({ verified: true, filename: result.archive, sizeBytes: result.metadata.sizeBytes, checksum: result.metadata.checksum, rotated: result.rotated }));
  } else throw new Error('BACKUP_USAGE');
} catch (error) {
  console.error(`Backup failed: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
  process.exitCode = 1;
}
