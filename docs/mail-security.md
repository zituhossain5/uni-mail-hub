# Mail connectivity security

## Trust and threats

Only authenticated super administrators may configure mail servers, store credentials, or trigger connection tests. A compromised database must not reveal mailbox passwords without the separate master key. A compromised API host or master key can decrypt credentials; protect both and restrict administrator accounts. Mail host settings can direct outbound traffic, so production operators should restrict egress to approved mail networks where appropriate. Internal cPanel hosts may be legitimate.

## Credential protection

Each password is encrypted with AES-256-GCM using a fresh random 96-bit IV and stored with its 128-bit authentication tag and version. The Base64 `MAIL_CREDENTIAL_ENCRYPTION_KEY` must decode to exactly 32 bytes. Store it in an operational secrets manager in production, never in the database or Git. If it is lost, encrypted mailbox passwords cannot be recovered. Changing it without migrating and re-encrypting existing records makes them undecryptable. Automatic key rotation is not implemented. Replace a mailbox credential by entering a new password; the API never offers password retrieval. Credential replacement uses an atomic upsert.

Request logs include only method, path, status, request ID, and duration. They exclude bodies, authorization headers, cookies, and credentials. Audit events record actions and safe result codes; they contain no password, ciphertext, or key. Prisma query logging is disabled. Passwords are not stored in browser persistence.

## Connection test policy

IMAP testing connects, authenticates, and logs out. It does not select a folder or fetch, modify, move, delete, or mark any message. SMTP testing calls Nodemailer's `verify()` and closes the transporter. It never sends a message. Tests run only when an administrator clicks a button; they have bounded network timeouts and no scheduled worker. A successful SMTP verification establishes connectivity and authentication where configured, not deliverability. TLS certificate verification remains enabled. Plaintext `NONE` connections are rejected in production and should only be used for local Mailpit or explicitly controlled development environments.
