-- Keep encrypted recovery material if an account removal races with a mailbox change.
ALTER TABLE "CpanelMailboxChange" DROP CONSTRAINT "CpanelMailboxChange_accountId_fkey";
ALTER TABLE "CpanelMailboxChange" ADD CONSTRAINT "CpanelMailboxChange_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CpanelAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
