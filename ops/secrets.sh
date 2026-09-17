#!/usr/bin/env sh
set -eu

usage() {
  echo "usage: ops/secrets.sh <pull|push|diff|send> <target> [env]" >&2
  echo "targets: bank health health-frontend gallery gallery-web img tracker" >&2
  exit 2
}

cmd=${1:-}
target=${2:-}
slug=${3:-dev}
[ -n "$cmd" ] && [ -n "$target" ] || usage

case $target in
bank) app=apps/bank rel=.env folder=/ ;;
health) app=apps/health rel=.env folder=/ ;;
health-frontend) app=apps/health rel=frontend/.env folder=/frontend ;;
gallery) app=apps/gallery rel=apps/server/.env folder=/ ;;
gallery-web) app=apps/gallery rel=apps/web/.env folder=/web ;;
img) app=apps/img rel=.env folder=/ ;;
tracker) app=apps/tracker rel=.env folder=/ ;;
*) usage ;;
esac

command -v infisical >/dev/null 2>&1 || {
  echo "infisical CLI not found: brew install infisical/get-cli/infisical" >&2
  exit 1
}

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root/$app"
test -f .infisical.json || {
  echo "$app/.infisical.json missing: run 'infisical init' in $app" >&2
  exit 1
}
# The CLI defaults to US cloud and `infisical init` writes no domain, so the
# region is defaulted here. A file that names one wins, which is how an app
# would ever point somewhere else.
grep -q '"domain"' .infisical.json ||
  export INFISICAL_DOMAIN=${INFISICAL_DOMAIN:-https://eu.infisical.com}
export INFISICAL_DISABLE_UPDATE_CHECK=true
disp=$app/$rel
dir=$(dirname "$rel")

# Scratch holds plaintext secrets, so it dies on a signal too, not just on exit.
# It sits beside the target: same filesystem means the replacing mv is atomic,
# and .env.* is already gitignored workspace-wide.
mkdir -p "$dir"
scratch=$(mktemp -d "$dir/.env.aqt.XXXXXX")
trap 'rm -rf "$scratch"' EXIT INT TERM HUP

fetch() {
  infisical export --env="$slug" --path="$folder" --format=dotenv
}

# Both sides go through this before they are compared: an exported value arrives
# quoted, a hand-written one usually does not, and comparing raw would report
# quoting and ordering as drift.
pairs() {
  sed 's/\r$//; s/^[[:space:]]*//' | while IFS= read -r line || [ -n "$line" ]; do
    line=${line#export }
    case $line in
    \#* | '') continue ;;
    *=*) ;;
    *) continue ;;
    esac
    key=${line%%=*}
    val=${line#*=}
    case $val in
    \'*\')
      inner=${val#\'}
      inner=${inner%\'}
      case $inner in *\'*) ;; *) val=$inner ;; esac
      ;;
    \"*\")
      inner=${val#\"}
      inner=${inner%\"}
      case $inner in *\"*) ;; *) val=$inner ;; esac
      ;;
    esac
    # Infisical stores no empty value, so an empty one is absence on both sides.
    case $val in '') continue ;; esac
    printf '%s=%s\n' "$key" "$val"
  done | sort
}

empty_keys() {
  awk '
    /^[[:space:]]*#/ || !/=/ { next }
    { k = $0; sub(/^[[:space:]]*(export[[:space:]]+)?/, "", k); v = k
      sub(/=.*/, "", k); sub(/^[^=]*=/, "", v)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      gsub(/^["'\'']|["'\'']$/, "", v)
      if (v == "") printf " %s", k }
  ' "$1"
}

drop_empty() {
  awk '
    /^[[:space:]]*#/ || !/=/ { print; next }
    { v = $0; sub(/^[^=]*=/, "", v)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      gsub(/^["'\'']|["'\'']$/, "", v)
      if (v != "") print }
  ' "$1"
}

# A value whose quotes do not close on its own line spans several lines, which
# this file's line-oriented comparison cannot represent.
multiline() {
  awk '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ || !/=/ { next }
    { k = $0; sub(/=.*/, "", k); v = $0; sub(/^[^=]*=/, "", v)
      if (gsub(/"/, "&", v) % 2 || gsub(/'\''/, "&", v) % 2) printf " %s", k }
  ' "$1"
}

# .env.example is the canonical list of keys an app needs, so a key it documents
# and the environment does not have is a boot failure waiting to happen. An
# example key left empty means the app runs without it, so it is not required.
undocumented() {
  test -f "$rel.example" || return 0
  pairs <"$rel.example" | sed 's/=.*//' | sort >"$scratch/want"
  sed 's/=.*//' "$1" | sort >"$scratch/have"
  comm -23 "$scratch/want" "$scratch/have" | tr '\n' ' '
}

# A .env this script did not write keeps whatever umask made it, and these hold
# live credentials. ls -l because stat's format flags differ on macOS and Linux.
check_mode() {
  case $(ls -l "$1" | cut -c5-10) in
  ------) ;;
  *) echo "warning: $disp is $(ls -l "$1" | cut -c1-10 | cut -c2-), readable beyond you; chmod 600 it" >&2 ;;
  esac
}

confirm() {
  [ "${AQT_SECRETS_YES:-}" != 1 ] || return 0
  printf '%s. continue? [y/N] ' "$1"
  if ! IFS= read -r reply; then
    echo "no answer on stdin; AQT_SECRETS_YES=1 skips the prompt" >&2
    exit 1
  fi
  case $reply in
  y | Y) return 0 ;;
  *)
    echo aborted >&2
    exit 1
    ;;
  esac
}

case $cmd in
pull)
  fetch >"$scratch/new"
  test -s "$scratch/new" || {
    echo "$target $slug:$folder returned nothing; refusing to empty $disp" >&2
    exit 1
  }
  chmod 600 "$scratch/new"
  pairs <"$scratch/new" >"$scratch/now"
  if [ ! -f "$rel" ]; then
    note=" (new)"
  else
    pairs <"$rel" >"$scratch/was"
    if cmp -s "$scratch/was" "$scratch/now"; then
      note=" (unchanged)"
    else
      note=" (values differed)"
    fi
  fi
  mv "$scratch/new" "$rel"
  echo "$disp <- $target $slug:$folder$note"
  gap=$(undocumented "$scratch/now")
  [ -z "$gap" ] || echo "warning: $rel.example documents keys $slug does not have: $gap" >&2
  ;;
push)
  test -f "$rel" || {
    echo "no such file: $disp" >&2
    exit 1
  }
  check_mode "$rel"
  pairs <"$rel" >"$scratch/local"
  count=$(wc -l <"$scratch/local")
  [ "$count" -gt 0 ] || {
    echo "$disp holds no secrets" >&2
    exit 1
  }
  spans=$(multiline "$rel")
  [ -z "$spans" ] || echo "note: multi-line values, which diff cannot verify:$spans" >&2
  empties=$(empty_keys "$rel")
  [ -z "$empties" ] || echo "note: an empty value is not a secret; these stay local:$empties" >&2
  [ -z "$empties" ] || [ -z "$spans" ] || {
    echo "cannot drop empty keys from a file with multi-line values; fix one by hand" >&2
    exit 1
  }
  confirm "$(printf '%s -> %s %s:%s, %d keys' "$disp" "$target" "$slug" "$folder" "$count")"
  src=$rel
  if [ -n "$empties" ]; then
    drop_empty "$rel" >"$scratch/upload"
    chmod 600 "$scratch/upload"
    src=$scratch/upload
  fi
  # --file, not KEY=VALUE arguments: argv is world-readable through /proc on the
  # VPS, and the CLI's own dotenv parser handles values this script cannot.
  infisical secrets set --env="$slug" --path="$folder" --file "$src"
  ;;
diff)
  test -f "$rel" || {
    echo "no such file: $disp" >&2
    exit 1
  }
  check_mode "$rel"
  fetch >"$scratch/raw"
  pairs <"$scratch/raw" >"$scratch/remote"
  pairs <"$rel" >"$scratch/local"
  spans=$(multiline "$rel")
  [ -z "$spans" ] || echo "note: multi-line values, reported as drift either way:$spans" >&2
  gap=$(undocumented "$scratch/remote")
  [ -z "$gap" ] || echo "warning: $rel.example documents keys $slug does not have: $gap" >&2
  diff -u --label "$target $slug:$folder" "$scratch/remote" --label "$disp" "$scratch/local"
  ;;
