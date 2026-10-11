# PostgreSQL backup and restore

PostgreSQL is the durable data source. A dump can contain mail bodies, addresses, audit records, and encrypted credentials. Keep it on encrypted storage with access limited to backup operators; never commit, post, or serve a dump publicly. Store `MAIL_CREDENTIAL_ENCRYPTION_KEY` separately as described in [secrets-runbook.md](secrets-runbook.md). A database dump alone cannot recover encrypted mailbox credentials, cPanel tokens, webhook secrets, or TOTP secrets.

## Configuration and tools

Set `DATABASE_URL`, `NODE_ENV`, `BACKUP_DIR`, `BACKUP_RETENTION_DAYS` (default `30`), and `BACKUP_PG_MODE` (`native` or `docker-compose`). Use `native` and installed PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`, `createdb`, `dropdb`) for staging and production. In production `BACKUP_DIR` must be an absolute path outside the repository, on restricted encrypted storage. The local Docker mode is limited to the development Compose PostgreSQL database at loopback port 15432. The development default directory is `.local-backups`, which Git ignores. The backup directory must not be web accessible.

The account in `DATABASE_URL` needs dump access. Test restore also needs permission to create/drop its own temporary database. Restore requires ownership or sufficient privileges to replace target objects. PostgreSQL client major versions must be compatible with the server; use a client version at least as new as the server.

The scripts pass the database password through the child process environment rather than command arguments. Do not enable shell tracing, process environment dumps, or verbose Prisma query logging around these commands. On Linux, directories and files are created with `0700` and `0600` permissions respectively. Restrict the Windows directory through filesystem ACLs.

## Daily backup

From the project root:

```sh
pnpm backup:db
pnpm backup:status
```

`backup:db` reports the target environment, host, and database name, then creates a unique `pg_dump -Fc` archive. It requires a nonempty file and a readable `pg_restore --list` catalog before writing SHA-256 and JSON metadata sidecars and marking it verified. The metadata contains filename, time, environment, database host/name, size, checksum, and application version; it contains no password or encryption key. `backup-attempt-status.json` records the last result. `backup:status` reports the latest marked verified backup, its age, the last attempt, manual verification, and restore-test result. A failed backup or manual verification is `CRITICAL`; a backup older than 26 hours is `WARNING`. Status is a lightweight operational hook, not a fresh archive recheck.

Recheck a specific archive, including its sidecars and `pg_restore` catalog:

```sh
pnpm backup:verify -- /absolute/path/uni-mail-hub-....dump
```

Rotation runs only after a newly verified backup. It keeps at least the newest two verified archives, including their sidecars, and deletes older ones beyond `BACKUP_RETENTION_DAYS` only after re-verification. It leaves unverified or corrupted archives for operator review. Copy verified backups to encrypted off-server storage with restricted access. Keep the encryption-key backup in a separate protected location and test retrieval under incident procedures.

Recommended schedule after deployment: daily backup, nightly `backup:verify` of the newest archive, weekly `backup:test-restore`, and alerts on `backup:status` `WARNING` or `CRITICAL`. Configure the scheduler and external alerting during deployment; this module does not install VPS jobs.

## Non-production restore test

Run on a non-production database server with capacity for a temporary copy:

```sh
pnpm backup:test-restore -- --backup /absolute/path/uni-mail-hub-....dump
```

The script rejects `NODE_ENV=production`, verifies checksum and archive, creates a random `umh_restore_...` database, restores into it in one transaction, checks active Super Admin and key table counts, checks encrypted-record structure and validated foreign keys, then runs `prisma migrate status`. It drops the temporary database in `finally` and records `restore-test-status.json`. It never targets the active database. If cleanup fails, stop and remove only the reported temporary database after verifying its name. Run `pnpm security:check` separately on a private restored environment with the original encryption key to check actual decryptability; the structural restore test does not decrypt secrets.

## Deliberate restore of an existing database

1. Identify the verified archive and target. Confirm the archive is from the intended environment and point-in-time.
2. Stop the web/API and all workers, including mail send/sync, monitoring, webhook delivery, and cPanel discovery. Stop other writers and verify the target is quiescent.
3. Restore the original encryption key and other required configuration from the secret manager. Keep it out of command lines and dumps.
4. Run `pnpm backup:verify -- /absolute/path/to/archive.dump` and check `pnpm backup:status`.
5. Run the command below with the actual `NODE_ENV` and database name. The script requires the exact confirmation phrase and `--workers-stopped`, checks database reachability and that there are no other active connections, creates and verifies a pre-restore backup, then restores with `pg_restore --clean --if-exists --single-transaction --exit-on-error`. **It replaces target data.**

```sh
pnpm restore:db -- --backup /absolute/path/to/archive.dump --target-environment production --target-database ACTUAL_DATABASE_NAME --workers-stopped --confirm "RESTORE UNI MAIL HUB"
```

6. Check `pnpm db:status`; the script also checks migration status and never applies migrations automatically. Resolve any migration mismatch through a reviewed recovery plan. Run `pnpm security:check` with the preserved encryption key. Check representative mailboxes, projects, outbox states, API health, and monitoring before starting workers and accepting traffic.
7. Inspect Redis/BullMQ queues. PostgreSQL is authoritative where designed, but Redis loss may drop delayed or queued work. Let documented outbox/reconciliation paths repopulate durable work; review jobs that have no durable recovery path before reopening traffic.

For development, replace `production` and `ACTUAL_DATABASE_NAME` with the exact development settings. Do not use the restore command to test a dump: use `backup:test-restore`. Never run it while application writers are active. Retain the pre-restore backup until recovery is accepted.

## Local validation sequence

Use only synthetic local data: create records through the existing local test fixtures, run `pnpm backup:db`, `pnpm backup:verify -- <new-archive>`, and `pnpm backup:test-restore -- --backup <new-archive>`. Compare non-sensitive counts and `pnpm db:status`, then run `pnpm retention:dry-run`. Test actual cleanup only with synthetic records and explicit target flags as described in [data-retention.md](data-retention.md). Confirm the original development database still has its expected counts. Unit tests use fake PostgreSQL tools and never copy a real database.
