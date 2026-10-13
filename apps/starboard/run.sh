#!/bin/sh
set -eu
app_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && /bin/pwd -P)
exec "$app_dir/../../tools/macos-app.sh" "$app_dir" Starboard com.aquitano.starboard "$@"
