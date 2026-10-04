# Mail security

Only authenticated super administrators may configure mail servers, store credentials, manage API keys, inspect outgoing mail, or trigger connection tests. A compromised database must not reveal mailbox passwords without the separate master key. A compromised API or worker host can decrypt credentials; restrict access to both. Mail host settings can direct outbound traffic, so production operators should restrict egress to approved mail networks where appropriate.

## Credential protection

Each mailbox password is encrypted with AES-256-GCM using a fresh random 96-bit IV and stored with its 128-bit authentication tag and version. `MAIL_CREDENTIAL_ENCRYPTION_KEY` must decode to exactly 32 bytes. Store it in an operational secrets manager in production, outside the database and Git. Losing it makes stored passwords unrecoverable; changing it without re-encrypting old records makes them undecryptable. Automatic key rotation is not implemented. Credential replacement requires entering a new password; no retrieval endpoint exists.

Request logs include only method, path, status, request ID, and duration. They exclude bodies, authorization headers, cookies, and credentials. Audit events contain safe metadata and no password, ciphertext, or key. Prisma query logging is disabled. Passwords are not stored in browser persistence.

## Connection tests

IMAP testing connects, authenticates, and logs out. It does not select or modify mail. SMTP testing calls Nodemailer's `verify()` and closes the transporter; it sends no message. Tests run only when an administrator clicks. A successful test establishes connectivity/authentication, not deliverability. TLS certificate verification remains enabled. Plaintext `NONE` connections are rejected in production and should be used only for local Mailpit or controlled development.

## Sending API boundary

Each application key belongs to one project and has explicit mailbox grants and a `MAIL_SEND` scope. API keys contain 256 random bits and are shown only in the creation response. The database stores a SHA-256 hash and safe prefix, never the raw key. A key can be disabled, permanently revoked, or expired. The API checks current database state on every request, verifies the mailbox's project and grant, and applies a configurable Redis per-key rate limit. Browser sessions and client API keys use separate authentication mechanisms.

The sending request schema accepts recipients, subject, text/HTML body, reply-to, and a mailbox ID. It rejects SMTP credentials, arbitrary From addresses, attachments, and unknown fields. Recipient and request-size limits bound abuse. A required idempotency key is unique per API key and prevents repeated client submissions from creating another message. It cannot prevent all duplicates if an SMTP server accepts a message immediately before a worker or database failure.

PostgreSQL holds durable message state and sanitized SMTP attempt history; BullMQ jobs contain only a message ID. The worker is the only scheduled component that sends SMTP mail. It decrypts a stored credential only for password-authenticated SMTP, and closes its transport after use. API responses never include SMTP usernames, passwords, ciphertext, authentication tags, master keys, or API-key hashes. Client status omits BCC recipients; admins can inspect recipient details. Audits record key and manual retry actions without secrets. The default API rate limit and worker concurrency bound throughput; per-mailbox throttling remains a future enhancement.
