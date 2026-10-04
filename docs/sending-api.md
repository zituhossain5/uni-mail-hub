# Sending API (Module 3)

Uni Mail Hub accepts small transactional and operational messages from applications. Applications keep a project API key; only Uni Mail Hub holds SMTP configuration and encrypted mailbox credentials. The API is at `http://127.0.0.1:4000/api/v1` in the local setup.

## Create a sender key

In the admin UI, create or select a Project, configure an SMTP Mail Server, and assign it to a Mailbox in that Project. Open **API Keys**, select that Project and one or more sender Mailboxes, optionally set an expiration, and create a key. Copy the `umh_test_...` value from the creation dialog immediately. The raw value is never returned by list or detail endpoints. To rotate, create a replacement key, update clients, then revoke the previous key. Disabling is reversible; revocation is permanent. An API key can send only from its selected mailboxes, and grants can be edited from the API Keys page.

Use the direct API endpoint for application traffic. The browser web app uses a separate session cookie and admin routes.

## Submit a message

```powershell
$apiKey = 'umh_test_REPLACE_WITH_THE_KEY_COPIED_ONCE'
$mailboxId = 'REPLACE_WITH_MAILBOX_ID'
$idempotencyKey = [guid]::NewGuid().ToString()
$body = @{
  fromMailboxId = $mailboxId
  to = @(@{ email = 'recipient@example.test'; name = 'Recipient' })
  subject = 'Mailpit test'
  text = 'Hello from Uni Mail Hub.'
  html = '<p>Hello from Uni Mail Hub.</p>'
} | ConvertTo-Json -Depth 6
$headers = @{ Authorization = "Bearer $apiKey"; 'Idempotency-Key' = $idempotencyKey }
$result = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4000/api/v1/messages' -Headers $headers -ContentType 'application/json' -Body $body
$result
```

Example `202 Accepted` body (IDs and times vary):

```json
{"id":"cm123example","status":"QUEUED","createdAt":"2026-10-04T12:00:00.000Z"}
```

At least one address is required across `to`, `cc`, and `bcc`; each is an array with the `{ email, name? }` shape. `replyTo` is an optional address object. Supply at least one of `text` or `html`. The sender address and display name come from the authorized mailbox. The strict request schema rejects SMTP credentials, custom headers, arbitrary From addresses, and attachments. Limits default to 50 total recipients and 1 MiB of JSON request content; see environment settings below.

`Idempotency-Key` is required and must contain 1–128 letters, digits, `.`, `_`, `:`, or `-`. Repeating the same request body with the same key and API key returns the existing message ID. Reusing that idempotency key with changed content returns `409 IDEMPOTENCY_CONFLICT`. Different API keys have separate idempotency spaces. If the API returns `503 QUEUE_UNAVAILABLE`, the message has been saved in PostgreSQL; retry with **the same** idempotency key and body. The worker also republishes due outbox records.

## Check status

```powershell
$message = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:4000/api/v1/messages/$($result.id)" -Headers @{ Authorization = "Bearer $apiKey" }
$message
```

An API key can query only its own messages. Example response:

```json
{
  "id":"cm123example",
  "status":"SMTP_ACCEPTED",
  "subject":"Mailpit test",
  "queuedAt":"2026-10-04T12:00:00.000Z",
  "processingAt":"2026-10-04T12:00:01.000Z",
  "smtpAcceptedAt":"2026-10-04T12:00:02.000Z",
  "failedAt":null,
  "createdAt":"2026-10-04T12:00:00.000Z",
  "lastErrorCode":null,
  "fromMailbox":{"id":"cm456example","email":"sender@example.test"},
  "recipients":[{"type":"TO","email":"recipient@example.test","name":"Recipient","smtpStatus":"ACCEPTED"}]
}
```

The client status response omits BCC recipients. Admins can inspect all recipients and each SMTP attempt in **Outgoing Mail**.

| Status | Meaning |
| --- | --- |
| `QUEUED` | Saved and pending worker processing. |
| `PROCESSING` | A worker has claimed the message. |
| `RETRY_SCHEDULED` | A transient SMTP failure is waiting for another attempt. |
| `SMTP_ACCEPTED` | The upstream SMTP server accepted every envelope recipient. |
| `SMTP_ACCEPTED_WITH_REJECTIONS` | The server accepted at least one recipient and rejected another. The accepted recipients are not automatically resent. |
| `FAILED` | A permanent failure or exhausted retry budget. An admin may manually retry. |
| `CANCELLED` | Reserved status; no client cancellation endpoint exists yet. |

