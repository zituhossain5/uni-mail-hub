# Data retention

Retention is disabled by default (`RETENTION_ENABLED=false`). Review the dry-run output and local test results before enabling the daily worker on any environment. The worker runs near 03:00 UTC using the existing worker timer and a Redis lease. Manual commands use the same eligibility rules and lease. Each run deletes at most `RETENTION_MAX_ROWS_PER_RUN` (default 10,000) in batches of `RETENTION_BATCH_SIZE` (default 500). Logs and audit records contain aggregate counts, cutoffs, and duration only.

| Data | Default age | Eligibility |
| --- | ---: | --- |
| Monitoring results/runs | 90 days | Terminal runs only; results are removed before their parent runs |
| Monitoring issues | 90 days | Resolved only; open issues remain |
| Webhook deliveries | 90 days | Delivered only; pending, retrying, and failed records remain |
| Webhook events | 180 days | No remaining deliveries |
| Mail sync runs | 90 days | Completed terminal runs only |
| Connection checks | 90 days | Past test time |
| SMTP attempts | 180 days | Linked outgoing message is terminal |
| Audit logs | 365 days | Past creation time; cleanup records a new audit event |

All ages are configurable with `RETENTION_*_DAYS` variables in `.env.example`. `RETENTION_OUTGOING_MESSAGE_DAYS=365` is a reserved policy value; automatic outgoing-message deletion is **deferred** because bounce, event, audit, and delivery references require a separate reviewed lifecycle. Synchronized `MailMessage` rows, their attachments, mailbox credentials, cPanel tokens, webhook secrets, and outgoing messages are retained indefinitely by this job. Remote messages may disappear, so synchronized copies cannot always be re-fetched.

Run a read-only count:

```sh
pnpm retention:dry-run
```

For a deliberate run, confirm the environment and database from the dry run and pass exact target values:

```sh
pnpm retention:run -- --environment development --database unimailhub
```

For non-development environments add `--confirm "RETENTION UNI MAIL HUB"`. The CLI refuses a target mismatch. Back up and verify the database before enabling retention or doing a manual run. Review counts and audit log after execution. Dry-run counts are a snapshot; concurrent writes can change the rows eligible at deletion time. Per-row predicates are repeated in the delete query, and foreign keys remain enforced by PostgreSQL. No mail body or recipient address is logged.

Keep backup retention and database-record retention distinct. `BACKUP_RETENTION_DAYS` controls verified archive rotation; it does not delete database rows. A restored older backup can reintroduce history previously cleaned by retention, so re-evaluate the policy after recovery.
