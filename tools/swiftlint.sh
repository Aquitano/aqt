#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
    echo "Usage: swiftlint.sh SOURCE_DIRECTORY [SWIFTLINT_OPTIONS...]" >&2
    exit 2
fi
scope=$(CDPATH= cd -- "$1" && /bin/pwd -P)
shift
temporary=$(mktemp -d)
files="$temporary/inputs.xcfilelist"
trap 'rm -rf "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
# Explicit inputs keep root-config includes from expanding an app-scoped check.
find "$scope" \( -type d \( -name build -o -name DerivedData -o -name .build -o -name '*.xcodeproj' \) -prune \) \
    -o \( -type f -name '*.swift' -print \) > "$files"
SCRIPT_INPUT_FILE_LIST_COUNT=1 SCRIPT_INPUT_FILE_LIST_0="$files" \
    swiftlint lint --strict --quiet --force-exclude --use-script-input-file-lists "$@"
