# Module 14 local performance baseline

These measurements are from an isolated temporary PostgreSQL database, a separate local Redis database, and local Mailpit on the development machine. They are not production service targets. Run `pnpm perf:test` to repeat the synthetic test; it verifies the local Compose endpoints, creates 100 mailboxes, 10,000 mail messages, and 250 cPanel discovery rows, then sends 100 messages only to Mailpit. The harness drops only its temporary database, clears its reserved Redis database, and deletes Mailpit messages carrying its unique Module 14 run prefix. `pnpm perf:cleanup` resumes cleanup after an interrupted run.

## Observed baseline

The clean run used five concurrent SMTP workers. It accepted 100 of 100 synthetic messages in Mailpit with 100 SMTP attempt records and no duplicate attempts. Throughput was about **569 messages/minute** and average time from queue insertion to the start of an SMTP attempt was **7.7 seconds**. The mail-send queue had no waiting, active, delayed, or failed jobs after draining. The duplicate outbox event did not cause a second SMTP attempt.

| API request | Local p95 |
| --- | ---: |
| Mailbox list, 100 rows | 26.7 ms |
| Webmail mailbox list | 13.9 ms |
| Monitoring summary | 28.8 ms |
| cPanel discovery, 20 of 250 rows | 24.1 ms |
| Inbox thread page | 13.0 ms |
| Unified search, 50 rows | 163.3 ms |
| Subject search | 75.9 ms |
| Sender search | 17.4 ms |
| Recipient search | 14.4 ms |
| Body search | 81.9 ms |
| Date filter | 96.2 ms |
| Mailbox filter | 13.0 ms |
| Attachment filter | 33.9 ms |
| Unread filter | 98.8 ms |
| Flagged filter | 30.5 ms |

These are small repeated samples on localhost. The final 10,000 row test walked all 100 unified-search cursor pages at 100 rows each and checked for duplicate or missing IDs; it also checked all 250 discovered mailbox rows across 13 pages. Requests were paced to respect the API's rate limit. It did not establish performance at 50,000+ messages or with concurrent remote users. The search paths with the highest local cost were unified search and unread filtering; profile real query plans before adding indexes.

The isolated API started at 161.6 MiB RSS and ended at 121.7 MiB in the clean run. Across later runs, the worker was about 123 MiB before sending and peaked between 143 and 158 MiB during the batch. CPU time at the end of the clean run was 1.78 seconds for the API and 1.73 seconds for the worker. PostgreSQL connections to the temporary database increased from 2 to 12, and Redis clients on the local server from 19 to 25. These measurements include test process overhead and do not prove absence of a long-term leak.

Mock IMAP lease tests ran 30 synthetic mailboxes at concurrency limits 3, 5, and 10. Observed peak concurrency equaled each configured limit. Elapsed time was approximately 163, 99, and 49 ms respectively. The tests checked that a mailbox cannot overlap itself and that a failed run releases its lease. They do not benchmark real IMAP servers.

## Initial settings

Keep `MAIL_SEND_WORKER_CONCURRENCY=5` and `MAIL_SYNC_WORKER_CONCURRENCY=3` as conservative initial settings. The SMTP result supports five concurrent local Mailpit sends; the IMAP value is based on mock lease behavior, so increase it only after testing actual server connection limits. Webhook and monitoring workers currently run one job at a time; retain that limit. A synthetic monitoring run across 100 mailboxes produced 715 results, completed successfully, and left no monitoring jobs queued. The database rejected a second active run and a duplicate job ID did not duplicate the run. Keep retry and stale-state thresholds within the validation ranges in `packages/config/src/index.ts`. Observe PostgreSQL connection count when scaling API or worker replicas; each process has its own Prisma pool. Size PostgreSQL and Redis for the number of processes and queues, and measure again under the deployed workload.

Use `pnpm recovery:test` for controlled local service restart tests. It briefly stops local Compose Redis and PostgreSQL and should be run only when a short interruption of the local development stack is acceptable.
