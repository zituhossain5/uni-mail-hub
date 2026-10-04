# Uni Mail Hub

Uni Mail Hub is a local development foundation for a centralized mail control platform. This phase includes a protected dashboard, project/domain/mailbox registries, a versioned NestJS API, PostgreSQL schema, and a BullMQ worker scaffold. Sending and IMAP sync are intentionally not enabled.

## Prerequisites

- Node.js 24 (tested with 24.13.0)
- pnpm 11 (`corepack enable` then `corepack prepare pnpm@11.24.0 --activate` if needed)
- Docker Desktop with the Linux engine running
- Git

## Start on Windows / PowerShell

```powershell
cd D:\projects\uni-mail-hub
Copy-Item .env.example .env
# Edit .env: set JWT_SECRET, SEED_ADMIN_PASSWORD, and MAIL_CREDENTIAL_ENCRYPTION_KEY.
pnpm install
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open the web app at **http://127.0.0.1:3000**, the API health endpoint at **http://127.0.0.1:4000/api/v1/health**, and Mailpit at **http://127.0.0.1:8025**. Sign in using `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` from your `.env`. There is no public registration. Re-running `pnpm db:seed` rotates the seeded admin's password to the current environment value.

All three applications run through pnpm on Windows. Docker Compose runs only PostgreSQL, Redis, and Mailpit, with ports bound to `127.0.0.1`. Host ports avoid existing services on this machine: PostgreSQL uses **15432**, Redis **16379**, Mailpit SMTP **51025**, and Mailpit UI **8025**. The API uses **4000** and Next.js uses **3000**.

## Commands

| Task | Command |
| --- | --- |
| Start app development | `pnpm dev` |
| Generate Prisma Client | `pnpm db:generate` |
| Create/apply a development migration | `pnpm db:migrate` |
| Apply existing migrations | `pnpm db:deploy` |
| Seed or rotate super admin | `pnpm db:seed` |
| Browse local data | `pnpm db:studio` |
| Check TypeScript | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Build all apps | `pnpm build` |
| End-to-end local smoke test (requires running stack) | `pnpm test:smoke` |
| Mail connectivity smoke test (requires Mailpit and running stack) | `pnpm test:module2` |
| Stop local infrastructure | `docker compose down` |

`pnpm db:migrate` may prompt if it detects schema drift. Review the prompt before accepting a reset. **Destructive reset:** `docker compose down -v` deletes the local PostgreSQL and Redis volumes and all their data. Only run that command if you intend to start over.

On Windows, stop `pnpm dev` before `pnpm build` or `pnpm db:generate`: the running API can hold Prisma's generated engine DLL open.

## Architecture and security

The web app uses a same-origin API relay. Login sends credentials to the NestJS API; the web relay stores the returned eight-hour JWT in an HTTP-only, SameSite=Lax cookie, then strips the token from the browser response. Server-rendered protected pages verify the user with `/auth/me`. The API verifies every protected request against the database so disabled users lose access. Registry writes require `SUPER_ADMIN`; a seeded super admin is the only full-access role in this phase. Login is rate limited. Local passwords use Argon2 hashes. The API does not log request bodies, passwords, or tokens.

Project and domain deletions are blocked while they have dependent records. Mailbox connection health comes from manual tests. The dashboard displays real database counts and shows unavailable message metrics as dashes.

For production deployment later, configure HTTPS, a unique strong JWT secret, managed database and Redis, network binding, and an operational secrets store. There is no production deployment configuration in this phase.

## Module 2 — Mail Connectivity

Set `MAIL_CREDENTIAL_ENCRYPTION_KEY` in local `.env` to a Base64-encoded 32-byte key. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` in PowerShell. Keep the key outside Git and back it up securely; losing it makes stored mailbox passwords unrecoverable. Never regenerate it on every boot. The API refuses to start when it is missing or invalid.

In the UI, open **Mail Servers**, add IMAP/SMTP endpoints with explicit TLS modes, then open **Mailboxes** and assign a server. Click a mailbox to configure or replace its credentials and manually run IMAP, SMTP, or combined checks. Connection history and health are based on actual results. **Uni Mail Hub does not retrieve stored mailbox passwords. Replacing a credential requires entering a new password.** Removing a credential leaves the mailbox intact.

For local Mailpit SMTP testing, add a Generic server with SMTP host `127.0.0.1`, port `51025`, security `NONE`, authentication `NONE`; leave both IMAP fields empty. Assign it to a mailbox and click **Test SMTP**. Mailpit's browser UI is at `http://127.0.0.1:8025`. This checks SMTP connectivity only; it sends no message. Mailpit has no IMAP service, so a combined test should show a separate IMAP configuration failure. A real IMAP success requires a mailbox you configure manually. Production forbids unencrypted mail connections and validates TLS certificates. See [mail security](docs/mail-security.md).

See [architecture](docs/architecture.md) and [roadmap](docs/roadmap.md).
