# Production operations

Run these commands from the deployment repository on the Linux host. They require a populated `.env.production`. Define a shell helper for this session:

```bash
dc() { docker compose --env-file .env.production -f docker-compose.prod.yml "$@"; }
```

| Task | Command |
| --- | --- |
| Service status | `dc ps` |
| Recent logs | `dc logs --tail=100 api worker web reverse-proxy` |
| Follow worker logs | `dc logs -f --tail=100 worker` |
| Restart API | `dc restart api` |
| Restart worker | `dc restart worker` |
| Restart web | `dc restart web` |
| Production preflight | `pnpm production:check` |
| Read-only smoke | `pnpm production:smoke` |
| Migration status | `dc run --rm ops node node_modules/prisma/build/index.js migrate status --schema packages/database/prisma/schema.prisma` |
| Verified DB backup | `dc run --rm ops node scripts/ops/backup.mjs` |
| Backup status | `dc run --rm ops node scripts/ops/backup.mjs --status` |
| Queue/worker health | `dc exec -T worker node apps/worker/health.mjs` |
| API dependency health | `dc exec -T api node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` |

Use the Monitoring page for queue backlog, mail sync and worker evidence. The worker writes `monitor:worker:last` to Redis every 20 seconds; the health check treats it as stale after the configured interval. `dc ps` should show healthy services. Inspect logs by service and time; do not paste secrets, Authorization headers, raw mail content or a populated env file into tickets.

## Backup and restore test

The backup command creates a PostgreSQL custom archive, checksum and metadata in `BACKUP_HOST_DIR`, verifies the archive with `pg_restore --list`, and records status. The pre-migration deployment path aborts on backup failure. Check `backup-attempt-status.json` and offsite replication separately. The backup directory should be `0700` and files `0600`; the Docker runtime UID is 1000.

For a restore drill, use an isolated local/staging copy and a known archive. The existing `restore-test.mjs` rejects `NODE_ENV=production` and creates/drops only a random temporary database:

```bash
dc run --rm -e NODE_ENV=test ops node scripts/ops/restore-test.mjs --backup /backups/ARCHIVE.dump
```

Do not run a production restore as an ordinary health check. Follow [backup-restore.md](backup-restore.md), [disaster-recovery.md](disaster-recovery.md), and [secrets-runbook.md](secrets-runbook.md) for an actual incident. A database restore is separate from an application image rollback. Preserve the encryption key matching the restored data.

## Routine checks

- Confirm public HTTPS `/login` and `/api/v1/health` return expected responses, with a valid hostname certificate. Verify HTTP redirects to HTTPS. The public health response reports only dependency status.
- Confirm `Secure; HttpOnly; SameSite=Lax` on the administrator cookie through browser developer tools after a controlled login. Do not copy the cookie value.
- Review Docker log rotation (`max-size=10m`, `max-file=5`) and disk free space. PostgreSQL and Redis use persistent named volumes; Redis AOF is enabled.
- Review worker heartbeat and monitoring results. SMTP concurrency is 5, IMAP 3, and the remaining BullMQ queues 1 each. Change these only after measuring.
- Schedule daily `dc run --rm ops node scripts/ops/backup.mjs` with the host scheduler, monitor failures and keep encrypted off-host copies. Retention cleanup is owned by the single worker at 03:00 UTC only when `RETENTION_ENABLED=true`.
- Check image tag, migration status and backup success before any update. Avoid `docker compose down -v` and `prisma migrate reset` on any environment containing useful data.

If a service becomes unhealthy, inspect its limited logs, dependency health and worker heartbeat before restarting. The API and worker handle SIGTERM; Compose grants 30 and 90 seconds respectively. If schema migration failed, leave old services stopped/unchanged, preserve the backup and investigate the migration ledger before retrying.
