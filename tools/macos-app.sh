#!/bin/sh
set -eu

if [ "$#" -lt 3 ]; then
    echo "Usage: macos-app.sh APP_DIR APP_NAME BUNDLE_ID [--run | --install | --copy-user]" >&2
    exit 2
fi
app_dir=$(CDPATH= cd -- "$1" && /bin/pwd -P)
app_name=$2
bundle_id=$3
shift 3
mode=${1:-build}
if [ "$#" -gt 1 ]; then
    echo "error: expected at most one option" >&2
    exit 2
fi
case "$mode" in
    build|--run|--install|--copy-user) ;;
    -h|--help)
        echo "Usage: run.sh [--run | --install]"
        echo "Build Debug; --run also launches it; --install copies Release to /Applications and launches it."
        exit 0
        ;;
    *) echo "error: unknown option: $mode" >&2; exit 2 ;;
esac

configuration=Debug
if [ "$mode" = --install ]; then configuration=Release; fi
derived_data="$app_dir/DerivedData"
app="$derived_data/Build/Products/$configuration/$app_name.app"
# The LaunchAgent task builds before stopping the service, then copies that
# verified build with --copy-user. A compiler failure leaves the service alone.
if [ "$mode" != --copy-user ]; then
    DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
    export DEVELOPER_DIR
    if ! xcodebuild -version >/dev/null 2>&1; then
        echo "error: Xcode is required at $DEVELOPER_DIR" >&2
        exit 1
    fi
    if ! command -v xcodegen >/dev/null 2>&1; then
        echo "error: install XcodeGen with mise install" >&2
        exit 1
    fi
    (cd "$app_dir" && xcodegen generate --quiet)
    xcodebuild -project "$app_dir/$app_name.xcodeproj" -scheme "$app_name" \
        -configuration "$configuration" -destination 'platform=macOS' \
        -derivedDataPath "$derived_data" -allowProvisioningUpdates -quiet build
fi
if [ ! -d "$app" ]; then
    echo "error: $app was not created" >&2
    exit 1
fi
codesign --verify --deep --strict "$app"
if [ "$mode" = build ]; then
    echo "Built $app"
    exit 0
fi

if pgrep -x "$app_name" >/dev/null 2>&1; then
    osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null 2>&1 || true
    attempts=0
    while pgrep -x "$app_name" >/dev/null 2>&1 && [ "$attempts" -lt 50 ]; do
        sleep 0.1
        attempts=$((attempts + 1))
    done
    if pgrep -x "$app_name" >/dev/null 2>&1; then
        echo "error: quit the running $app_name and retry" >&2
        exit 1
    fi
fi

case "$mode" in
    --install|--copy-user)
        install_dir=/Applications
        if [ "$mode" = --copy-user ]; then install_dir="$HOME/Applications"; fi
        mkdir -p "$install_dir"
        install_target="$install_dir/$app_name.app"
        staging=$(mktemp -d "$install_dir/.$app_name.XXXXXX")
        trap 'rm -rf "$staging"' EXIT
        trap 'exit 1' HUP INT TERM
        ditto "$app" "$staging/$app_name.app"
        # The previous app stays until its replacement is copied and verified.
        codesign --verify --deep --strict "$staging/$app_name.app"
        # Two renames swap the apps without touching the old bundle's contents, and a signal
        # cannot land between them. The EXIT trap then deletes the previous app with the staging.
        trap '' HUP INT TERM
        if [ -e "$install_target" ] || [ -L "$install_target" ]; then
            mv "$install_target" "$staging/previous.app"
        fi
        mv "$staging/$app_name.app" "$install_target"
        trap 'exit 1' HUP INT TERM
        app="$install_target"
        # The tracker LaunchAgent owns startup after installing this copy.
        if [ "$mode" = --copy-user ]; then exit 0; fi
        ;;
esac

# Launch Services may otherwise reuse a different build with the same bundle ID.
open -n "$app"
is_running() {
    ps -axww -o comm= | awk -v expected="$app/Contents/MacOS/$app_name" \
        '$0 == expected { found = 1 } END { exit !found }'
}
attempts=0
while ! is_running && [ "$attempts" -lt 50 ]; do
    sleep 0.1
    attempts=$((attempts + 1))
done
if ! is_running; then
    echo "error: $app_name did not stay running from $app" >&2
    exit 1
fi
echo "$app_name is running from $app."
