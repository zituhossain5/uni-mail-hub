# Module 9 monitoring

The worker runs a check at startup and every `MONITORING_INTERVAL_MINUTES` (default 10). A super admin can use **Monitoring → Run checks now**. The API and UI read persisted `MonitoringRun`, `MonitoringResult`, and `MonitoringIssue` rows. A partial unique index allows one queued or running run at a time; a short Redis lease prevents a second worker from processing one concurrently. Monitoring jobs contain only the run ID. No message body or secret is stored in a monitoring result.

## Health states and evidence

- `HEALTHY` requires a current successful check or recent SMTP acceptance evidence. SMTP acceptance does not establish recipient delivery.
- `WARNING` is an actionable degraded state; `CRITICAL` is a failed or unavailable function.
- `UNKNOWN` means no trustworthy evidence, including a never-synced mailbox, an unconfigured DKIM selector, unlimited/unknown quota, or a plaintext development endpoint without a TLS certificate. Unknown does not automatically clear an open issue.
- Overall mailbox, server, and domain results use the most severe relevant state. Unavailable quota is omitted from the mailbox aggregate; a configured but unknown IMAP/SMTP or sync state remains unknown.

Mailbox monitoring authenticates using the existing read-only IMAP connectivity check and SMTP `verify()`; neither sends or changes mail. Checks run sequentially to limit server load. The latest sync run determines sync failure and freshness; a never-synced mailbox is unknown. Recent outgoing failures, retries, stuck processing, and SMTP acceptance are checked per mailbox and globally.

## Thresholds

| Variable | Default | Meaning |
| --- | ---: | --- |
| `MONITORING_INTERVAL_MINUTES` | 10 | Scheduled run interval |
| `MONITOR_SYNC_WARNING_MINUTES` | 15 | Sync age warning, at least twice the configured sync interval |
| `MONITOR_SYNC_CRITICAL_MINUTES` | 60 | Sync age critical, at least three times the sync interval |
| `MONITOR_QUOTA_WARNING_PERCENT` | 80 | cPanel quota warning |
| `MONITOR_QUOTA_CRITICAL_PERCENT` | 95 | cPanel quota critical |
| `MONITOR_QUOTA_MAX_AGE_HOURS` | 24 | Older discovery quota becomes unknown |
| `MONITOR_WORKER_HEARTBEAT_SECONDS` | 90 | Worker heartbeat timeout |
| `MONITOR_QUEUE_BACKLOG_WARNING` | 100 | Waiting jobs warning |
| `MONITOR_TLS_WARNING_DAYS` | 30 | Certificate expiry warning |

The worker writes a small heartbeat to Redis every 20 seconds. The API checks it live and a 30-second watchdog opens or resolves worker/Redis issues when the worker cannot run monitoring itself. The watchdog writes no database heartbeat and updates a persistent issue at most once a minute. Redis and BullMQ counts (`waiting`, `active`, `delayed`, `failed`) are checked separately. Delayed jobs are not failures by themselves. Outgoing mail becomes critical at three final failures in an hour or any message stuck processing over two minutes; one final failure, ten global retries, five mailbox retries, or queue backlog causes a warning.

## DNS and TLS

Only managed domain records are queried. MX must have at least one exchange. SPF checks presence, duplicate `v=spf1` records, and obvious malformed content; it is not a full SPF policy evaluator. DMARC checks `_dmarc` and validates that a policy is present; `none`, `quarantine`, and `reject` are all accepted. DKIM checks only selectors explicitly saved on the domain detail page. With no selector, DKIM is unknown. A configured selector without a plausible public key produces a warning. DNS lookup failures are unknown and mark the run partial; missing records produce their documented warning or critical states.

Mail TLS checks use only registered mail server hosts and ports. Direct TLS verifies the peer certificate and configured hostname. IMAP and SMTP STARTTLS perform their respective plaintext greeting and upgrade before the same verified TLS handshake. The result stores bounded certificate subject/issuer, validity dates, days remaining, and hostname validation status. Certificate or hostname failures are critical; expiry within 30 days is a warning. `NONE` is unknown, which avoids treating a local Mailpit endpoint as a production certificate failure. TLS validation is never disabled.

## Issue lifecycle and alerts

A warning or critical result opens one issue per target and check. Repeated detection updates `lastDetectedAt`; a verified healthy result resolves it and sets `lastHealthyAt`. A later recurrence creates a new issue, preserving the prior history. Disabling/removing a target or removing a DKIM selector resolves its no-longer-monitored issue without claiming it became healthy. The database enforces one open issue per target/check. **Monitoring → Alert center** shows open and resolved issues and links to registered targets. No email, chat, or webhook notifications are sent.

## Manual verification

1. Start the local stack and sign in as super admin. Open **Monitoring**, run checks, and wait for `SUCCESS` or `PARTIAL`.
2. Verify the mailbox, server, domain, Redis, queue, and heartbeat sections against existing controlled resources. Open a domain to inspect MX, SPF, DMARC, and any known configured DKIM selector.
3. Run checks again. Existing open issues should keep the same IDs while `lastDetectedAt` advances.
4. For a controlled development mailbox only, temporarily use a wrong password, run checks, restore the original password, then run checks again. Confirm a critical authentication issue opens and later resolves. Do not alter a production mailbox or expose its content.
5. If cPanel discovery data exists, compare quota percentage and freshness with the discovered mailbox. Unlimited, unknown, and stale quota must not display a percentage or healthy claim.

The automated `pnpm test:module9` suite mocks DNS and checks mailbox, quota, TLS expiry/error classification, issue decisions, heartbeat, and queue rules. Existing Module 1–8 tests and smoke suites remain separate.
