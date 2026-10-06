ALTER TABLE "MailMessage" ADD COLUMN "threadKey" TEXT;

-- Preserve existing Module 4 data. Standard References/In-Reply-To headers
-- receive the same stable root key as future syncs; uncertain headers stay solo.
WITH roots AS (
  SELECT "id", lower(btrim(coalesce(nullif("references"[1], ''), nullif("inReplyTo", ''), nullif("messageIdHeader", '')), ' <>')) AS header
  FROM "MailMessage"
)
UPDATE "MailMessage" AS message
SET "threadKey" = CASE
  WHEN roots.header ~ '^[^<>[:space:]]+@[^<>[:space:]]+$' THEN 'h:' || md5(roots.header)
  ELSE 'local:' || message."id"
END
FROM roots WHERE roots."id" = message."id";

CREATE INDEX "MailMessage_mailbox_header_idx" ON "MailMessage"("mailboxId", "messageIdHeader");
CREATE INDEX "MailMessage_folder_thread_date_idx" ON "MailMessage"("folderId", "threadKey", "internalDate", "id");
