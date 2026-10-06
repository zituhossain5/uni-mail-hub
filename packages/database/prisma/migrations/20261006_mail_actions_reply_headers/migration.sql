ALTER TABLE "OutgoingMessage" ADD COLUMN "inReplyTo" TEXT;
ALTER TABLE "OutgoingMessage" ADD COLUMN "references" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
