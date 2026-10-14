# Production deployment preparation

This repository contains two Docker Compose deployment modes for a Linux VPS: standalone Nginx and an override for an existing Traefik proxy. No VPS, DNS, firewall, certificate authority, or production database operation is performed by this module.

## Architecture

In standalone mode, `reverse-proxy` publishes 80/443 and terminates TLS. In Traefik mode, the existing shared proxy owns those ports and built-in Nginx is disabled. Both modes send browser traffic and administrator `/api/v1/*` calls to Next.js, whose existing relay holds the HttpOnly session cookie and calls NestJS on `http://uni-mail-hub-api:4000`. Only `/api/v1/health` and API-key-protected `/api/v1/messages` and its subpaths reach NestJS directly. The worker owns the existing BullMQ processors and retention scheduler. PostgreSQL and Redis have no published ports and are attached only to the internal `back` network. The worker has a separate outbound network for SMTP, IMAP, webhooks, DNS, and cPanel. Web uses `front` to reach API; API joins `front` and the private data network. The `ops` image is one-shot and contains Prisma and PostgreSQL client tools; these are absent from the long-running API and worker images.

The production image build uses Node 24.13.0, pnpm 11.24.0 and the lockfile. Runtime API/worker images contain production dependencies, compiled code and the generated Prisma client. The web image uses Next.js standalone output. The Docker context excludes `.env*`, backup archives, private keys, local stores and generated build output. Use an immutable `APP_VERSION` (release or commit identifier), retain the prior tag for rollback, and pin reviewed image digests before an actual deployment.

## Host prerequisites

- Linux VPS with Docker Engine and the Compose plugin, an SSH account with restricted sudo, a domain/subdomain and control of its DNS.
- Standalone Nginx mode: a valid full chain and private key for the chosen application hostname. Put `fullchain.pem` and `privkey.pem` in `TLS_CERT_DIR`; these names are required by Nginx and the preflight. The port 80 listener redirects to HTTPS; it does not implement an ACME challenge. Existing Traefik mode instead uses its configured Let's Encrypt resolver and needs no local certificate mount.
- Enough disk for PostgreSQL, Redis AOF, at least two backup archives, Docker images and logs. Start with roughly 2 vCPU/4 GiB RAM and size from Module 14 load measurements; do not increase concurrency without measuring. Reserve space for a restore test and offsite encrypted copies.
- Backups on restricted storage outside the repository. Example: `/var/backups/uni-mail-hub`, owned by the container's UID 1000 and mode `0700`. Module 13 writes archives and sidecars mode `0600`. Do not mount them into Nginx or make them web-accessible.

Keep `/opt/uni-mail-hub` and the populated `.env.production` restricted. A practical host layout is `/opt/uni-mail-hub/{docker-compose.prod.yml,Dockerfile.production,deploy/,scripts/,.env.production}` with the repository packages and apps required for image builds. Docker data lives in named volumes `postgres_data` and `redis_data`; backups live in `BACKUP_HOST_DIR`. Do not use mode `0777` to fix ownership.

## Environment and secrets

Copy `.env.production.example` to `.env.production`, set mode `0600`, and replace every placeholder. Do not commit or paste the populated file. Set `APP_VERSION` to a unique immutable release or commit tag. Generate `JWT_SECRET` with at least 48 random characters and `MAIL_CREDENTIAL_ENCRYPTION_KEY` as Base64 of 32 random bytes. Store the encryption key separately with its own recovery process; losing it makes mailbox, cPanel and webhook secrets unreadable. URL-encode the PostgreSQL password in `DATABASE_URL` and use the same raw value in `POSTGRES_PASSWORD`. `production:check` checks this match without printing either value. Back up the env and encryption key separately in a protected secret store. Remove the obsolete `PRODUCTION_2FA_BOOTSTRAP` setting from existing production env files during this upgrade.

Set `WEB_URL`, `UNI_MAIL_HUB_PUBLIC_URL` and `ALLOWED_ORIGINS` to the exact HTTPS application origin, with no trailing path. `API_URL=http://uni-mail-hub-api:4000` is the recommended internal Compose target; production config rejects arbitrary private cleartext API targets. The session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, and host-only. Direct administrator login over raw HTTP is unsupported. CORS permits the configured HTTPS origin only; do not use a wildcard. `API_BIND_HOST=0.0.0.0` applies only inside the API container, whose port is not published.

`POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, `BACKUP_HOST_DIR`, and `APP_VERSION` are read by Compose. `TLS_CERT_DIR` is required only for standalone Nginx; set `EXTERNAL_TLS_TERMINATION=false` there. Use absolute Linux paths for host directories. `BACKUP_DIR=/backups` and `BACKUP_PG_MODE=native` are required inside `ops`. The example concurrency remains SMTP 5, IMAP 3, and one worker each for cPanel, monitoring and webhook delivery. `MONITORING_INTERVAL_MINUTES=10`; one worker process owns daily retention at 03:00 UTC when `RETENTION_ENABLED=true`. A Redis lease prevents duplicate retention execution, but deploy one worker replica unless scaling has been separately tested.

## Existing Traefik

Use [docker-compose.traefik.yml](../docker-compose.traefik.yml) only when the VPS already has Traefik v3.6.x with the Docker provider, `exposedByDefault=false`, external network `app_plane`, entrypoints `web` and `websecure`, and certificate resolver `letsencrypt`. The target hostname is `mailhub.unicodeit.com`. Set `WEB_URL`, `UNI_MAIL_HUB_PUBLIC_URL`, and `ALLOWED_ORIGINS` to `https://mailhub.unicodeit.com`; set `EXTERNAL_TLS_TERMINATION=true`. `TLS_CERT_DIR` may be omitted. Traefik handles Let's Encrypt through its existing HTTP challenge on `web`; Certbot is not used in this mode. Confirm the external network and Traefik configuration on the host before deployment; this repository does not create or modify them. Docker Compose v2.24.4 or newer is required for the override's `!override` mount replacement.

Use both files for **every** Traefik-mode operation:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.prod.yml \
  -f docker-compose.traefik.yml config
