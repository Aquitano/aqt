#!/bin/sh

set -eu

usage() {
    cat <<'EOF'
Usage: ./run.sh [--run]

Build Notch in Debug configuration. Pass --run to launch the freshly built app.
EOF
}

launch_app=false

case "${1:-}" in
    "") ;;
    --run) launch_app=true ;;
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

developer_dir=/Applications/Xcode.app/Contents/Developer

if [ ! -d "$developer_dir" ]; then
    echo "error: Xcode is required at $developer_dir" >&2
    exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
    echo "error: XcodeGen is required (install it with: brew install xcodegen)" >&2
    exit 1
fi

# Use the filesystem's canonical path spelling. A differently-cased logical PWD
# (for example, /code instead of /Code) makes Xcode treat cached outputs as
# outside the build sandbox's allowed roots on case-insensitive filesystems.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && /bin/pwd -P)
derived_data="$script_dir/DerivedData"
app="$derived_data/Build/Products/Debug/Notch.app"

echo "Generating Notch.xcodeproj..."
(cd "$script_dir" && xcodegen generate)

echo "Building Notch (Debug)..."
DEVELOPER_DIR="$developer_dir" xcodebuild \
    -project "$script_dir/Notch.xcodeproj" \
    -scheme Notch \
    -configuration Debug \
    -destination 'platform=macOS' \
    -derivedDataPath "$derived_data" \
    -quiet \
    build

if [ ! -d "$app" ]; then
    echo "error: build succeeded but the app was not found at $app" >&2
    exit 1
fi

echo "Built $app"

if [ "$launch_app" = true ]; then
    if pgrep -x Notch >/dev/null 2>&1; then
        echo "Stopping the currently running Notch instance..."
        /usr/bin/osascript -e 'tell application id "com.aquitano.notch" to quit' >/dev/null 2>&1 || true

        attempts=0
        while pgrep -x Notch >/dev/null 2>&1 && [ "$attempts" -lt 50 ]; do
            sleep 0.1
            attempts=$((attempts + 1))
        done

        if pgrep -x Notch >/dev/null 2>&1; then
            echo "error: the existing Notch instance did not quit; quit it manually and retry" >&2
            exit 1
        fi
    fi

    echo "Starting Notch..."
    # Multiple local builds share the same bundle identifier. Without -n,
    # Launch Services may reuse a previously registered (and differently
    # signed) Notch.app instead of launching the app built above.
    /usr/bin/open -n "$app"

    attempts=0
    while ! pgrep -x Notch >/dev/null 2>&1 && [ "$attempts" -lt 50 ]; do
        sleep 0.1
        attempts=$((attempts + 1))
    done

    if ! pgrep -x Notch >/dev/null 2>&1; then
        echo "error: Notch did not remain running after launch" >&2
        exit 1
    fi

    echo "Notch is running."
fi
