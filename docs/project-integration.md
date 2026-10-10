# Project integration: direct REST API

The Project → Integration page is the primary internal developer guide. This file is the repository reference. **No Uni Mail Hub package is required. Your application's backend can call the Uni Mail Hub REST API directly.**

## Overview

Application backend → Uni Mail Hub REST API → queue → SMTP worker → configured mailbox / cPanel.

Uni Mail Hub centralizes SMTP credentials, sending, retries, logging, monitoring, bounce handling, and suppression. The application does not manage SMTP credentials. **Environment variables alone are not enough: your backend must call the REST API.**

## Quick start and configuration

In Project → Integration, select the domain and sender mailbox, test IMAP/SMTP, create an application credential with a grant for that sender, and copy the configuration. The raw key appears **once**. Existing key secrets cannot be displayed again; create a replacement if lost. Configuration copying is audited.

Example for an API on port 4000; use the actual configured API base URL:

~~~env
UNI_MAIL_HUB_URL=http://127.0.0.1:4000
UNI_MAIL_HUB_API_KEY=PASTE_NEW_KEY_HERE
UNI_MAIL_HUB_MAILBOX_ID=SELECTED_MAILBOX_ID
~~~

| Variable | Meaning |
| --- | --- |
| UNI_MAIL_HUB_URL | API base URL without /api/v1. Use the configured public HTTPS URL in production where appropriate. |
| UNI_MAIL_HUB_API_KEY | Project-scoped application credential with MAIL_SEND and sender grant. |
| UNI_MAIL_HUB_MAILBOX_ID | Authorized sender mailbox ID. |

The API key is **server-side only**. Never expose it in browser JavaScript, mobile apps, frontend bundles, or NEXT_PUBLIC_ variables. Never commit .env or log the Authorization header. An application using the API does **not** need SMTP_HOST, SMTP_PORT, SMTP_USERNAME, or SMTP_PASSWORD. The Uni Mail Hub web server uses UNI_MAIL_HUB_PUBLIC_URL to generate the production snippet; local development falls back to API_URL.

## Sending API and status

~~~http
POST /api/v1/messages
Authorization: Bearer <UNI_MAIL_HUB_API_KEY>
Content-Type: application/json
Idempotency-Key: <unique-logical-request-id>
~~~

~~~json
{
  "fromMailboxId": "MAILBOX_ID",
  "to": [{ "email": "client@example.com", "name": "Client" }],
  "subject": "Hello",
  "text": "Hello from Uni Mail Hub",
  "html": "<p>Hello from Uni Mail Hub</p>"
}
~~~

HTTP 202 returns a queued message ID; it does not wait for SMTP delivery. Query GET /api/v1/messages/:id with the **same** key. Statuses: QUEUED, PROCESSING, RETRY_SCHEDULED, SMTP_ACCEPTED, FAILED. **SMTP_ACCEPTED means the upstream SMTP server accepted the message; it does not guarantee recipient Inbox placement.**

Use one stable Idempotency-Key per logical email, such as bunevia-contact-9342. Reuse it when retrying the same form submission to prevent duplicates. Use a new key for a different message. Do not generate a new key inside an automatic retry loop.

## New project

1. Create a project, add/select a domain, and create/select a mailbox.
2. Test IMAP and SMTP on the mailbox page.
3. Create an application credential and grant only required senders.
4. Copy the API URL, one-time key, and mailbox ID into the application's private server environment.
5. Implement a backend POST /api/v1/messages request.
6. Send synthetic content to a controlled recipient. Verify Outgoing Mail reaches SMTP_ACCEPTED and confirm receipt.

## Existing SMTP application migration

Import or discover its mailbox, provide the known password or explicitly rotate it, and test IMAP/SMTP. Rotation can interrupt other sites and mail clients using that password.

Replace MAIL_HOST, MAIL_PORT, MAIL_USERNAME, and MAIL_PASSWORD with the three UNI_MAIL_HUB_* settings above. **Replacing environment variables alone does not migrate the application.** Replace SMTP sending code with a backend REST request, grant the project key, test, and then remove old SMTP secrets. To rotate an API key, create a replacement, update and verify the application, then revoke the old key.

## Contact forms

