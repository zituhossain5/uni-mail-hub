#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "${1:-}" != --acknowledge-schema-compatibility || "$#" -ne 1 ]]; then
  echo 'Set APP_VERSION in .env.production to the retained prior image tag, confirm that version supports the current schema, then run scripts/rollback-production.sh --acknowledge-schema-compatibility.' >&2
  exit 2
fi
[[ -f .env.production ]] || { echo 'Missing .env.production' >&2; exit 1; }
version="$(sed -n 's/^APP_VERSION=//p' .env.production | tail -n 1)"
[[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$ ]] || { echo 'Invalid APP_VERSION' >&2; exit 1; }
for service in api worker web; do
  docker image inspect "uni-mail-hub-${service}:${version}" >/dev/null || { echo "Retained image missing: $service" >&2; exit 1; }
done
dc() { docker compose --env-file .env.production -f docker-compose.prod.yml "$@"; }
dc config -q
for service in api worker web reverse-proxy; do
  dc up -d --no-build --no-deps "$service"
  container="$(dc ps -q "$service")"
  [[ -n "$container" ]] || exit 1
  healthy=false
  for _ in {1..36}; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    if [[ "$status" == healthy ]]; then healthy=true; break; fi
    [[ "$status" == exited || "$status" == dead || "$status" == unhealthy ]] && break
    sleep 5
  done
  [[ "$healthy" == true ]] || { echo "Rollback health check failed: $service" >&2; exit 1; }
done
dc run --rm ops node scripts/production/smoke.mjs
echo "Application images rolled back to ${version}. Database schema was not changed."
