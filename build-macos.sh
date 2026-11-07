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
NAME="mosaic-bridge-macos-$ARCH"
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

chmod +x "$PACKAGE/mosaic-bridge"

# Refresh collected extensions so deleted source files cannot survive a rebuild.
rm -rf "$PACKAGE/extensions"
for EXT in chrome_capture firefox_capture; do
    /usr/bin/ditto "$ROOT/extensions/$EXT" "$PACKAGE/extensions/$EXT"
done
# Remove artifacts produced by the previous packaging layout.
rm -f "$PACKAGE/Start Mosaic Bridge.command" "$PACKAGE/LICENSE" "$PACKAGE/README.txt" \
    "$PACKAGE/chrome_capture.zip" "$PACKAGE/firefox_capture.zip" "$OUT/$NAME.zip"
echo "Build complete: $PACKAGE (mosaic-bridge + extensions/)"
