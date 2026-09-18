#!/usr/bin/env sh
# The first ssh hop to the VPS, on its own, before a script depends on it.
# Tailscale SSH check mode holds the connection until a login URL is visited
# and delivers that URL as an ssh banner, which a piped shell or an agent only
# shows once the command ends: to a human that looks like a silent hang. So the
# hop runs in the background while its stderr is watched; the URL is printed
# and opened in the browser the moment it appears, and the hop then gets
# AQT_VPS_AUTH_WAIT seconds (default 300) for the check to be passed.
set -eu

host=${1:?usage: ops/vps.sh <host>}
wait=${AQT_VPS_AUTH_WAIT:-300}

log=$(mktemp)
trap 'rm -f "$log"' EXIT INT TERM HUP

ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" true 2>"$log" &
pid=$!

prompted=
elapsed=0
while kill -0 "$pid" 2>/dev/null; do
  if [ -z "$prompted" ]; then
    url=$(sed -n 's/^# To authenticate, visit: //p' "$log")
    if [ -n "$url" ]; then
      prompted=1
      echo "tailscale ssh wants you to re-authenticate before $host lets this in:" >&2
      echo "  $url" >&2
      if command -v open >/dev/null 2>&1; then
        open "$url" 2>/dev/null && echo "opened it in your browser" >&2
      fi
      echo "waiting up to ${wait}s for that" >&2
    fi
  fi
  if [ "$elapsed" -ge "$wait" ]; then
    kill "$pid" 2>/dev/null || true
    echo "gave up after ${wait}s; run 'mise run vps:auth' and retry" >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

wait "$pid" || {
  grep -v '^#' "$log" >&2 || true
  echo "cannot reach $host" >&2
  exit 1
}
