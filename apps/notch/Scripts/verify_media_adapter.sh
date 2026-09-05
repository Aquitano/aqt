#!/bin/sh
set -eu

fail() {
    echo "error: media adapter verification failed: $*" >&2
    exit 1
}

app="${TARGET_BUILD_DIR}/${WRAPPER_NAME}"
script="${app}/Contents/Resources/mediaremote-adapter.pl"
framework="${app}/Contents/Frameworks/MediaRemoteAdapter.framework"
binary="${framework}/Versions/A/MediaRemoteAdapter"
expected_script_sha="30a7508f76394120993b333eed425c70b7b090a7a0b9fc5b420212422dd9b1a7"

[ -f "$script" ] || fail "bridge script is missing from app resources"
[ -x "$binary" ] || fail "framework executable is missing"

actual_script_sha=$(/usr/bin/shasum -a 256 "$script" | /usr/bin/awk '{print $1}')
[ "$actual_script_sha" = "$expected_script_sha" ] || fail "bridge script checksum changed"

for symbol in bootstrap loop get toggle_play_pause next_track previous_track set_time_from_env toggle_shuffle toggle_repeat; do
    /usr/bin/nm -gU "$binary" | /usr/bin/grep -q " _${symbol}$" \
        || fail "framework does not export ${symbol}"
done

# Debug builds put app code in PRODUCT_NAME.debug.dylib; Release puts it in the
# main executable. Neither may link the adapter—the Perl host must dlopen it.
for candidate in "${app}/Contents/MacOS/${EXECUTABLE_NAME}" "${app}/Contents/MacOS/${PRODUCT_NAME}.debug.dylib"; do
    [ -f "$candidate" ] || continue
    if /usr/bin/otool -L "$candidate" | /usr/bin/grep -q 'MediaRemoteAdapter.framework'; then
        fail "$(basename "$candidate") links MediaRemoteAdapter.framework"
    fi
done

# Xcode's Embed Frameworks phase applies CodeSignOnCopy before this verifier.
# Verify that signature when present, while allowing CODE_SIGNING_ALLOWED=NO CI.
if [ "${CODE_SIGNING_ALLOWED:-YES}" != "NO" ] && /usr/bin/codesign -dv "$framework" >/dev/null 2>&1; then
    /usr/bin/codesign --verify --strict "$framework" \
        || fail "embedded framework signature is invalid"
fi

echo "media adapter verified: pinned script, ABI, embedding, and non-linkage"
