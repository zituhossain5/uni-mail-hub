import { databaseSettings } from './db-tools.mjs';

try {
  const settings = databaseSettings();
  if (settings.environment !== 'development' || !['127.0.0.1', 'localhost'].includes(settings.host) || settings.port !== '15432' || settings.name !== 'unimailhub') throw new Error('PREFLIGHT_REQUIRES_LOCAL_DB');
  const clientModule = await import('../../packages/database/generated/client/index.js');
  const { PrismaClient } = clientModule.default ?? clientModule;
  const prisma = new PrismaClient();
  try {
    const [mailboxes, credentials, cpanelAccounts, webhookEndpoints, mailMessages, outgoingMessages, attachments] = await Promise.all([
      prisma.mailbox.count(), prisma.mailboxCredential.count(), prisma.cpanelAccount.count(), prisma.webhookEndpoint.count(), prisma.mailMessage.count(), prisma.outgoingMessage.count(), prisma.mailAttachment.count(),
    ]);
    console.log(JSON.stringify({ environment: settings.environment, host: settings.host, port: settings.port, database: settings.name, mailboxes, credentials, cpanelAccounts, webhookEndpoints, mailMessages, outgoingMessages, attachments }));
  } finally { await prisma.$disconnect(); }
} catch (error) {
  console.error(`Preflight failed: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
  process.exitCode = 1;
}
