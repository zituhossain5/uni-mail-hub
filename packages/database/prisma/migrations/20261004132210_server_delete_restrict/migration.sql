ALTER TABLE "Mailbox" DROP CONSTRAINT "Mailbox_mailServerId_fkey";
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_mailServerId_fkey" FOREIGN KEY ("mailServerId") REFERENCES "MailServer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
