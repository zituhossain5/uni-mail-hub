const configModule = await import('../packages/config/dist/index.js');
const databaseModule = await import('../packages/database/generated/client/index.js');
const retentionModule = await import('../apps/worker/dist/retention.js');
const { readConfig } = configModule.default ?? configModule;
const { PrismaClient } = databaseModule.default ?? databaseModule;
const { runRetention, withRetentionLease } = retentionModule.default ?? retentionModule;

const args = process.argv.slice(2).filter(arg => arg !== '--');
const option = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

async function main() {
  const dryRun = args.includes('--dry-run');
  if (dryRun === args.includes('--run')) throw new Error('CHOOSE_DRY_RUN_OR_RUN');
  const config = readConfig();
  const database = decodeURIComponent(new URL(config.DATABASE_URL).pathname.slice(1));
  const host = new URL(config.DATABASE_URL).hostname;
  if (!dryRun) {
    if (option('--environment') !== config.NODE_ENV || option('--database') !== database) throw new Error('TARGET_MISMATCH');
    if (config.NODE_ENV !== 'development' && option('--confirm') !== 'RETENTION UNI MAIL HUB') throw new Error('CONFIRMATION_REQUIRED');
  }
  console.log(JSON.stringify({ environment: config.NODE_ENV, databaseHost: host, database, mode: dryRun ? 'dry-run' : 'delete' }));
  const prisma = new PrismaClient();
  try {
    const result = dryRun
      ? await runRetention(prisma, config, true)
      : await withRetentionLease(config.REDIS_URL, () => runRetention(prisma, config, false));
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(`Retention failed: ${error instanceof Error ? error.message.startsWith('RETENTION_') ? error.message : error.name : 'UNKNOWN'}`);
  process.exitCode = 1;
});
