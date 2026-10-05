# Read-only IMAP synchronization

Module 4 runs in `apps/worker` through the existing BullMQ `mail-sync` queue. Jobs contain only `{ mailboxId }`. The API exposes `POST /api/v1/mailboxes/:id/sync` and authenticated `sync-status`, `sync-history`, and `folders` reads. The mailbox detail page uses those endpoints for operational status; message bodies and raw HTML are not exposed there.

## Folder and UID state

Every sync lists server folders and stores path, delimiter, selectability, and special-use classification. Server special-use flags take precedence over a small name fallback. Selectable folders are opened with ImapFlow's `readOnly: true` lock (IMAP `EXAMINE`), and the worker rejects any selection that is not read-only. No IMAP write operation is called.

Each folder stores its UIDVALIDITY, UIDNEXT, and highest persisted UID. UID identity is `(folderId, imapUid)`, never RFC Message-ID. When UIDVALIDITY changes, one database transaction deletes only that folder's stale local messages and resets its cursor. The next initial pass rebuilds the recent window. This deliberately invalidates old local UID assumptions without touching the remote mailbox.

Initial sync searches messages from the last `MAIL_SYNC_INITIAL_DAYS` days within a bounded recent UID window (20 times the configured message cap), takes at most the newest `MAIL_SYNC_INITIAL_MAX_MESSAGES` UIDs, and records the UIDNEXT snapshot as its high-water mark after successful persistence. Messages arriving after that snapshot remain eligible for the next run. Older history is intentionally not imported; future backfill can use the stored folder and UID state. Subsequent runs search UIDs above the cursor, limited to `MAIL_SYNC_BATCH_SIZE` per folder per run. Each new message, structured recipients, attachment metadata, and cursor update share a Prisma transaction. A persistence failure leaves the cursor at the last safe UID. Recent stored flags are refreshed read-only, capped by `MAIL_SYNC_FLAG_REFRESH_LIMIT`.

MailParser reads bounded RFC 822 sources for text, HTML, headers, addresses, and MIME attachment metadata. Attachment bytes are never stored in PostgreSQL. When the reported source size exceeds `MAIL_SYNC_MAX_MESSAGE_BYTES`, the worker skips downloading the source and persists envelope, flags, and body-structure attachment metadata with `SKIPPED_TOO_LARGE`. A malformed MIME source is recorded with `PARSE_FAILED` and envelope metadata, so it does not block following messages. HTML stays untrusted database content and is not rendered by Module 4.

## Scheduling and failures

The worker schedules eligible active mailboxes with configured credentials and active IMAP servers every `MAIL_SYNC_INTERVAL_MINUTES` minutes, including at startup. BullMQ uses a fixed job ID per mailbox to deduplicate waiting and active jobs; a Redis lease with heartbeat prevents overlapping work across worker processes. `MAIL_SYNC_WORKER_CONCURRENCY` caps concurrent IMAP sessions. Transient failures use four bounded BullMQ attempts with exponential backoff. Auth, TLS, missing configuration, disabled mailbox, and decryption failures are not retried. A per-folder error is recorded as a partial or failed run while other folders can continue. Logs and API history contain normalized codes/messages, counts, and identifiers, never credentials or message bodies. Connections are logged out and closed in `finally`, including on failure and shutdown.

## Local test with a dedicated mailbox

Use a disposable cPanel mailbox, not an important production mailbox. In the admin UI, assign an active IMAP server and configure that mailbox's credentials. Confirm **Test IMAP** succeeds, then press **Sync now** and refresh the sync panel until the run finishes. Check discovered folders and stored message count. Run it again and verify message count does not increase for the same UIDs. Send a new message *to* the test mailbox, sync again, and verify only the new UID is added. Compare the message's read state in cPanel before and after; the worker must not mark it read, move it, or delete it. Repeat with a wrong password and then a temporary connection failure; the run should show a sanitized error, with permanent auth failure not retried and transient failure retried. Restore correct settings afterward.

The local `Mailpit` fixture is SMTP-only, so it cannot prove a live IMAP exchange. `pnpm test:module4` covers UID, MIME, size, and safety decisions without a live mailbox. A real cPanel test is still required before production rollout.
