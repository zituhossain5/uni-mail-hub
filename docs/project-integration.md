# Project integration

Create a project from the Projects registry. New projects open directly on
Project → Integration. Add or select its domain, choose the cPanel account that
owns the domain, create or import a mailbox, and test its connection. Then choose
one or more permitted sender mailboxes and create an application credential.
No sender is granted by default.

The Integration page uses the existing project API key system. It displays the
new raw key once. Store it in your application's server environment. An existing
key cannot be retrieved. To rotate, create a replacement key, update the
application, verify sending, and revoke the old key. The page records key
creation and configuration copying in the audit log.

Configure `UNI_MAIL_HUB_PUBLIC_URL` on the Uni Mail Hub web server in production
so generated configuration contains the public API origin. In local development
it falls back to `API_URL`. Copy:

```env
UNI_MAIL_HUB_URL=http://127.0.0.1:4000
UNI_MAIL_HUB_API_KEY=PASTE_NEW_KEY_HERE
UNI_MAIL_HUB_MAILBOX_ID=SELECTED_MAILBOX_ID
```

Applications call `POST /api/v1/messages` with a Bearer API key,
`Idempotency-Key`, and JSON containing `fromMailboxId`, recipients, subject,
and text or HTML. The key must have a grant for that mailbox. The Integration
page offers copyable Node.js, Next.js, NestJS, PHP, Laravel, WordPress, cURL,
and PowerShell examples. The WordPress example sends an application-specific
message and does not replace `wp_mail()` globally.

For an existing application:

1. Import or discover its mailbox.
2. Enter the known password or explicitly rotate it.
3. Test IMAP and SMTP, then sync.
4. Create an API key and grant only required senders.
5. Replace SMTP settings with the three Uni Mail Hub variables.
6. Test a send and inspect Outgoing Mail.
7. Remove old SMTP secrets from the application.

Existing webhook endpoints appear on the Integration page; manage them on the
project's Webhooks tab. Webhook signing secrets are separate from API keys.
