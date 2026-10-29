CREATE TABLE "OutgoingAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "disposition" TEXT NOT NULL,
    "contentId" TEXT,
    CONSTRAINT "OutgoingAttachment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OutgoingAttachment_disposition_check" CHECK ("disposition" IN ('inline', 'attachment')),
    CONSTRAINT "OutgoingAttachment_size_check" CHECK ("sizeBytes" >= 0 AND "sizeBytes" <= 10485760 AND octet_length("content") = "sizeBytes")
);
CREATE INDEX "OutgoingAttachment_messageId_idx" ON "OutgoingAttachment"("messageId");
CREATE UNIQUE INDEX "OutgoingAttachment_messageId_contentId_key" ON "OutgoingAttachment"("messageId", "contentId");
ALTER TABLE "OutgoingAttachment" ADD CONSTRAINT "OutgoingAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "OutgoingMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