```

The override disables built-in Nginx, attaches only web and API to `app_plane`, and keeps their `front`/`back` networks. It publishes neither application port. HTTPS `/api/v1/health`, exact `/api/v1/messages`, and `/api/v1/messages/*` go directly to API port 4000 at higher priority than the web router. All other paths, including administrator API routes, go through Next.js port 3000. The HTTP router redirects permanently to HTTPS. Traefik labels explicitly opt in only web and API; PostgreSQL, Redis, worker, and ops remain undiscovered.

For fresh install use `bash scripts/deploy-production.sh --fresh --traefik`; for updates use `bash scripts/deploy-production.sh --update --traefik`. The scripts use the same migration, backup, health and smoke gates as standalone mode and do not start built-in Nginx. For application rollback, use `bash scripts/rollback-production.sh --acknowledge-schema-compatibility --traefik` after confirming schema compatibility. Direct preflight and smoke commands are:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml -f docker-compose.traefik.yml run --rm ops node scripts/production/check.mjs
docker compose --env-file .env.production -f docker-compose.prod.yml -f docker-compose.traefik.yml run --rm ops node scripts/production/smoke.mjs
```

### Internal DNS on a shared ingress network

Docker DNS can return a different stack's container for a generic name such as `postgres` when API joins the shared `app_plane` network. A successful TCP connection to that container can then look like a database password failure. Use the network-scoped aliases below; they do not change credentials, databases, or migrations:

```text
DATABASE_URL=postgresql://unimail:<same-url-encoded-password>@uni-mail-hub-postgres:5432/unimailhub?schema=public
REDIS_URL=redis://uni-mail-hub-redis:6379
API_URL=http://uni-mail-hub-api:4000
```

`uni-mail-hub-postgres` and `uni-mail-hub-redis` exist only on private `back`; `uni-mail-hub-api` exists on `front`. Web and API retain their `app_plane` attachment solely for Traefik. The production preflight requires these aliases in Traefik mode. Existing standalone Nginx installs may keep `postgres`, `redis`, and `api` while transitioning, but new installations should use the unique aliases. For an existing installation, update only the three URL hostnames in `.env.production` and preserve the passwords and encryption key. During a planned maintenance window, recreate PostgreSQL and Redis so Docker assigns their new aliases, then recreate API, worker and web with both Compose files. Keep the existing named data volumes. Run preflight and smoke after restart; no schema migration is needed for the hostname change.

## Fresh install

1. Prepare the host, restricted directories, DNS, and standalone Nginx TLS files. Do not overwrite mail-host DNS such as `mail.unicodeit.com`; use a separate application name such as `mailhub.unicodeit.com` pointing at the VPS public address. For the existing Traefik proxy, follow the mode above instead of preparing local certificate files.
2. Copy the repository to the chosen directory and fill `.env.production`. Use a new, strong `SEED_ADMIN_PASSWORD`; no password is shipped in the template. Keep `SEED_ADMIN_*` values private.
3. For standalone Nginx, run `bash scripts/deploy-production.sh --fresh` from the repository root. It checks Compose/config/certificate mounts, starts only PostgreSQL and Redis, validates the migration ledger, builds images, runs `prisma migrate deploy` once, creates the sole administrator, checks migration status, starts the four serving services, waits for health, and runs read-only HTTPS/API/heartbeat smoke checks. The fresh seed refuses a database containing any user; it does not create test projects, mail servers, messages, or API keys. For Traefik, use `--fresh --traefik` as described above.
4. Sign in through HTTPS with the seeded admin credentials. In Settings, change the initial administrator password using the current password and a new unique password of at least 16 characters. Other sessions are revoked. Do this immediately after first sign-in.
5. Remove the `SEED_ADMIN_*` values from `.env.production`, then run `docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-build api web worker`. Run `pnpm production:check` and `pnpm production:smoke` from the repository with Docker available. In Traefik mode, add `-f docker-compose.traefik.yml` to the Compose command and use the two-file preflight/smoke commands above. Normal production API startup requires at least one active Super Admin. The seed command must never be used as a password reset on an existing production DB.

## Updates, migration and rollback

For an update, set a new immutable `APP_VERSION`, retain the previous images and verified backup, and run `bash scripts/deploy-production.sh --update` during a maintenance window. The script checks the existing ledger, creates and verifies a Module 13 backup, builds the new images, then stops web, API, and worker before applying migrations. It runs `prisma migrate deploy` exactly once, checks administrator presence and migration status, starts the new services, waits for health and performs read-only smoke checks. Any backup, checksum, migration, health or smoke failure stops the script. It never runs `migrate dev`, `migrate reset`, or an automatic database restore. Review migration SQL for compatibility before deployment; an application rollback may not be compatible with a newer schema. The `20261014_remove_two_factor` migration drops the retired `UserSecurity` and `RecoveryCode` tables, including stored enrollment data. Take and verify the pre-migration backup before applying it. Older API images that query those tables are not schema-compatible and must not be rolled back over this migration; restoring an older database requires the separate restore procedure.

To roll back application images, first confirm the prior version supports the current schema, set `APP_VERSION` in `.env.production` to that retained tag, then run `bash scripts/rollback-production.sh --acknowledge-schema-compatibility`. It verifies the images, switches API, worker and web, waits for health and smokes the result. It does **not** reverse Prisma migrations. If a database restore is required, stop affected services and follow [backup-restore.md](backup-restore.md) and [disaster-recovery.md](disaster-recovery.md); that is a separate, explicit operation. Keep the original encryption key and follow [secrets-runbook.md](secrets-runbook.md) for key loss/rotation.

## Backups and operations

`pnpm production:check` runs the standalone one-shot `ops` container and verifies production env/secret formats, private DB/Redis endpoint consistency, mounted backup and TLS paths, DB/Redis connectivity, migration checksums/status, active administrator presence, and decryptability of stored encrypted credentials without printing plaintext. In Traefik mode use the two-file command above; with `EXTERNAL_TLS_TERMINATION=true`, it reports external TLS termination instead of checking local certificate files. All other checks remain active. `pnpm production:smoke` performs a read-only HTTPS login-page check, internal API dependency health check and Redis worker heartbeat check; use the two-file form in Traefik mode. It sends no email and does not authenticate. Use `docker compose --env-file .env.production -f docker-compose.prod.yml run --rm ops node scripts/ops/backup.mjs` for a verified standalone backup, or add the override file for Traefik. On an isolated **nonproduction** copy only, override `NODE_ENV=test` and use `scripts/ops/restore-test.mjs --backup /backups/<archive>` to restore into a temporary database and verify integrity. The restore-test script rejects production mode. Schedule daily backup on the host using the approved scheduler and copy verified archives to encrypted off-host storage. Keep backup and Docker log rotation under observation; Compose json-file logs are capped at 10 MiB × 5 per service.

See [operations.md](operations.md) for commands, logs and incident steps.

## Host access and integration

Review the firewall before exposing the host: normally public TCP 80/443 and restricted SSH 22 only. Do not publish 5432, 6379, 3000 or 4000. Prefer SSH keys, a restricted sudo account and no direct root/password login where operationally appropriate. These are future host instructions; this repository changes no firewall or SSH settings.

Other projects, including Bunevia, should use `UNI_MAIL_HUB_URL=https://<application-host>`, `UNI_MAIL_HUB_API_KEY`, and `UNI_MAIL_HUB_MAILBOX_ID`; they do not need SMTP credentials. A host process or a container in a separate Compose project can use the public HTTPS endpoint. `127.0.0.1` inside another container means that container itself. A deliberately shared private Docker network could use an internal API URL, but must be configured explicitly and kept private; standalone mode does not join another project's network, while Traefik mode joins only its shared proxy network. A separate VPS uses public HTTPS. The public proxy routes the API-key-protected `/api/v1/messages` endpoints directly to NestJS and leaves browser administrator calls through the cookie relay.

## Go-live checklist

- [ ] Application domain selected; DNS points to intended VPS without changing existing mail DNS
- [ ] TLS mode selected: standalone certificate/key installed and renewal tested, or existing Traefik resolver/HTTP challenge verified
- [ ] `.env.production` populated with independent strong secrets, mode `0600`
- [ ] Encryption key backed up separately
- [ ] Admin password strong and changed after first sign-in; other sessions revoked
- [ ] PostgreSQL, Redis and internal API ports remain unpublished
- [ ] Firewall/SSH baseline reviewed
- [ ] Production preflight and smoke pass using the Compose files for the selected mode
- [ ] Prisma migrations clean; verified backup exists; isolated restore test passed
- [ ] Backup schedule and encrypted offsite copy configured
- [ ] Worker heartbeat, queue health, retention schedule and disk/log usage checked
- [ ] Prior immutable image tag retained with schema-compatible rollback plan
- [ ] Resolve or explicitly review the high-severity `deepmerge-ts <8` advisory in Prisma's dependency chain before go-live; rerun `pnpm audit --prod --audit-level high`
