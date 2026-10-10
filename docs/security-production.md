# Production security readiness

This is a deployment checklist and operating policy. It does not authorize deployment. The development `docker-compose.yml` uses loopback ports and sample database credentials; do not use it as a production stack.

## Configuration and secrets

Set `NODE_ENV=production` explicitly. Startup rejects missing or invalid `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `MAIL_CREDENTIAL_ENCRYPTION_KEY`, `WEB_URL`, `API_URL`, `UNI_MAIL_HUB_PUBLIC_URL`, and `ALLOWED_ORIGINS`. `WEB_URL`, public API URL, and allowed origins must use HTTPS. `API_URL` may be loopback HTTP only when the web server and API communicate on the same host; the public reverse proxy must provide HTTPS. Use a random 48+ character JWT secret and a separately generated 32-byte Base64 encryption key. Do not reuse passwords. Numeric rate, mail, monitoring, and webhook limits are validated by `@uni/config`. Configuration errors name fields only.

Secret inventory: database/Redis credentials in connection URLs; JWT signing secret; AES encryption key; encrypted mailbox passwords, cPanel tokens, webhook signing secrets, and TOTP secrets in PostgreSQL; hashed API keys and recovery codes; one-time API key and recovery-code displays. Never store raw secrets in source, URLs, browser storage, audit metadata, queue payloads, or routine logs. The key must stay outside PostgreSQL. See [secrets-runbook.md](secrets-runbook.md).

Run `pnpm security:check` before a deployment. It validates configuration, tracked secret-file names, database connectivity, decryption of stored secrets without displaying plaintext, 2FA enrollment for every active SUPER_ADMIN in production, and Prisma migration status. Run `pnpm db:status` separately if a check fails. Never reset the production database to repair migration drift.

## Authentication and sessions

Passwords use Argon2. Login errors are generic, inactive users are blocked, and the login route is limited to five attempts per IP per minute through Redis-backed Nest throttling. Sensitive admin endpoints have lower per-IP limits. The mail sending API separately limits each API key. A limit response uses HTTP 429 and `RATE_LIMIT_EXCEEDED`. The API must have a working private Redis instance; rate limiting fails closed if it is unavailable.

Every successful login creates a database session. JWTs carry a session ID and expire after eight hours. Every authenticated request verifies that the session belongs to the user, is unexpired, and has not been revoked. Logout revokes the session at the API and deletes the browser cookie. Settings → Security shows sessions and supports revocation. Enabling/disabling 2FA revokes other sessions. Password changes are not currently exposed as an application flow; any future password change must revoke all user sessions. A seed run updates the admin password and revokes that user’s sessions; it is still a bootstrap operation and should not be used as a routine password-reset workflow in production.

SUPER_ADMIN accounts can enroll TOTP in Settings → Security after confirming their password. Setup returns a QR code and manual secret once; the pending secret expires after ten minutes. Verification enables 2FA, produces ten single-use recovery codes, and stores only their hashes. TOTP steps are consumed atomically to prevent replay. A signed-in user can regenerate recovery codes with a password and a current TOTP/recovery code. Production disables self-service 2FA removal; an emergency reset requires a documented administrator recovery procedure and session revocation. Existing development admins can enroll before changing to production. `security:check` refuses production readiness while any active SUPER_ADMIN lacks 2FA. Store recovery codes in a secure password manager, separate from the database.

Browser authentication uses a server-set `HttpOnly`, `SameSite=Lax`, path `/` cookie with an eight-hour lifetime. Production sets `Secure`. Tokens are not stored in localStorage or sessionStorage. The Next.js relay accepts state-changing requests only with an `Origin` exactly matching `WEB_URL` and then sends a Bearer token to the API. The API itself uses Bearer/API-key authorization rather than cookies, so a separate API CSRF token is not needed. Any future direct cookie-authenticated API route requires a new CSRF review. The relay limits JSON request bodies to 2 MiB; the API sets the same parser limit, while mail payloads retain their stricter application limits.

## Browser, API, and data boundaries

Production `ALLOWED_ORIGINS` is an explicit comma-separated HTTPS allowlist containing `WEB_URL`; authenticated admin APIs never use wildcard CORS or credentialed cross-origin requests. Helmet protects API responses. Next.js adds `nosniff`, frame denial, referrer and permissions policies, a partial CSP (`frame-ancestors`, `object-src`, `base-uri`), and production HSTS. A full script/style CSP needs a nonce-based Next.js rollout before enabling it, to avoid breaking hydration. This is a remaining browser-hardening task.

API keys are random, hashed at rest, displayed only at creation, scoped to projects/mailboxes, individually revocable/disableable, optionally expiring, and tracked with last use. Rotate by creating a replacement key, updating the client, verifying delivery, then revoking the old key. Never retrieve or display a historical raw key. The previously tracked `access.txt` contained a raw Uni Mail API key and has been removed from the working tree. **Find and revoke that key before production use; deleting the file does not erase Git history.** Do not post the value in an issue or log.

Mailbox and cPanel connection tests are admin-only. cPanel and webhook targets validate public hosts, resolve and validate addresses, then pin the HTTPS lookup to the validated IP while retaining the hostname for Host and TLS SNI/certificate checks. Redirects are not followed, TLS verification remains enabled, and requests have timeouts and response-size limits. IMAP/SMTP and monitoring targets may be private because operators can configure internal mail servers; these endpoints remain admin-only and use bounded network calls. Review firewall egress separately before production.

HTML mail is sanitized, strips scripts/handlers/unsafe URLs, and is rendered in a sandboxed iframe with a restrictive document CSP. Remote images are blocked until explicitly requested. CID references are scoped to the selected message. Attachment requests check mailbox/message ownership and IMAP part metadata, enforce size limits, stream bounded content, sanitize filenames, and set `Content-Disposition` and `nosniff`.

Prisma queries use structured parameters. Do not enable Prisma query logging in production because query parameters can contain sensitive values. Audit logs record safe IDs and action names for login, logout, 2FA, sessions, mailbox credentials, cPanel tokens, API keys, webhooks, and cPanel provisioning. Request logs omit query strings and bodies; logger redaction covers authorization, cookies, passwords, keys, tokens, and secrets. Restrict log access and retention. BullMQ jobs contain IDs only; workers load encrypted secrets from the database when needed.

Keep PostgreSQL and Redis on private interfaces/networks. Require Redis authentication when crossing hosts, block both services at the public firewall, use encrypted transport when leaving the host/private network, and back up PostgreSQL plus the separate encryption key. Use least-privilege service accounts and restrict backup access. Do not expose Mailpit outside local development.

## Dependency audit and incident response

Run `pnpm audit` before release. At the October 2026 review, Nodemailer was updated to its patched major release and the critical `shell-quote` finding was fixed by a same-major override. Remaining audit findings are development-tool transitive dependencies: high `deepmerge-ts` through Prisma config, high `braces` with no patched release, and moderate `postcss-selector-parser` through Tailwind. They are deferred pending upstream compatibility/fix; do not treat a zero production-dependency audit as a complete build-chain review. Python SDK uses `httpx`; run `pip-audit` against its resolved environment when available. Review advisories and lockfile changes without blind major upgrades.

The Python SDK's declared `httpx>=0.27,<1` requirement was checked with pip-audit and the resolver found no known vulnerabilities. Since the SDK does not commit a Python lockfile, audit the exact resolved production environment again before release.

For suspected exposure, stop affected integrations, preserve a restricted evidence copy, revoke affected API keys/tokens, rotate credentials using [secrets-runbook.md](secrets-runbook.md), invalidate sessions by revoking them, audit access and deliveries, and notify affected operators through the incident process. Do not print or paste exposed values during investigation.

## Readiness checklist

The boxes below are deployment gates, not claims about a VPS:

- [ ] Production environment validated on the target host with `pnpm security:check`
- [ ] Encryption key backed up and restore tested
- [ ] Every active SUPER_ADMIN enrolled in 2FA and recovery codes stored securely
- [ ] HTTPS reverse proxy and secure cookies verified in production
- [ ] Production CORS origins and CSRF origin check verified
- [ ] Security headers and partial CSP verified through the public domain
- [ ] Rate limits verified behind the production reverse proxy
- [ ] Redis and PostgreSQL confirmed private and backed up
- [ ] Exposed tracked API key revoked and repository/history exposure assessed
- [ ] Remaining development dependency advisories reviewed and accepted/remediated
- [x] Local Prisma migration status clean after the additive security migration
- [x] Local non-destructive secret decryption check passed
- [ ] Production backup and incident-response drills completed
