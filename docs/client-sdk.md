# Uni Mail Hub TypeScript client

`@unicodeit/uni-mail` is a private workspace package in
`packages/uni-mail-client`. It is an HTTP client for the existing Sending API;
it contains no SMTP implementation and is not published to npm.

```ts
import { UniMail, UniMailError } from '@unicodeit/uni-mail';

const mail = new UniMail({
  baseUrl: process.env.UNI_MAIL_HUB_URL!,
  apiKey: process.env.UNI_MAIL_HUB_API_KEY!,
  mailboxId: process.env.UNI_MAIL_HUB_MAILBOX_ID!,
});

const result = await mail.send(
  { to: 'client@example.com', subject: 'Hello', html: '<p>Hello</p>' },
  { idempotencyKey: orderId }, // reuse for a retry of this same logical send
);
const status = await mail.getMessage(result.id);
```

`send` supports to, cc, bcc, replyTo, subject, text, and html. It generates a
UUID idempotency key when one is not supplied and returns the key with the
result. It performs no automatic retries. If a network error occurs, the thrown
`UniMailError` carries `idempotencyKey` so the caller can retry the same
logical send safely. A new key for that retry can create a duplicate.

`UniMailError` exposes normalized `status`, `code`, `message`, and safe
validation `details`. The SDK does not log or store the API key, headers, or
server stack traces. Use it only on trusted server-side code, such as a Node.js,
Next.js server route, or NestJS service. The Integration page includes PHP,
Laravel, WordPress, cURL, and PowerShell examples for other applications.
