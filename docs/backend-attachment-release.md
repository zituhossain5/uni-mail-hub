# Separate attachment backend release

The API, worker, and ops images can use `BACKEND_VERSION` in `.env.production`. The production web image and its `APP_VERSION` remain controlled by `APP_VERSION`. Omitting `BACKEND_VERSION` retains the original single-version behavior. Both production Compose files are required on this host.

The production Dockerfile builds the backend separately from Next.js. `Dockerfile.ops-release` can reuse retained operations tooling with the new API image’s generated database client and the release migration files; its build verifies that the Prisma client and migration CLI versions match. Building the `api`, `worker`, or `ops` targets does not build or publish the web application.

Current live backend: `attachments-20261024-4e62adaf144c`. Production web remains `lavender-20261023-ef1fce427b87`. Migration `20261023_outgoing_attachments` is applied, and all 22 migrations are verified.

## Release procedure

Build immutable API, worker, and ops images from a reviewed source snapshot. Run `pnpm test:compose` and the isolated integration check before changing production. The isolated stack uses a temporary database, Redis, and the local SMTP capture in `scripts/production/attachment-smtp-capture.mjs`; it publishes no ports and has no production network or credentials. Run `scripts/production/attachment-smoke.mjs` in that stack's ops container. The script refuses production URLs and verifies login, a request larger than 2 MiB, stored file bytes, the durable queue, SMTP MIME content and CID image linkage, idempotency, and legacy compose compatibility.

Create and verify a database backup. Retain the old image tags and a private copy of the previous environment configuration. Set `BACKEND_VERSION` to the tested image tag, then validate the resolved Compose configuration without printing secrets. Check that the web image still resolves to the retained production tag.

Run the new ops pre-migration check, then Prisma `migrate deploy`. Migration `20261023_outgoing_attachments` only adds the attachment table, indexes, and constraints; the previous API and worker remain compatible with this additive schema.

Replace the worker first so attachments can be processed before the API advertises support:

```sh
docker compose --env-file .env.production -f docker-compose.prod.yml -f docker-compose.traefik.yml up -d --no-build --no-deps worker
# Wait for worker health before replacing the API.
docker compose --env-file .env.production -f docker-compose.prod.yml -f docker-compose.traefik.yml up -d --no-build --no-deps api
```

Run the new ops production check and smoke check. Verify authenticated capabilities through the dev server, and confirm that Compose offers **Send message** with local images and attached files. Live validation can submit a large request with a nonexistent sender to verify the parser and relay reject unauthorized senders without queuing mail. Do not send a live test to an unspecified recipient.

Compare the production web container ID, image ID, and start time with their values before the rollout; they must be identical. The new inbox and composer design continue to run only on the separate dev server.

## Rollback

Withdraw attachment support by restoring the previous API first. Keep the new worker running until no queued, processing, or retrying messages have attachment rows: the old worker does not load files. Then set `BACKEND_VERSION` to the retained previous tag and recreate the worker with `--no-build --no-deps`. If the new worker cannot safely drain those messages, pause sending and retain it for repair rather than allowing the old worker to send those messages without files. Keep the additive attachment table and stored files. A database restore or table drop is unnecessary for application rollback. Keep the new ops image available for checking the migration ledger. When releasing the new web design later, deliberately update the web `APP_VERSION` and either update or remove the backend pin as appropriate; changing `APP_VERSION` alone does not change a pinned backend.
