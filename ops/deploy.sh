#!/usr/bin/env sh
set -eu

app=${1:?usage: ops/deploy.sh <app>}
case $app in
health | health/*)
  echo "Health is maintained at https://github.com/Aquitano/aqt-health" >&2
  exit 1
  ;;
esac

host=${AQT_VPS_HOST:?set AQT_VPS_HOST}
root=${AQT_VPS_ROOT:?set AQT_VPS_ROOT}

test -d "apps/$app" || { echo "no such app: $app" >&2; exit 1; }

"$(dirname -- "$0")/vps.sh" "$host"

# An app whose data lives on the LUKS volume must not start while it is locked:
# its bind paths would be created on the root disk and Postgres would initdb an
# empty, unencrypted cluster there, which clients would then flush into.
ssh "$host" "cd '$root' && git pull --ff-only && cd 'apps/$app' && test -f .env && \
  { ! grep -q '=/data/' .env || mountpoint -q /data || { echo '/data is not mounted: run data-unlock first' >&2; exit 1; }; } && \
  GIT_SHA=\$(git rev-parse --short HEAD) docker compose up -d --build --wait --wait-timeout 180"
