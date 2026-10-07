-- Substring matching covers partial addresses and Message-IDs that token search splits at punctuation.
CREATE INDEX "MailMessage_search_trgm_idx" ON "MailMessage" USING GIN (
  (COALESCE(subject, '') || ' ' || COALESCE("fromName", '') || ' ' ||
    COALESCE("fromEmail", '') || ' ' || COALESCE("textBody", '') || ' ' || COALESCE("messageIdHeader", '')) gin_trgm_ops
);
