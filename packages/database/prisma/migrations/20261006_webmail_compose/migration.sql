ALTER TABLE "OutgoingMessage" ALTER COLUMN "apiKeyId" DROP NOT NULL;
ALTER TABLE "OutgoingMessage" ADD COLUMN "createdByUserId" TEXT;

CREATE UNIQUE INDEX "OutgoingMessage_admin_idempotency_key" ON "OutgoingMessage"("createdByUserId", "idempotencyKey");
ALTER TABLE "OutgoingMessage" ADD CONSTRAINT "OutgoingMessage_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
