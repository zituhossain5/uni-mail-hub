# Disaster recovery

The recovery set is a verified PostgreSQL dump, the **original** `MAIL_CREDENTIAL_ENCRYPTION_KEY` kept separately, and the deployment configuration and secrets inventory. A database backup without that key cannot recover encrypted mailbox credentials, cPanel tokens, webhook signing secrets, or TOTP secrets. Protect dumps as sensitive mail data; use encrypted storage, restricted access, and encrypted off-server copies. Never attach dumps or secrets to chat, tickets, or Git.

## VPS loss

Provision a replacement host and private PostgreSQL/Redis services. Retrieve a verified off-server database backup and the original encryption key through separate authorized channels. Restore other configuration from secret management: database/Redis connection URLs, public web/API URLs, allowed origins, JWT signing secret, SMTP/IMAP integration settings, and TLS/reverse-proxy configuration. Verify the archive and use the deliberate procedure in [backup-restore.md](backup-restore.md) against the replacement database. Run `pnpm db:status` and `pnpm security:check` before exposing the API or starting workers. Restore or rebuild Redis operational state; it is not the authoritative backup. Check durable outbox reconciliation, delayed work, mail sync, monitoring, webhook delivery, and API health before reopening traffic.

## PostgreSQL corruption

Stop API and worker writes. Preserve a restricted forensic copy of current state if possible, then identify the last known good verified archive. Test it in a private non-production database first. Confirm recovery point and potential data loss with the incident owner. Restore only after the target is quiescent; the restore tool creates a pre-restore backup and refuses other active connections. Validate migrations, secret decryptability, counts, foreign keys, and application health. Reconcile outgoing mail carefully to avoid sending a message twice after rollback.

## Encryption key lost or compromised

If the key is missing, retrieve the preserved original from the separate secure backup. If every copy is lost, the encrypted values in PostgreSQL cannot be decrypted; re-enter mailbox credentials and cPanel tokens, recreate webhook secrets, re-enroll TOTP through an audited recovery process, and revoke sessions. A new key cannot decrypt old ciphertext.

If the key may be compromised, restrict access, preserve evidence, rotate upstream mailbox passwords and cPanel tokens, recreate webhook secrets, review TOTP exposure, and revoke sessions. Re-encrypt stored secrets with a reviewed migration using fresh nonces before switching keys. See [secrets-runbook.md](secrets-runbook.md); there is no automatic key rotation command.

## Recovery verification

Redis AOF or RDB persistence can limit operational queue loss, but it is an additional protection and never replaces PostgreSQL backups. After Redis loss, inspect BullMQ state and the database outbox before allowing automatic retries; some delayed work may need deliberate requeueing.

Check the latest verified backup, checksum, age, and restore-test status with `pnpm backup:status`. Check migration state with `pnpm db:status`, decryptability with `pnpm security:check`, and application-specific API/worker smoke tests. Preserve incident timestamps, selected archive name, recovery point, and non-sensitive count comparisons in the incident record. Do not record passwords, keys, tokens, or mail content. Schedule daily backups, nightly archive verification, weekly test restores, and off-server replication during deployment; this module creates no VPS schedule.
