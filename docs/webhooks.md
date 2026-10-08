# Project webhooks

Each endpoint belongs to one project and subscribes to selected event types. Open **Projects → project → Webhooks** to create a receiver, select subscriptions, send a synthetic test, inspect delivery history, disable or edit an endpoint, rotate its secret, and replay a failed delivery. The signing secret appears only at creation or rotation. Store it in the receiver's secret manager. The database stores it using the existing AES-256-GCM vault.

Available types: `webhook.test`, `mail.received`, `mail.smtp_accepted`, `mail.failed`, `mail.bounced`, `mailbox.sync_failed`, `monitoring.issue_opened`, and `monitoring.issue_resolved`. Events are created with the business transition in a database transaction and have a unique event key. Each event has one immutable JSON payload and a globally unique UUID. An active subscribed endpoint gets a separate delivery. A test event is explicitly directed to the selected endpoint even if it has not subscribed to `webhook.test`.

Payloads include `eventId`, `type`, and `projectId`. Mail received metadata includes mailbox and message IDs, sender name/address, subject, and received time; it excludes body and attachments. Outgoing events include message ID, mailbox ID, visible TO/CC recipient statuses, timestamp, and a normalized failure code where applicable. BCC addresses are omitted. Bounce events include classification, DSN status code, and correlation status. Monitoring events include issue and target identifiers. No credentials or full mail content are included. System-wide monitoring targets without a project do not emit project webhooks.

## Signing and verification

Each request is an HTTPS `POST` with `Content-Type: application/json`, `X-UniMail-Event`, `X-UniMail-Event-Id`, `X-UniMail-Timestamp`, and `X-UniMail-Signature`. Timestamp is Unix time in **seconds**. Signature is the ASCII string `sha256=` followed by lowercase hex HMAC-SHA256 of the UTF-8 bytes of `timestamp + "." + raw request body`. Verify against the raw request bytes before JSON parsing. A consumer should reject timestamps more than five minutes from its clock and deduplicate by event ID.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyWebhook(rawBody, headers, secret) {
  const timestamp = headers['x-unimail-timestamp'];
  const eventId = headers['x-unimail-event-id'];
  if (!/^\d+$/.test(timestamp ?? '') || !eventId || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret)
    .update(timestamp + '.').update(rawBody).digest('hex'));
  const actual = Buffer.from(headers['x-unimail-signature'] ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

Use the raw `Buffer` supplied by your HTTP framework. Respond with any 2xx status to acknowledge delivery. A 3xx response is **not** followed or treated as success.

## Delivery and retries

The database stores the event and initial delivery before a worker enqueues its ID in BullMQ `webhook-delivery`. Redis jobs contain only `deliveryId`. The worker rechecks project ownership, endpoint state, subscriptions, URL, and public DNS resolution on every attempt. It pins the selected validated address for TCP while preserving the URL hostname for `Host`, TLS SNI, and certificate validation. HTTPS port 443, normal certificate validation, public DNS addresses, a 10 second default timeout, no redirect following, and a 4 KiB response limit are enforced. The response body is discarded; `responseSnippet` stores only `HTTP NNN` to avoid persisting secrets returned by a receiver.

Only 2xx succeeds. Timeout, connection failure, HTTP 408, 429, and 5xx retry after 1, 5, 15, then 60 minutes by default. `Retry-After` on 429/503 may extend the delay up to one hour. Most other 4xx and invalid endpoints fail immediately. `WEBHOOK_MAX_ATTEMPTS` defaults to 5, including the initial attempt; `WEBHOOK_TIMEOUT_MS` and `WEBHOOK_RESPONSE_MAX_BYTES` are configurable. Interrupted deliveries are recovered. Each replay creates a new delivery linked to the failed one and uses the original event payload. Secret rotation affects future attempts and replays.

## Admin API

Authenticated super admins may use `GET/POST /api/v1/admin/projects/:projectId/webhooks`, `PATCH .../webhooks/:endpointId`, `POST .../:endpointId/rotate`, `POST .../:endpointId/test`, `GET .../webhooks/deliveries`, and `POST .../webhooks/deliveries/:deliveryId/replay`. Creation accepts `{ "name": "CRM", "url": "https://receiver.example.org/webhook", "subscriptions": ["mail.received"] }` and returns the secret once. Rotation also returns it once. List and history responses never include the encrypted secret fields.

## Controlled manual verification

1. Provide a **controlled public HTTPS receiver** with a valid certificate on port 443. Localhost/private IP destinations are intentionally rejected. Configure it to capture only synthetic test traffic and verify the HMAC from the raw body.
2. In a disposable project, add the endpoint and copy the one-time secret. Subscribe to `webhook.test`, `mail.received`, `mail.smtp_accepted`, `mail.failed`, and `mail.bounced` as needed.
3. Click **Send test**. Verify timestamp freshness, exact raw-body signature, event ID, and a `DELIVERED` history entry after a 2xx response.
4. Make the receiver respond 500. Send another test and confirm `RETRY_SCHEDULED` plus the next attempt time. Restore 200 and wait for the retry. For a permanent 400, confirm `FAILED`, then use **Replay** after restoring 200; verify a new delivery references the same event ID.
5. Send a brand-new synthetic message to a controlled test mailbox, sync, and verify exactly one `mail.received` event across repeated syncs. Send a synthetic outbound message only to a controlled test recipient and verify `mail.smtp_accepted` and recipient statuses.
6. Import a synthetic single-recipient DSN fixture with the exact outgoing RFC Message-ID and recipient. Verify `mail.bounced`, recipient state, and project suppression. Retry submission to that address and expect `RECIPIENT_SUPPRESSED`; remove the suppression in the project UI and confirm submission can proceed. Never create test bounces against unrelated recipients.
