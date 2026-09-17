#!/usr/bin/env sh
set -eu

app=${1:?usage: ops/deploy.sh <app>}
host=${AQT_VPS_HOST:?set AQT_VPS_HOST}
root=${AQT_VPS_ROOT:?set AQT_VPS_ROOT}

test -d "apps/$app" || { echo "no such app: $app" >&2; exit 1; }

ssh "$host" "cd '$root' && git pull --ff-only && cd 'apps/$app' && test -f .env && GIT_SHA=\$(git rev-parse --short HEAD) docker compose up -d --build --wait --wait-timeout 180"
