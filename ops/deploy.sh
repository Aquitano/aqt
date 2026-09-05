#!/usr/bin/env sh
set -eu

app=${1:?usage: ops/deploy.sh <app>}
host=${AQT_VPS_HOST:?set AQT_VPS_HOST}
root=${AQT_VPS_ROOT:-/opt/aqt}

ssh "$host" "cd '$root' && git pull --ff-only && cd 'apps/$app' && docker compose up -d --build"
