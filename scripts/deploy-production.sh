#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mode="${1:-}"
proxy_mode="${2:-}"
if { [[ "$mode" != --fresh && "$mode" != --update ]]; } || { [[ -n "$proxy_mode" && "$proxy_mode" != --traefik ]]; } || [[ "$#" -gt 2 ]]; then
  echo 'Usage: scripts/deploy-production.sh --fresh|--update [--traefik]' >&2
  exit 2
fi
for tool in docker; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
docker compose version >/dev/null
[[ -f .env.production ]] || { echo 'Missing .env.production' >&2; exit 1; }
if [[ "$proxy_mode" != --traefik ]]; then
  [[ -f deploy/nginx/uni-mail-hub.conf ]] || { echo 'Missing proxy config' >&2; exit 1; }
fi
compose_files=(-f docker-compose.prod.yml)
services=(api worker web)
if [[ "$proxy_mode" == --traefik ]]; then
  compose_files+=(-f docker-compose.traefik.yml)
else
  services+=(reverse-proxy)
fi
dc() { docker compose --env-file .env.production "${compose_files[@]}" "$@"; }
wait_healthy() {
  local service="$1" container status
  container="$(dc ps -q "$service")"
  [[ -n "$container" ]] || { echo "Service missing: $service" >&2; return 1; }
  for _ in {1..36}; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    [[ "$status" == healthy ]] && { echo "Healthy: $service"; return 0; }
    [[ "$status" == exited || "$status" == dead || "$status" == unhealthy ]] && { echo "Service failed: $service ($status)" >&2; return 1; }
    sleep 5
  done
  echo "Health timeout: $service" >&2
  return 1
}

dc config -q
dc build ops
dc run --rm --no-deps ops node scripts/production/check.mjs --config-only
dc up -d postgres redis
wait_healthy postgres
wait_healthy redis
dc run --rm ops node scripts/production/check.mjs --pre-migrate

if [[ "$mode" == --update ]]; then
  dc run --rm ops node scripts/ops/backup.mjs
  echo 'Verified pre-migration backup created.'
fi

dc build api worker web
if [[ "$mode" == --update ]]; then
  # The retiring 2FA migration drops tables read by older API images.
  dc stop web api worker
fi
dc run --rm ops node node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma
if [[ "$mode" == --fresh ]]; then
  dc run --rm ops node node_modules/tsx/dist/cli.mjs packages/database/seed.ts
  dc run --rm ops node scripts/production/check.mjs
else
  dc run --rm ops node scripts/production/check.mjs
fi

dc up -d "${services[@]}"
for service in "${services[@]}"; do wait_healthy "$service"; done
dc run --rm ops node scripts/production/smoke.mjs
echo 'Deployment checks passed. Keep the previous image tag and verified backup for rollback.'
