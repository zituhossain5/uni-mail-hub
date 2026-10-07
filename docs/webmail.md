# Webmail (Modules 5–7)

Webmail reads synchronized Module 4 data for one selected mailbox at a time. The global Inbox, Sent, and Drafts links resolve that mailbox's IMAP `specialUse` folder; Spam, Trash, Archive, and custom folders appear in the webmail folder rail. The mailbox selector keeps the choice in the URL. If a special folder is absent, the page says so instead of inventing one. The reader has its own route on narrow screens and shares the list pane on wide screens.

Module 7 adds Unified Inbox, Search, Unread, and Flagged views across selected mailboxes and projects. Search and its filter panel include Attachments, folder, sender, recipient, and date filters. Result rows show their mailbox and project and open the existing reader/action flow. The URL retains filters when returning from a result. See [search-unified-inbox.md](search-unified-inbox.md) for the API, authorization boundary, shortcuts, performance behavior, and limits.

## Threads and pagination

Each synchronized message has a persistent `threadKey`. The sync worker prefers the first valid References ID, then an In-Reply-To parent, then the message's own Message-ID. It falls back to a folder/UID identity when headers are missing. A duplicate original Message-ID in one folder is isolated. Subject text alone never joins conversations. This is deliberately conservative: malformed or incomplete headers may leave related messages separate. The additive migration backfills keys for existing Module 4 rows without deleting mail.

`GET /api/v1/mailboxes/:id/folders/:folderId/threads` returns 50 lightweight conversation summaries with a stable date/ID cursor. The database groups by the stored key; it does not send full bodies in the list response. Thread detail fetches up to 20 messages at a time in chronological display order, with an earlier-message cursor. It returns headers, recipients, attachment metadata, and short previews for collapsed messages. The newest message body loads initially; opening another message fetches its body through the individual message endpoint. All endpoints require a signed-in super admin and check folder/message ownership against the mailbox ID. Opening a message alone never changes `\Seen`; Module 6 provides explicit actions.

## Rendering and privacy

The API sanitizes stored HTML with an allowlist before returning it. Scripts, event handlers, JavaScript URLs, embedded frames, executable elements, and style attributes are removed. The UI displays the result inside a sandboxed iframe with a restrictive Content Security Policy and no referrer. Plain text uses escaped React text. List snippets use plain text or server-derived safe text from HTML.

Remote images are replaced with placeholders by default. **Load remote images** requests a separately sanitized version and may contact the sender's image server. Matching CID image parts are fetched from the same authenticated mailbox and shown within the sandboxed reader. Attachment filename, MIME type, size, and a download link appear when the synchronized IMAP part and size permit bounded retrieval. See [mail-actions.md](mail-actions.md).

## Compose and Sent

Admin compose uses the selected managed mailbox, the existing validated sending schema, durable outbox, BullMQ `mail-send` queue, and SMTP worker. It does not use an API key or expose SMTP credentials in the browser. Submission uses an idempotency key; progress and failures appear in **Outgoing Mail**. Reply and Reply All derive recipients from the synchronized original and persist threading headers before sending. Forward includes a text representation of the original message. Original attachments are not forwarded.

**Sent** is the synchronized IMAP `\Sent` folder. **Outgoing Mail** is the local SMTP submission history. SMTP acceptance does not create an IMAP Sent copy; this module does not use IMAP APPEND. Drafts shows only server-synchronized drafts. There are no local compose drafts.

## Local verification

1. Run `pnpm db:deploy`, `pnpm db:generate`, and `pnpm dev` with the local PostgreSQL, Redis, and Mailpit services available.
2. Sign in as a super admin. Configure a dedicated development mailbox's IMAP credentials in its mailbox settings and run **Test IMAP** and **Sync now**. Wait for a successful sync run.
3. Open **Inbox**. Select the mailbox; verify its folders, unread indicators, messages, and a message reader. Open an unread message and confirm its remote read state does not change. Check HTML, plain text, Unicode, and attachment metadata where the test mailbox contains examples.
4. Visit **Sent**, **Drafts**, Spam, Trash, Archive, and custom folders. Missing or empty folders should show a useful state. Switch to another managed mailbox and verify the URL and content change together.
5. Press **Sync now** in webmail and verify the status updates. Compose a message from the selected mailbox to a disposable address, then follow its actual status in **Outgoing Mail**. Do not expect an IMAP Sent copy unless the mail server creates one.
6. Run `pnpm test`, `pnpm test:module5:smoke`, and the Module 1–4 smoke checks. The Module 5 smoke fixture uses disposable rows and local Mailpit, then cleans up.

Explicit IMAP flag and MOVE actions and bounded attachment retrieval are covered in [mail-actions.md](mail-actions.md). Permanent deletion, live IDLE updates, local drafts, and server-side Sent-copy creation remain future work.
