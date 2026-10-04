# Uni Mail Hub

Uni Mail Hub is a local development platform for managing projects, domains, mailboxes, and mail servers and sending small transactional messages through a central API. Module 3 adds project-scoped API keys, explicit sender grants, durable outgoing records, a BullMQ SMTP worker, retries, and attempt history. IMAP synchronization and inbox features are planned for later modules.

## Prerequisites

- Node.js 24 and pnpm 11 (`corepack prepare pnpm@11.24.0 --activate`)
- Docker Desktop with the Linux engine running
- Git

## Start on Windows / PowerShell

```powershell
cd D:\projects\uni-mail-hub
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Set JWT_SECRET, SEED_ADMIN_PASSWORD, and MAIL_CREDENTIAL_ENCRYPTION_KEY in .env.
pnpm install
docker compose up -d
pnpm db:deploy
pnpm db:generate
pnpm db:seed
pnpm dev
```

Open the web app at **http://127.0.0.1:3000**, API health at **http://127.0.0.1:4000/api/v1/health**, and Mailpit at **http://127.0.0.1:8025**. Sign in with `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` from `.env`. There is no public registration. Re-running `pnpm db:seed` rotates the seeded admin password to the current environment value.

Docker Compose runs PostgreSQL (`127.0.0.1:15432`), Redis (`127.0.0.1:16379`), and Mailpit SMTP (`127.0.0.1:51025`). The API and worker run through pnpm on Windows. Stop `pnpm dev` before `pnpm build` or `pnpm db:generate` on Windows; the API can hold Prisma's engine DLL open.

## Module 2: Mail connectivity

Generate a stable Base64 32-byte credential key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and set `MAIL_CREDENTIAL_ENCRYPTION_KEY` in `.env`. Back it up securely. Losing it makes stored mailbox passwords unrecoverable. In the UI, configure **Mail Servers** and **Mailboxes**, then manually run IMAP/SMTP connection checks. The check calls SMTP `verify()` but sends no message. Mailbox passwords can be replaced or removed; they cannot be retrieved.

For local Mailpit, create a Generic Mail Server with SMTP host `127.0.0.1`, port `51025`, security `NONE`, authentication `NONE`, and empty IMAP settings. Mailpit has no IMAP service. Production rejects plaintext SMTP/IMAP connections and validates TLS certificates.

## Module 3: Sending API

Create a Project and sender Mailbox, assign its SMTP server, then open **API Keys**. Create a key for that project with the sender mailbox explicitly selected. Copy the raw `umh_test_...` value when shown; the UI and API cannot retrieve it again. Applications keep that key instead of SMTP credentials. Send to `POST http://127.0.0.1:4000/api/v1/messages` with `Authorization: Bearer <key>` and a fresh `Idempotency-Key`; the API returns a message ID. Query `GET /api/v1/messages/:id` with the same key or inspect **Outgoing Mail** for recipients and SMTP attempts. The dashboard displays real queued, processing, retry, accepted, and failed counts.

The worker sends asynchronously and retries transient failures with bounded exponential backoff. `SMTP_ACCEPTED` means the configured upstream SMTP server accepted the message, not that a recipient's inbox received it. Repeating the same API-key/idempotency-key/body returns the original ID without a second submission. Admins can manually retry final failures. PostgreSQL stores durable state and an outbox; Redis/BullMQ executes jobs. See [sending API](docs/sending-api.md) for complete PowerShell requests, response shapes, status meanings, errors, limits, Mailpit instructions, and a client migration example.

For a safe local test, send only through Mailpit. A real mailbox sends actual mail; configure and use one manually only when intended.

## Commands

| Task | Command |
| --- | --- |
| Start development apps | `pnpm dev` |
| Generate Prisma Client | `pnpm db:generate` |
| Apply existing migrations without a reset | `pnpm db:deploy` |
| Create a development migration | `pnpm db:migrate` |
| Seed or rotate super admin | `pnpm db:seed` |
| Typecheck, lint, build | `pnpm typecheck`, `pnpm lint`, `pnpm build` |
| Unit tests | `pnpm test` |
| Module 1 smoke test (running stack) | `pnpm test:smoke` |
| Module 2 smoke test (running stack) | `pnpm test:module2` |
| Module 3 Mailpit/mock SMTP integration (running stack) | `pnpm test:module3` |
| Stop local infrastructure | `docker compose down` |

`pnpm db:migrate` may prompt if it detects schema drift. Review the prompt before accepting a reset. `docker compose down -v` deletes local database and Redis volumes; run it only when you intend to discard their data.

See [architecture](docs/architecture.md), [mail security](docs/mail-security.md), and [roadmap](docs/roadmap.md). For production, use HTTPS, unique strong secrets, managed PostgreSQL/Redis, a secrets manager, and restricted mail egress. No production deployment is configured in this repository.
