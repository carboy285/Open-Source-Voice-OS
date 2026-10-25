#!/bin/bash
# Local-only build: reuse the installed runtime/speech engines; never fetch, tag, push or publish.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DONOR="${MURMUR_SOURCE_APP:-/Applications/Murmur.app}"
APP="$ROOT/build/local/Murmur.app"
[ -f "$DONOR/Contents/Resources/core/murmur-core.mjs" ] || { echo 'An installed Murmur app is required.' >&2; exit 1; }
VERSION="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')"
npm run bundle:core
SWIFT_ARGS=(-c release --disable-sandbox)
if [ -n "${MURMUR_SDK:-}" ]; then SWIFT_ARGS+=(--sdk "$MURMUR_SDK"); fi
(cd native/macos && swift build "${SWIFT_ARGS[@]}")
BIN="$(cd native/macos && swift build "${SWIFT_ARGS[@]}" --show-bin-path)/Murmur"
mkdir -p "$ROOT/build/local"
# APP is always the generated staging bundle, never the installed donor.
if [ -d "$APP" ]; then rm -rf "$APP"; fi
ditto "$DONOR" "$APP"
cp "$BIN" "$APP/Contents/MacOS/Murmur"
cp build/core/murmur-core.mjs "$APP/Contents/Resources/core/murmur-core.mjs"
if [ -f build/core/murmur-core.mjs.LEGAL.txt ]; then cp build/core/murmur-core.mjs.LEGAL.txt "$APP/Contents/Resources/core/THIRD-PARTY.txt"; fi
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion 19' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Delete :MurmurLocalBuild' "$APP/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :MurmurLocalBuild bool true' "$APP/Contents/Info.plist"
codesign --force --sign - --entitlements native/macos/Support/Murmur.entitlements "$APP"
codesign --verify --deep --strict "$APP"
echo "Local app ready: $APP"
