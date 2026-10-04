# Architecture

## Current local architecture

```text
Browser → Next.js App Router / same-origin API relay → NestJS API
                                           │                 │
                                           │                 ├─ PostgreSQL via Prisma
                                           │                 └─ Redis for health checks
                                           └─ HTTP-only session cookie

BullMQ worker → Redis (idle processors for future mail queues)
Mailpit (local SMTP capture, not yet connected)
```

`apps/web` owns the UI and cookie boundary. `apps/api` owns authentication, authorization, registry CRUD, health checks, and audit writes. `apps/worker` owns queue consumers. `packages/shared` holds framework-independent validation and statuses; `packages/config` validates runtime configuration; `packages/database` holds Prisma schema and seed; `packages/mail` marks the future provider adapter boundary.

The API exposes versioned `/api/v1` routes. The currently implemented routes are `/auth/login`, `/auth/me`, `/health`, `/dashboard`, `/projects`, `/domains`, and `/mailboxes`. Future routes can add sending, mailbox checks, and webhooks without changing the browser authentication boundary.

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
- No mail credentials, API key plaintext, or synchronized messages are stored in this phase.
