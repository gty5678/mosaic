#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Please run this script on macOS." >&2
    exit 1
fi
command -v uv >/dev/null 2>&1 || { echo "Install uv first." >&2; exit 1; }
cd "$(dirname "$0")"
ROOT="$PWD"
ARCH="$(uname -m)"
NAME="mosic-macos-$ARCH"
OUT="$ROOT/output/macos/$ARCH"
PACKAGE="$OUT/$NAME"
for EXT in chrome_capture firefox_capture; do
    if [[ ! -f "$ROOT/extensions/$EXT/manifest.json" ]]; then
        echo "Missing required extension: extensions/$EXT/manifest.json" >&2
        exit 1
    fi
done
mkdir -p "$PACKAGE"

# Separate paths so macOS builds never clean Windows output/build files.
uv run --locked --group dev pyinstaller --clean --noconfirm \
    --workpath "$ROOT/build/macos/$ARCH" \
    --distpath "$PACKAGE" "$ROOT/main-macos.spec"

chmod +x "$PACKAGE/$NAME"

# Each ZIP has manifest.json at its root, ready to extract/load as an extension.
for BROWSER in chrome firefox; do
    rm -f "$PACKAGE/$BROWSER.zip"
    /usr/bin/ditto -c -k "$ROOT/extensions/${BROWSER}_capture" "$PACKAGE/$BROWSER.zip"
done
# Remove artifacts produced by the previous packaging layout.
rm -rf "$PACKAGE/extensions"
rm -f "$PACKAGE/mosaic-bridge" "$PACKAGE/Start Mosaic Bridge.command" \
    "$PACKAGE/LICENSE" "$PACKAGE/README.txt" "$PACKAGE/chrome_capture.zip" \
    "$PACKAGE/firefox_capture.zip" "$OUT/$NAME.zip"
echo "Build complete: $PACKAGE ($NAME + chrome.zip + firefox.zip)"
