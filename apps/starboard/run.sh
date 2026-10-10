#!/bin/sh

set -eu

usage() {
    cat <<'EOF'
Usage: ./run.sh [--run | --install]

Build Starboard in Debug configuration.
  --run      launch the freshly built Debug app
  --install  build Release, replace /Applications/Starboard.app and launch it
EOF
}

mode=build

case "${1:-}" in
    "") ;;
    --run) mode=run ;;
    --install) mode=install ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        echo "error: unknown option: $1" >&2
        usage >&2
        exit 2
        ;;
esac

if [ "$#" -gt 1 ]; then
    echo "error: expected at most one option" >&2
    usage >&2
    exit 2
fi

if ! xcodebuild -version >/dev/null 2>&1; then
    echo "error: Xcode is required; select it with: sudo xcode-select -s /Applications/Xcode.app" >&2
    exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
    echo "error: XcodeGen is required (mise install, from the repo root)" >&2
    exit 1
fi

configuration=Debug
if [ "$mode" = install ]; then
    configuration=Release
fi

# Use the filesystem's canonical path spelling. A differently-cased logical PWD
# (for example, /code instead of /Code) makes Xcode treat cached outputs as
# outside the build sandbox's allowed roots on case-insensitive filesystems.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && /bin/pwd -P)
derived_data="$script_dir/DerivedData"
app="$derived_data/Build/Products/$configuration/Starboard.app"
installed=/Applications/Starboard.app

echo "Generating Starboard.xcodeproj..."
(cd "$script_dir" && xcodegen generate --quiet)

echo "Building Starboard ($configuration)..."
xcodebuild \
    -project "$script_dir/Starboard.xcodeproj" \
    -scheme Starboard \
    -configuration "$configuration" \
    -destination 'platform=macOS' \
    -derivedDataPath "$derived_data" \
    -allowProvisioningUpdates \
    -quiet \
    build

if [ ! -d "$app" ]; then
    echo "error: build succeeded but the app was not found at $app" >&2
    exit 1
fi

echo "Built $app"

quit_running() {
    pgrep -x Starboard >/dev/null 2>&1 || return 0
    echo "Stopping the running Starboard..."
    /usr/bin/osascript -e 'tell application id "com.aquitano.starboard" to quit' >/dev/null 2>&1 || true

    attempts=0
    while pgrep -x Starboard >/dev/null 2>&1 && [ "$attempts" -lt 50 ]; do
        sleep 0.1
        attempts=$((attempts + 1))
    done

    if pgrep -x Starboard >/dev/null 2>&1; then
        echo "error: the running Starboard did not quit; quit it manually and retry" >&2
        exit 1
    fi
}

wait_for_launch() {
    attempts=0
    while ! pgrep -f -x "$1/Contents/MacOS/Starboard" >/dev/null 2>&1 && [ "$attempts" -lt 50 ]; do
        sleep 0.1
        attempts=$((attempts + 1))
    done

    if ! pgrep -f -x "$1/Contents/MacOS/Starboard" >/dev/null 2>&1; then
        echo "error: Starboard did not stay running after launch" >&2
        exit 1
    fi
    echo "Starboard is running from $1."
}

case "$mode" in
    run)
        quit_running
        # Several builds share the bundle identifier. Without -n, Launch
        # Services may reuse another registered Starboard.app instead of the
        # one built above.
        /usr/bin/open -n "$app"
        wait_for_launch "$app"
        ;;
    install)
        quit_running
        rm -rf "$installed"
        ditto "$app" "$installed"
        codesign --verify --strict "$installed"
        /usr/bin/open "$installed"
        wait_for_launch "$installed"
        ;;
esac
