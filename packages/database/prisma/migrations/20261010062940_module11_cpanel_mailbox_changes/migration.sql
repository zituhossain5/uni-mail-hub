-- CreateEnum
CREATE TYPE "CpanelMailboxChangeAction" AS ENUM ('CREATE', 'ROTATE');

-- CreateEnum
CREATE TYPE "CpanelMailboxChangeStatus" AS ENUM ('PREPARED', 'CRITICAL', 'COMPLETED');

-- CreateTable
CREATE TABLE "CpanelMailboxChange" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "activeEmail" TEXT,
    "action" "CpanelMailboxChangeAction" NOT NULL,
    "status" "CpanelMailboxChangeStatus" NOT NULL DEFAULT 'PREPARED',
    "projectId" TEXT,
    "domainId" TEXT,
    "mailServerId" TEXT,
    "mailHost" TEXT,
    "mailboxId" TEXT,
    "quotaMb" INTEGER,
    "encryptedPassword" TEXT,
    "encryptionIv" TEXT,
    "encryptionAuthTag" TEXT,
    "encryptionVersion" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CpanelMailboxChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CpanelMailboxChange_accountId_status_idx" ON "CpanelMailboxChange"("accountId", "status");

-- CreateIndex
CREATE INDEX "CpanelMailboxChange_email_status_idx" ON "CpanelMailboxChange"("email", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CpanelMailboxChange_activeEmail_key" ON "CpanelMailboxChange"("activeEmail");

-- AddForeignKey
ALTER TABLE "CpanelMailboxChange" ADD CONSTRAINT "CpanelMailboxChange_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CpanelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
