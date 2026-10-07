-- Search remains inside PostgreSQL. These indexes are additive and do not rewrite synced mail.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "MailMessage_search_fts_idx" ON "MailMessage" USING GIN (
  to_tsvector('simple', COALESCE(subject, '') || ' ' || COALESCE("fromName", '') || ' ' ||
    COALESCE("fromEmail", '') || ' ' || COALESCE("textBody", '') || ' ' || COALESCE("messageIdHeader", ''))
);

CREATE INDEX "MailRecipient_search_trgm_idx" ON "MailRecipient" USING GIN (
  (COALESCE(name, '') || ' ' || email) gin_trgm_ops
);

CREATE INDEX "MailMessage_search_thread_idx" ON "MailMessage"
  ("folderId", "threadKey", COALESCE("internalDate", date, "createdAt") DESC, id DESC);
CREATE INDEX "MailMessage_search_unread_idx" ON "MailMessage" ("folderId", "isSeen") WHERE NOT "isSeen";
CREATE INDEX "MailMessage_search_flagged_idx" ON "MailMessage" ("folderId", "isFlagged") WHERE "isFlagged";
CREATE INDEX "MailMessage_search_sender_idx" ON "MailMessage" (LOWER("fromEmail"));
CREATE INDEX "MailRecipient_search_email_idx" ON "MailRecipient" (LOWER(email), type, "messageId");
