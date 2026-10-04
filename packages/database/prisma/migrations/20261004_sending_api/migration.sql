-- CreateEnum
CREATE TYPE "OutgoingStatus" AS ENUM ('QUEUED', 'PROCESSING', 'RETRY_SCHEDULED', 'SMTP_ACCEPTED', 'SMTP_ACCEPTED_WITH_REJECTIONS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecipientType" AS ENUM ('TO', 'CC', 'BCC');

-- CreateEnum
CREATE TYPE "RecipientSmtpStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SmtpAttemptStatus" AS ENUM ('ACCEPTED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('READY', 'PUBLISHED');

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY['MAIL_SEND']::TEXT[];

-- CreateTable
CREATE TABLE "ApiKeyMailboxGrant" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "canSend" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKeyMailboxGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutgoingMessage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "fromMailboxId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "textBody" TEXT,
    "htmlBody" TEXT,
    "replyToEmail" TEXT,
    "replyToName" TEXT,
    "status" "OutgoingStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingAt" TIMESTAMP(3),
    "smtpAcceptedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "rfcMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutgoingMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutgoingRecipient" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" "RecipientType" NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "smtpStatus" "RecipientSmtpStatus" NOT NULL DEFAULT 'PENDING',
    "smtpResponse" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutgoingRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmtpAttempt" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "SmtpAttemptStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latencyMs" INTEGER NOT NULL,
    "smtpResponseCode" INTEGER,
    "smtpResponse" TEXT,
    "messageIdHeader" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmtpAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'READY',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKeyMailboxGrant_mailboxId_idx" ON "ApiKeyMailboxGrant"("mailboxId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyMailboxGrant_apiKeyId_mailboxId_key" ON "ApiKeyMailboxGrant"("apiKeyId", "mailboxId");

-- CreateIndex
CREATE INDEX "OutgoingMessage_projectId_createdAt_idx" ON "OutgoingMessage"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "OutgoingMessage_status_createdAt_idx" ON "OutgoingMessage"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutgoingMessage_apiKeyId_idempotencyKey_key" ON "OutgoingMessage"("apiKeyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OutgoingRecipient_messageId_type_idx" ON "OutgoingRecipient"("messageId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "SmtpAttempt_messageId_attemptNumber_key" ON "SmtpAttempt"("messageId", "attemptNumber");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyMailboxGrant" ADD CONSTRAINT "ApiKeyMailboxGrant_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyMailboxGrant" ADD CONSTRAINT "ApiKeyMailboxGrant_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutgoingMessage" ADD CONSTRAINT "OutgoingMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutgoingMessage" ADD CONSTRAINT "OutgoingMessage_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutgoingMessage" ADD CONSTRAINT "OutgoingMessage_fromMailboxId_fkey" FOREIGN KEY ("fromMailboxId") REFERENCES "Mailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutgoingRecipient" ADD CONSTRAINT "OutgoingRecipient_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "OutgoingMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmtpAttempt" ADD CONSTRAINT "SmtpAttempt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "OutgoingMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmtpAttempt" ADD CONSTRAINT "SmtpAttempt_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "OutgoingMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
