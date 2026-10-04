# Architecture

## Current local architecture

```text
Browser → Next.js App Router / same-origin API relay → NestJS API
                                           │                 │
                                           │                 ├─ PostgreSQL via Prisma
                                           │                 └─ Redis for health checks
                                           └─ HTTP-only session cookie

BullMQ worker → Redis (idle processors for future mail queues)
Mailpit (local SMTP verification target; no message is sent)
```

`apps/web` owns the UI and cookie boundary. `apps/api` owns authentication, authorization, registry CRUD, manual connection checks, and audit writes. `apps/worker` owns queue consumers. `packages/shared` holds validation and statuses; `packages/config` validates runtime configuration; `packages/database` holds Prisma schema and seed; `packages/security` holds AES-256-GCM encryption; `packages/mail` holds short-lived IMAP and SMTP verification clients.

The API exposes versioned `/api/v1` routes for authentication, the dashboard, registry records, credentials, connection checks, and history. Future sending and webhooks can use the same browser authentication boundary.

## Mail credential trust boundary

```text
Mailbox → Mailbox Credential Vault → AES-256-GCM → Connectivity Service
                                                  ├── ImapFlow connect/logout
                                                  └── Nodemailer verify/close
```

MailServer stores reusable endpoints and transport modes. MailboxCredential stores username and versioned encrypted password material. The master key exists only in the API environment, never in PostgreSQL. The API decrypts only for a manual test. MailboxConnectionCheck stores per-protocol sanitized outcomes and latency. Changing credentials or server configuration increments a version so old checks no longer define current health. The server UI summarizes assigned mailbox results; it does not claim server health from configuration alone. The connection service is independent of controllers for future worker reuse; no scheduled tests run in this module.

## Intended mail flow

```text
Applications
    ↓ project-scoped API keys
Uni Mail Hub API
    ↓ authentication and authorization
Redis / BullMQ
    ↓
SMTP worker
    ↓
Mail provider (initially existing cPanel mail infrastructure)

Mail provider
    ↓ IMAP
Sync worker
    ↓
PostgreSQL
    ↓
Uni Mail Hub web UI
```

Future mail credentials should be centrally encrypted with a dedicated managed key and rotated without exposing plaintext to websites. Websites should use project-scoped API keys, stored only as hashes, rather than SMTP passwords. Sending, receiving, DNS checks, and provider integration require separate implementation and security review.

## Security boundaries

- The web relay accepts browser requests from its own origin and keeps the JWT in an HTTP-only cookie. Direct API routes require Bearer authentication.
- The API looks up the user on each request and checks `isActive`; registry controllers require `SUPER_ADMIN`.
- Prisma relational constraints prevent orphaned domains and mailboxes; the API validates mailbox address, domain, and project consistency.
- Registry changes write audit events. Request logs contain method, path, status, duration, and request ID but no body or authorization header.
- Encrypted credentials are stored separately from mailboxes. No plaintext mail passwords, API key plaintext, or synchronized messages are stored.
