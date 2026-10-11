# Failure recovery runbook

Module 14 recovery testing uses only the local Docker Compose PostgreSQL, Redis, and Mailpit endpoints. `pnpm recovery:test` creates an isolated temporary database and Redis database, exercises API and worker restarts and local dependency outages, and then removes its synthetic fixtures. `pnpm perf:cleanup` resumes isolated fixture cleanup if a run is interrupted. Do not use these commands against remote services.

## Outgoing mail

PostgreSQL and the outbox are the durable source of queued sends. The worker dispatches ready outbox events every five seconds. A message is marked `PRE_SMTP_DISPATCH` before SMTP is invoked and `SMTP_OUTCOME_PENDING` immediately before dispatch. The latter marker matters: after an SMTP timeout or connection loss, the server might have accepted the message even when the worker did not record the result.

The worker checks stale `PROCESSING` messages after `MAIL_PROCESSING_STALE_SECONDS` (default 120). It reconciles a recorded accepted SMTP attempt into a terminal accepted state without sending again. A message still marked `PRE_SMTP_DISPATCH` is safe to requeue. A message marked pending or lacking a trustworthy pre-dispatch marker becomes `FAILED` with `SMTP_OUTCOME_UNKNOWN` and is **not automatically resent**. Inspect the local/remote SMTP server's message log before deciding whether to send a new message. Duplicate outbox and BullMQ jobs are guarded by the database status claim.

Inspect outgoing status, `lastErrorCode`, and SMTP attempt history in Outgoing Mail. Do not use Redis queue contents alone to infer delivery. `SMTP_ACCEPTED` means the SMTP server accepted the message, not that final delivery succeeded.

## Other work

- Mailbox sync uses a Redis lease per mailbox. The worker marks interrupted `RUNNING` sync runs failed when their lease is absent; subsequent scheduled work can sync again. Retry counts and exponential backoff are bounded in the queue options.
- Webhook deliveries stuck in `DELIVERING` are rescheduled after `WEBHOOK_DELIVERING_STALE_SECONDS` (default 120). Retryable HTTP responses use bounded attempt counts and increasing delays. A permanent 4xx response fails the delivery.
- Monitoring has a lease and a database uniqueness guard to prevent overlapping runs. Its scheduler fails stale `RUNNING` and old `QUEUED` records when no live lease exists, using `MONITORING_RUN_STALE_SECONDS` (default 180) and `MONITORING_QUEUED_STALE_SECONDS` (default 120). An active run can reacquire its lease after a Redis restart. It avoids creating a new run while one is queued or active.
- A worker heartbeat is stored in Redis. A missing or stale heartbeat means the worker needs investigation; it does not imply that previously accepted mail should be resent.

## Dependency outage

The API health endpoint checks PostgreSQL and Redis and returns HTTP 503 when either dependency is unavailable. The rate limiter also returns a sanitized 503 if Redis is unavailable, while the public health route bypasses rate limiting so it can report dependency state. After a local restart, wait for `/api/v1/health` to recover, then check worker heartbeat, queue counts, outbox records, and the affected message/run states. The API has SIGTERM/SIGINT shutdown hooks. The worker stops scheduling, closes BullMQ workers and queues, then disconnects Redis and Prisma on SIGTERM/SIGINT. An abrupt kill can still leave in-flight records for reconciliation.

For local diagnosis, run `pnpm test:module14` for deterministic stale-state, cPanel timeout, webhook retry, and mock IMAP lease tests. Run `pnpm perf:test` for isolated load and `pnpm recovery:test` for service restart integration. Avoid clearing the shared Redis database or restoring the active development database. The synthetic harness reserves an empty Redis database and refuses to clear unexpected key prefixes.