send)
  # Not ${AQT_VPS_HOST:?...}: bash 3.2 runs the EXIT trap on an expansion error
  # and the successful cleanup overwrites the failure status with 0.
  host=${AQT_VPS_HOST:-}
  vps=${AQT_VPS_ROOT:-}
  [ -n "$host" ] && [ -n "$vps" ] || {
    echo "set AQT_VPS_HOST and AQT_VPS_ROOT" >&2
    exit 1
  }
  fetch >"$scratch/new"
  test -s "$scratch/new" || {
    echo "$target $slug:$folder returned nothing; refusing to send it" >&2
    exit 1
  }
  pairs <"$scratch/new" >"$scratch/now"
  gap=$(undocumented "$scratch/now")
  [ -z "$gap" ] || echo "warning: $rel.example documents keys $slug does not have: $gap" >&2
  confirm "$(printf '%s %s:%s -> %s:%s/%s, %d keys' "$target" "$slug" "$folder" "$host" "$vps" "$disp" "$(wc -l <"$scratch/now")")"
  # Written beside the target and moved, so an interrupted transfer never leaves
  # the box with half a .env.
  ssh "$host" "umask 077 && cat > '$vps/$app/$rel.aqt' && mv '$vps/$app/$rel.aqt' '$vps/$app/$rel'" <"$scratch/new"
  echo "$host:$vps/$disp <- $target $slug:$folder"
  ;;
*) usage ;;
esac
