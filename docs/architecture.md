# Architecture

```text
Browser -> Next.js UI and cookie relay -> NestJS admin API -> PostgreSQL
Client application -> project API key -> NestJS sending API -> PostgreSQL message + outbox
                                                        -> BullMQ / Redis -> SMTP worker
                                                                         -> credential vault
                                                                         -> configured SMTP server
Mailpit -> local SMTP capture for tests
IMAP server -> read-only ImapFlow worker -> PostgreSQL folders/messages/sync runs
```

`apps/web` owns the admin UI and HTTP-only session cookie. `apps/api` owns human authentication, project/mailbox/API-key authorization, registry writes, sending request validation, sync enqueueing, and audits. `apps/worker` owns SMTP queue consumers, outbox reconciliation, scheduled IMAP sync, and short-lived read-only IMAP connections. `packages/database` defines business state; `packages/shared` validates requests; `packages/config` validates environment settings; `packages/security` hashes API keys and encrypts credentials; `packages/mail` contains transport helpers, MIME parsing, and safe error classification.

## Sending flow

The admin creates a project-scoped API key and explicitly grants sender mailboxes from that project. Only a SHA-256 hash and a safe prefix are stored. Client applications send a bearer key, an `Idempotency-Key`, and message content to `POST /api/v1/messages`. The API checks key status/scope, a Redis per-key rate limit, mailbox grant, and message limits. A PostgreSQL write creates the outgoing message, structured recipients, and outbox event together. The API publishes a BullMQ job containing only `{messageId}` and returns the message ID.

PostgreSQL is the authority for key grants, idempotency, messages, recipient state, SMTP attempts, and outbox events. Redis/BullMQ distributes work; queue retention does not define message history. If direct queue publication fails after the database write, the durable outbox remains ready and the API returns 503. The worker republishes due events every five seconds and recovers stale processing records after two minutes.

The worker claims a queued message atomically, reads its configured mailbox and server, decrypts a password only if SMTP authentication needs it, opens an SMTP connection, and sends via Nodemailer. Each attempt stores timestamps, sanitized response/error codes, and recipient results. Transient failures schedule exponential backoff through the outbox. Permanent/authentication failures become `FAILED`. Partially accepted recipients are not resent automatically. The admin can manually retry a final failure. An accepted message ignores duplicate queue jobs.

The sender display name/address come from the mailbox. The request cannot provide SMTP secrets or arbitrary headers. `SMTP_ACCEPTED` records upstream SMTP acceptance, not final inbox delivery. If SMTP accepts a message and a worker crashes before its database write, recovery may submit it again. The system provides idempotent submission and durable processing, but cannot promise exactly-once SMTP delivery. The UI's **Outgoing Mail** view contains API-submitted and admin-composed messages; it is not an IMAP Sent folder.

## Mail credential boundary

`MailServer` stores reusable endpoints and transport modes. `MailboxCredential` stores username and versioned AES-256-GCM encrypted password material. The Base64 master key exists only in the API/worker environment, never in PostgreSQL. The API decrypts for manual connection tests; the worker decrypts only when sending through password-authenticated SMTP. Credentials never enter BullMQ jobs or client responses. Mailbox connection checks are manual and record sanitized per-protocol outcomes. Changing credentials or server configuration increments a version so old checks no longer define current health.

## IMAP synchronization

The admin API enqueues `mail-sync` jobs containing only a mailbox ID. The worker decrypts credentials locally, takes a per-mailbox Redis lease, discovers folders, opens each selectable folder with IMAP `EXAMINE`/read-only mode, and stores bounded recent messages and sync runs. PostgreSQL uniqueness on `(folderId, imapUid)` prevents duplicates. UIDVALIDITY changes clear only that folder's local message namespace before a bounded rebuild. Details, limits, retry policy, and test procedure are in [imap-sync.md](imap-sync.md). The mailbox detail page shows status and counts but does not render message HTML.

## Webmail

Authenticated webmail APIs return mailbox-scoped folder and conversation data from PostgreSQL. A persistent thread key derived from References/In-Reply-To/Message-ID groups messages conservatively; 50-item keyset pages keep list payloads light, and the reader fetches bodies only when opened. The API sanitizes HTML, and the browser uses a sandboxed frame with remote images blocked by default. Admin compose writes through the existing outgoing-message/outbox model and SMTP worker. See [webmail.md](webmail.md) for navigation, rendering, and limitations.

## Existing and future features

Human admin routes use JWT through the web relay. The API checks users in the database and requires `SUPER_ADMIN` for registry, sync, webmail, and send-management actions. The application sending route uses a separate API-key guard. Module 1 registry and Module 2 connectivity tests remain available. IMAP mail actions, bounce handling, delivery tracking, bulk campaigns, and provider API integration are deferred.
