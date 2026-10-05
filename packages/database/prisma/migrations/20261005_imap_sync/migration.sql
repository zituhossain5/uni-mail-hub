-- CreateEnum
CREATE TYPE "MailFolderSpecialUse" AS ENUM ('INBOX', 'SENT', 'DRAFTS', 'TRASH', 'JUNK', 'ARCHIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "MailContentStatus" AS ENUM ('COMPLETE', 'SKIPPED_TOO_LARGE', 'PARSE_FAILED');

-- CreateEnum
CREATE TYPE "MailSyncStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "MailRecipientType" AS ENUM ('TO', 'CC', 'BCC', 'REPLY_TO');

-- CreateTable
CREATE TABLE "MailFolder" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "delimiter" TEXT,
    "specialUse" "MailFolderSpecialUse" NOT NULL DEFAULT 'OTHER',
    "isSelectable" BOOLEAN NOT NULL DEFAULT true,
    "uidValidity" TEXT,
    "uidNext" BIGINT,
    "highestSyncedUid" BIGINT NOT NULL DEFAULT 0,
    "messageCount" INTEGER,
    "unseenCount" INTEGER,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailMessage" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "imapUid" BIGINT NOT NULL,
    "messageIdHeader" TEXT,
    "subject" TEXT,
    "date" TIMESTAMP(3),
    "internalDate" TIMESTAMP(3),
    "fromName" TEXT,
    "fromEmail" TEXT,
    "textBody" TEXT,
    "htmlBody" TEXT,
    "sizeBytes" BIGINT,
    "contentStatus" "MailContentStatus" NOT NULL DEFAULT 'COMPLETE',
    "isSeen" BOOLEAN NOT NULL DEFAULT false,
    "isFlagged" BOOLEAN NOT NULL DEFAULT false,
    "isAnswered" BOOLEAN NOT NULL DEFAULT false,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "inReplyTo" TEXT,
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailRecipient" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" "MailRecipientType" NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,

    CONSTRAINT "MailRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "filename" TEXT,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "contentId" TEXT,
    "disposition" TEXT,
    "imapPart" TEXT,

    CONSTRAINT "MailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailSyncRun" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "status" "MailSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "foldersProcessed" INTEGER NOT NULL DEFAULT 0,
    "messagesAdded" INTEGER NOT NULL DEFAULT 0,
    "messagesUpdated" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailFolder_mailboxId_specialUse_idx" ON "MailFolder"("mailboxId", "specialUse");

-- CreateIndex
CREATE UNIQUE INDEX "MailFolder_mailboxId_path_key" ON "MailFolder"("mailboxId", "path");

-- CreateIndex
CREATE INDEX "MailMessage_mailboxId_internalDate_idx" ON "MailMessage"("mailboxId", "internalDate");

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_folderId_imapUid_key" ON "MailMessage"("folderId", "imapUid");

-- CreateIndex
CREATE INDEX "MailRecipient_messageId_type_idx" ON "MailRecipient"("messageId", "type");

-- CreateIndex
CREATE INDEX "MailAttachment_messageId_idx" ON "MailAttachment"("messageId");

-- CreateIndex
CREATE INDEX "MailSyncRun_mailboxId_startedAt_idx" ON "MailSyncRun"("mailboxId", "startedAt");

-- CreateIndex
CREATE INDEX "MailSyncRun_status_startedAt_idx" ON "MailSyncRun"("status", "startedAt");

-- AddForeignKey
ALTER TABLE "MailFolder" ADD CONSTRAINT "MailFolder_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "MailFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailRecipient" ADD CONSTRAINT "MailRecipient_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "MailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAttachment" ADD CONSTRAINT "MailAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "MailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailSyncRun" ADD CONSTRAINT "MailSyncRun_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
