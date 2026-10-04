UPDATE "MailServer" SET "imapSecurity" = CASE WHEN "imapSecure" THEN 'TLS'::"ConnectionSecurity" ELSE 'NONE'::"ConnectionSecurity" END,
"smtpSecurity" = CASE WHEN "smtpSecure" THEN 'TLS'::"ConnectionSecurity" ELSE 'NONE'::"ConnectionSecurity" END;
ALTER TABLE "MailServer" DROP COLUMN "imapSecure", DROP COLUMN "smtpSecure", ADD COLUMN "lastTestAt" TIMESTAMP(3);
