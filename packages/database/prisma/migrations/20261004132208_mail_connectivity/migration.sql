-- CreateEnum
CREATE TYPE "ConnectionSecurity" AS ENUM ('NONE', 'STARTTLS', 'TLS');

-- CreateEnum
CREATE TYPE "SmtpAuthMode" AS ENUM ('PASSWORD', 'NONE');

-- CreateEnum
CREATE TYPE "MailProtocol" AS ENUM ('IMAP', 'SMTP');

-- CreateEnum
CREATE TYPE "ConnectionCheckStatus" AS ENUM ('SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "MailServer" ADD COLUMN     "imapSecurity" "ConnectionSecurity" NOT NULL DEFAULT 'TLS',
ADD COLUMN     "smtpAuthMode" "SmtpAuthMode" NOT NULL DEFAULT 'PASSWORD',
ADD COLUMN     "smtpSecurity" "ConnectionSecurity" NOT NULL DEFAULT 'TLS',
ALTER COLUMN "providerType" SET DEFAULT 'GENERIC';

-- AlterTable
ALTER TABLE "Mailbox" ADD COLUMN     "connectionConfigVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "MailboxCredential" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "encryptionIv" TEXT NOT NULL,
    "encryptionAuthTag" TEXT NOT NULL,
    "encryptionVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastRotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailboxCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxConnectionCheck" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "protocol" "MailProtocol" NOT NULL,
    "status" "ConnectionCheckStatus" NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "configVersion" INTEGER NOT NULL,
    "testedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "testedByUserId" TEXT,

    CONSTRAINT "MailboxConnectionCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailboxCredential_mailboxId_key" ON "MailboxCredential"("mailboxId");

-- CreateIndex
CREATE INDEX "MailboxConnectionCheck_mailboxId_protocol_testedAt_idx" ON "MailboxConnectionCheck"("mailboxId", "protocol", "testedAt");

-- AddForeignKey
ALTER TABLE "MailboxCredential" ADD CONSTRAINT "MailboxCredential_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxConnectionCheck" ADD CONSTRAINT "MailboxConnectionCheck_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
