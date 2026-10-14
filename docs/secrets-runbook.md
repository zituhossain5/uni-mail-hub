# Secrets and encryption key runbook

## Inventory and backup

Store `MAIL_CREDENTIAL_ENCRYPTION_KEY` outside the application database in a restricted secrets manager. It is exactly 32 random bytes, encoded as canonical Base64. Back up that value separately from PostgreSQL, with at least two controlled copies and documented access owners. Back up database data, migration records, and the deployment configuration, but exclude plaintext credentials and `.env` files from Git, tickets, and shared archives. A database backup without the encryption key cannot restore mailbox passwords, cPanel tokens, or webhook signing secrets. A key backup without the database cannot restore those records either.

The service never generates or rotates this key at startup. `pnpm security:check` decrypts all stored ciphertext in memory and reports only counts or a generic failure; it never displays plaintext. Run this after restore and before deployment. Limit database dump and key-backup access to separate authorized operators where possible.

## Restore and loss

Restore PostgreSQL into a private target, supply the original encryption key through the secret manager, run `pnpm db:status`, then `pnpm security:check`. Do not start workers that may use credentials until both checks pass. If the key is lost, stored ciphertext is not recoverable. Restore the key from a secure backup. If no backup exists, re-enter all mailbox credentials and cPanel tokens, recreate webhook signing secrets, and revoke sessions. Do not try to infer or brute-force the key.

## Suspected compromise

Restrict access, preserve evidence, and revoke active sessions and exposed API keys. Generate a new key in the secret manager, but do not switch it yet. Rotate upstream mailbox passwords and cPanel tokens because encryption-key compromise plus a database copy can expose them. Rotate webhook signing secrets. Review audit logs and client deliveries. Never place old/new keys or decrypted values in command arguments, logs, tickets, or Git.

## Planned future key rotation

Rotation is deliberately manual until a transactional implementation has been reviewed. Prepare a database backup and confirm restoration first. Keep both old and new keys available only in the restricted maintenance environment. Stop API/worker writers. In batches, decrypt each mailbox credential, cPanel token, and webhook signing secret with the old key; encrypt it with the new key using fresh AES-GCM nonces; update ciphertext, IV, tag, and version transactionally. Verify every changed row decrypts with the new key before switching deployment configuration. Resume services only after `pnpm security:check` passes with the new key. Retain the old key encrypted in a short-lived rollback vault until the rollback window closes, then destroy it according to retention policy. A partial rotation must never leave the service running with one key against mixed ciphertext.

For a non-destructive preflight today, run `pnpm security:check`. It validates the current key against stored encrypted records without revealing or modifying them. It is **not** an automatic rotation command.

## Other credentials

For disaster recovery, preserve the original encryption key exactly. The PostgreSQL and Redis URLs, web/API/CORS URLs, TLS configuration, and JWT signing secret are also needed to rebuild the service. Database and Redis passwords can be rotated once connectivity is re-established. A new JWT signing secret invalidates existing sessions and requires users to sign in again. A replacement encryption key cannot decrypt existing ciphertext; use the reviewed re-encryption procedure above. Keep secret backups separate from database dumps and verify authorized retrieval during a recovery drill. See [backup-restore.md](backup-restore.md) and [disaster-recovery.md](disaster-recovery.md).


JWT signing-secret rotation invalidates existing JWTs; revoke session records and require re-login. Redis and PostgreSQL URL credentials should be rotated with private-network connection tests. API-key rotation is create → update client → verify → revoke old. Webhook secret rotation is one-time display → update receiver → verify signed test → retire old, with a controlled overlap only if the receiver supports it. Rotate the raw Uni Mail API key formerly tracked in `access.txt`; removal from the current tree does not remove it from Git history.