Browser → application backend → Uni Mail Hub → SMTP. Validate and save the form submission in the backend before calling the API. Never call Uni Mail Hub from the browser because the key would be exposed.

Use an authorized mailbox such as contact@bunevia.com as **From** and the visitor such as visitor@gmail.com as **Reply-To**. Do not use the visitor as From. This supports SPF, DKIM, and DMARC alignment. Derive the idempotency key from the saved submission ID.

## Language examples

The Integration page offers copyable direct HTTP examples for Python (httpx), Node.js (native fetch), Next.js server Route Handler, NestJS reusable service, PHP cURL, Laravel Http::withToken, WordPress wp_remote_post, generic cURL, PowerShell Invoke-RestMethod, FastAPI, Django, and Flask. No Uni Mail Hub SDK is required. Each uses Bearer authorization, Content-Type: application/json, an idempotency key, and the same POST endpoint.

Minimal Python backend example:

~~~python
import os
import httpx

response = httpx.post(
    os.environ["UNI_MAIL_HUB_URL"].rstrip("/") + "/api/v1/messages",
    headers={
        "Authorization": "Bearer " + os.environ["UNI_MAIL_HUB_API_KEY"],
        "Content-Type": "application/json",
        "Idempotency-Key": "contact-" + str(submission["id"]),
    },
    json={
        "fromMailboxId": os.environ["UNI_MAIL_HUB_MAILBOX_ID"],
        "to": [{"email": "sales@example.com"}],
        "replyTo": {"email": submission["email"]},
        "subject": "New website enquiry",
        "text": submission["message"],
    },
    timeout=10,
)
response.raise_for_status()
queued = response.json()
~~~

Minimal Node.js backend example:

~~~js
const response = await fetch(process.env.UNI_MAIL_HUB_URL + '/api/v1/messages', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + process.env.UNI_MAIL_HUB_API_KEY,
    'Content-Type': 'application/json',
    'Idempotency-Key': 'contact-' + submission.id,
  },
  body: JSON.stringify({
    fromMailboxId: process.env.UNI_MAIL_HUB_MAILBOX_ID,
    to: [{ email: 'sales@example.com' }],
    replyTo: { email: submission.email },
    subject: 'New website enquiry',
    text: submission.message,
  }),
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error('Mail API HTTP ' + response.status);
const queued = await response.json();
~~~

In Next.js, use a Route Handler, Server Action, or backend service, never a Client Component. In NestJS, use one reusable service. Laravel should use Http::withToken rather than SMTP configuration. WordPress credentials belong in private server configuration; the example does not globally replace wp_mail().

## Optional webhooks

Sending needs no webhook. A project can subscribe to mail.smtp_accepted, mail.failed, mail.bounced, or mail.received for asynchronous updates. Configure these on the project's Webhooks tab. Webhook signing secrets are separate from API keys.

## Testing

Verify: credential created; sender granted; backend environment configured; backend REST call implemented; synthetic test submitted; Outgoing Mail record exists; status reaches SMTP_ACCEPTED; controlled recipient receives the message. The Integration page only marks credential and grant as verified from real project data. Verify the remaining steps in your application or Outgoing Mail. Save the message ID and query status with the same key.

## Troubleshooting

| Code | Likely cause and action |
| --- | --- |
| API_KEY_INVALID | Missing or incorrect Bearer key. Check private server configuration. |
| API_KEY_REVOKED | Create a replacement and update the application. |
| API_KEY_EXPIRED | Create a replacement credential. |
| SENDER_NOT_AUTHORIZED | Sender mailbox is not granted to this key. |
| RECIPIENT_SUPPRESSED | Review suppression and bounce history; do not bypass it. |
| RATE_LIMIT_EXCEEDED | Back off and retry with the same logical idempotency key. |
| IDEMPOTENCY_CONFLICT | The same key was used with different content. Use a distinct key per message. |

If the application cannot connect, check its URL, API process, firewall/network, and the hostname it can reach. On the same VPS, a host process may use http://127.0.0.1:4000 **if that is the configured API port**. Inside Docker, 127.0.0.1 refers to that container; use a reachable service or internal hostname instead. Do not hard-code a deployment assumption.
