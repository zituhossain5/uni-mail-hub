CREATE TYPE "CpanelAccountStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "CpanelConnectionStatus" AS ENUM ('UNTESTED', 'CONNECTED', 'AUTH_FAILED', 'TLS_FAILED', 'TIMEOUT', 'CONNECTION_FAILED');
CREATE TYPE "CpanelDiscoveryState" AS ENUM ('DISCOVERED', 'MANAGED', 'IGNORED', 'MISSING');
CREATE TYPE "CpanelDiscoveryRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

CREATE TABLE "CpanelAccount" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "host" TEXT NOT NULL, "port" INTEGER NOT NULL DEFAULT 2083,
  "username" TEXT NOT NULL, "encryptedApiToken" TEXT NOT NULL, "encryptionIv" TEXT NOT NULL,
  "encryptionAuthTag" TEXT NOT NULL, "encryptionVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "CpanelAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "connectionStatus" "CpanelConnectionStatus" NOT NULL DEFAULT 'UNTESTED',
  "lastConnectedAt" TIMESTAMP(3), "lastDiscoveryAt" TIMESTAMP(3), "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CpanelAccount_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CpanelDiscoveredDomain" (
  "id" TEXT NOT NULL, "accountId" TEXT NOT NULL, "domain" TEXT NOT NULL,
  "state" "CpanelDiscoveryState" NOT NULL DEFAULT 'DISCOVERED',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "managedDomainId" TEXT,
  CONSTRAINT "CpanelDiscoveredDomain_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CpanelDiscoveredMailbox" (
  "id" TEXT NOT NULL, "accountId" TEXT NOT NULL, "email" TEXT NOT NULL, "domain" TEXT NOT NULL,
  "state" "CpanelDiscoveryState" NOT NULL DEFAULT 'DISCOVERED', "managedMailboxId" TEXT,
  "usedBytes" BIGINT, "quotaBytes" BIGINT, "unlimitedQuota" BOOLEAN NOT NULL DEFAULT false,
  "suspended" BOOLEAN, "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CpanelDiscoveredMailbox_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CpanelDiscoveredForwarder" (
  "id" TEXT NOT NULL, "accountId" TEXT NOT NULL, "domain" TEXT NOT NULL,
  "source" TEXT NOT NULL, "destination" TEXT NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CpanelDiscoveredForwarder_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CpanelDiscoveryRun" (
  "id" TEXT NOT NULL, "accountId" TEXT NOT NULL,
  "status" "CpanelDiscoveryRunStatus" NOT NULL DEFAULT 'QUEUED',
  "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "domainsFound" INTEGER NOT NULL DEFAULT 0, "mailboxesFound" INTEGER NOT NULL DEFAULT 0,
  "forwardersFound" INTEGER NOT NULL DEFAULT 0, "newItems" INTEGER NOT NULL DEFAULT 0,
  "missingItems" INTEGER NOT NULL DEFAULT 0, "errorCode" TEXT, "errorMessage" TEXT,
  "requestedByUserId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CpanelDiscoveryRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CpanelDiscoveredDomain_accountId_domain_key" ON "CpanelDiscoveredDomain"("accountId", "domain");
CREATE INDEX "CpanelDiscoveredDomain_state_idx" ON "CpanelDiscoveredDomain"("state");
CREATE UNIQUE INDEX "CpanelDiscoveredMailbox_accountId_email_key" ON "CpanelDiscoveredMailbox"("accountId", "email");
CREATE INDEX "CpanelDiscoveredMailbox_state_idx" ON "CpanelDiscoveredMailbox"("state");
CREATE INDEX "CpanelDiscoveredMailbox_managedMailboxId_idx" ON "CpanelDiscoveredMailbox"("managedMailboxId");
CREATE UNIQUE INDEX "CpanelDiscoveredForwarder_accountId_domain_source_destination_key" ON "CpanelDiscoveredForwarder"("accountId", "domain", "source", "destination");
CREATE INDEX "CpanelDiscoveryRun_accountId_createdAt_idx" ON "CpanelDiscoveryRun"("accountId", "createdAt");
CREATE INDEX "CpanelDiscoveryRun_status_createdAt_idx" ON "CpanelDiscoveryRun"("status", "createdAt");
CREATE UNIQUE INDEX "CpanelDiscoveryRun_one_active_per_account" ON "CpanelDiscoveryRun"("accountId") WHERE "status" IN ('QUEUED', 'RUNNING');
ALTER TABLE "CpanelDiscoveredDomain" ADD CONSTRAINT "CpanelDiscoveredDomain_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CpanelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CpanelDiscoveredMailbox" ADD CONSTRAINT "CpanelDiscoveredMailbox_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CpanelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CpanelDiscoveredMailbox" ADD CONSTRAINT "CpanelDiscoveredMailbox_managedMailboxId_fkey" FOREIGN KEY ("managedMailboxId") REFERENCES "Mailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CpanelDiscoveredForwarder" ADD CONSTRAINT "CpanelDiscoveredForwarder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CpanelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CpanelDiscoveryRun" ADD CONSTRAINT "CpanelDiscoveryRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CpanelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