SMTP acceptance means the upstream server accepted submission. It does not prove inbox delivery; later bounces are outside this module.

Errors use `{ "code": "...", "message": "..." }` with an appropriate HTTP status. Common codes are `API_KEY_INVALID` (401), `API_KEY_REVOKED` (401), `API_KEY_EXPIRED` (401), `API_KEY_SCOPE_DENIED` (403), `SENDER_NOT_AUTHORIZED` (403), `RATE_LIMIT_EXCEEDED` (429), `IDEMPOTENCY_KEY_REQUIRED` (400), `IDEMPOTENCY_CONFLICT` (409), `MAILBOX_NOT_CONFIGURED` (409), `TOO_MANY_RECIPIENTS` (400), `MESSAGE_TOO_LARGE` (413), and `QUEUE_UNAVAILABLE` (503). Invalid JSON fields receive a validation error. Never put a key in a URL or log it.

## Retry and queue behavior

The worker sends through the mailbox's configured SMTP server. It records one attempt per SMTP call, including sanitized error code and recipient acceptance. Transient network errors and SMTP 4xx responses retry with exponential delays of `MAIL_SEND_BACKOFF_BASE_MS × 2^(attempt number − 1)` until `MAIL_SEND_MAX_ATTEMPTS` is reached (defaults: 60 seconds and four attempts). SMTP authentication and permanent 5xx failures stop automatically. Admins can retry a final `FAILED` message in **Outgoing Mail**; that creates a new queue event and preserves prior attempts. A duplicate queue job for an already accepted message is skipped.

PostgreSQL stores messages, idempotency keys, grants, attempts, and a durable outbox. BullMQ in Redis executes jobs whose payload contains only a message ID. A periodic worker dispatches due outbox events and recovers stale `PROCESSING` records after two minutes. If a worker loses its result after SMTP accepts a message but before PostgreSQL records it, recovery can cause a duplicate email. Idempotency prevents duplicate **submissions** but cannot provide exactly-once SMTP delivery. Use an application level reference in the body if a recipient must recognize that case.

Defaults are configured in `.env.example`: `MAIL_API_RATE_LIMIT_MAX=60` per key per `MAIL_API_RATE_LIMIT_WINDOW_SECONDS=60`, `MAIL_SEND_WORKER_CONCURRENCY=5`, `MAIL_MAX_RECIPIENTS=50`, and `MAIL_MAX_BODY_BYTES=1048576`. Per-mailbox throttling is a later enhancement; the per-key rate limit and bounded worker concurrency apply now.

## Test safely with Mailpit

Run `docker compose up -d`, `pnpm db:deploy`, and `pnpm dev`. Configure a Generic Mail Server with SMTP host `127.0.0.1`, port `51025`, security `NONE`, authentication `NONE`; assign it to a test mailbox. Create a key with that mailbox grant and submit the PowerShell example above. Inspect the message in **Outgoing Mail** and at `http://127.0.0.1:8025`. Reuse `$idempotencyKey` and `$body` to confirm that Mailpit receives no second copy. Revoke the key in **API Keys** and confirm a new request returns `API_KEY_REVOKED`; an ungranted mailbox returns `SENDER_NOT_AUTHORIZED` before revocation.

`pnpm test:module3` runs an integration suite against the running local API, worker, PostgreSQL, Redis, and Mailpit. It creates temporary test records and uses a local mock SMTP server for failure cases. It never sends through a real mailbox. To test a real mailbox, configure it yourself and submit a message to an address you control; do this only when you intend to send actual mail.

## Migrate a client application

Replace client SMTP settings such as `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, and `MAIL_PASSWORD` with:

```env
UNI_MAIL_HUB_URL=http://127.0.0.1:4000
UNI_MAIL_HUB_API_KEY=umh_test_...
```

Call `POST $UNI_MAIL_HUB_URL/api/v1/messages` with the bearer key and a fresh idempotency key for each logical message. Preserve the same idempotency key when retrying that request. Remove old SMTP settings from an application only after its own integration is working; this repository does not edit external applications.
