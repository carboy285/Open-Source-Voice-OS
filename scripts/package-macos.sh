#!/bin/bash
# Builds Murmur.app (universal) with the bundled core and Node runtime, then a drag-to-Applications .dmg.
# Signing and notarization run only when these environment variables are set:
#   APPLE_DEVELOPER_ID   codesign identity, e.g. "Developer ID Application: Name (TEAMID)"
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD   notarization (app-specific password)
# Without them the app is ad-hoc signed and the dmg is unsigned.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=node-runtime.env
source scripts/node-runtime.env

VERSION="$(node -p 'require("./package.json").version')"
BUILD_NUMBER="${GITHUB_RUN_NUMBER:-1}"
WORK="$ROOT/build/macos"
APP="$WORK/Murmur.app"
OUT="$ROOT/build/installers"
rm -rf "$WORK"
mkdir -p "$WORK" "$OUT"

echo "==> Bundling the core"
npm run --silent bundle:core

echo "==> Fetching Node $NODE_VERSION (arm64 + x64) and verifying checksums"
BASE="https://nodejs.org/dist/v$NODE_VERSION"
curl -fsSL --retry 3 -o "$WORK/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
fetch_node() {
  local arch="$1" expected="$2" file="node-v$NODE_VERSION-darwin-$1.tar.gz"
  curl -fsSL --retry 3 -o "$WORK/$file" "$BASE/$file"
  local actual
  actual="$(shasum -a 256 "$WORK/$file" | awk '{print $1}')"
  grep -q "^$expected  $file\$" "$WORK/SHASUMS256.txt" || { echo "Pinned hash for $file is not in SHASUMS256.txt" >&2; exit 1; }
  [ "$actual" = "$expected" ] || { echo "Checksum mismatch for $file" >&2; exit 1; }
  tar -xzf "$WORK/$file" -C "$WORK"
}
fetch_node arm64 "$NODE_SHA256_DARWIN_ARM64"
fetch_node x64 "$NODE_SHA256_DARWIN_X64"
lipo -create \
  "$WORK/node-v$NODE_VERSION-darwin-arm64/bin/node" \
  "$WORK/node-v$NODE_VERSION-darwin-x64/bin/node" \
  -output "$WORK/node"

echo "==> Building the Swift shell (universal)"
(cd native/macos && swift build -c release --arch arm64 --arch x86_64)
BIN="$(cd native/macos && swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/Murmur"

echo "==> Assembling Murmur.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/core"
cp "$BIN" "$APP/Contents/MacOS/Murmur"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUMBER/" native/macos/Support/Info.plist > "$APP/Contents/Info.plist"
cp "$WORK/node" "$APP/Contents/Resources/core/node"
cp build/core/murmur-core.mjs "$APP/Contents/Resources/core/murmur-core.mjs"
cp "$WORK/node-v$NODE_VERSION-darwin-arm64/LICENSE" "$APP/Contents/Resources/core/NODE-LICENSE"
cp LICENSE NOTICE "$APP/Contents/Resources/"
cat > "$APP/Contents/Resources/core/murmur" <<'SHIM'
#!/bin/sh
# murmur CLI: link it into your PATH, e.g. ln -s /Applications/Murmur.app/Contents/Resources/core/murmur /usr/local/bin/murmur
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
exec "$DIR/node" --disable-warning=ExperimentalWarning "$DIR/murmur-core.mjs" "$@"
SHIM
chmod +x "$APP/Contents/Resources/core/murmur"
[ -f build/core/murmur-core.mjs.LEGAL.txt ] && cp build/core/murmur-core.mjs.LEGAL.txt "$APP/Contents/Resources/core/THIRD-PARTY.txt"

echo "==> Adding the speech engines (whisper.cpp: parakeet-cli for NVIDIA Parakeet, whisper-cli)"
scripts/build-speech-cli.sh build/speech-bin
mkdir -p "$APP/Contents/Resources/core/bin"
cp build/speech-bin/parakeet-cli build/speech-bin/whisper-cli build/speech-bin/WHISPER-CPP-LICENSE "$APP/Contents/Resources/core/bin/"

echo "==> Making the icon"
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" assets/icon/murmur-1024.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" assets/icon/murmur-1024.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# An asset catalog (Assets.car) as well: CoreUI looks for one under the bundle id and logs a fault when it's missing.
XCASSETS="$WORK/Assets.xcassets"
APPICONSET="$XCASSETS/AppIcon.appiconset"
mkdir -p "$APPICONSET"
printf '{"info":{"version":1,"author":"murmur"}}\n' > "$XCASSETS/Contents.json"
{
  printf '{"images":['
  sep=""
  for size in 16 32 128 256 512; do
    for scale in 1 2; do
      file="icon_${size}x${size}.png"
      [ "$scale" = 2 ] && file="icon_${size}x${size}@2x.png"
      cp "$ICONSET/$file" "$APPICONSET/$file"
      printf '%s{"idiom":"mac","size":"%sx%s","scale":"%sx","filename":"%s"}' "$sep" "$size" "$size" "$scale" "$file"
      sep=","
    done
  done
  printf '],"info":{"version":1,"author":"murmur"}}\n'
} > "$APPICONSET/Contents.json"
if xcrun actool "$XCASSETS" --compile "$APP/Contents/Resources" --platform macosx \
  --minimum-deployment-target 13.3 --app-icon AppIcon --output-partial-info-plist "$WORK/assets-info.plist" >/dev/null; then
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconName string AppIcon" "$APP/Contents/Info.plist" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Set :CFBundleIconName AppIcon" "$APP/Contents/Info.plist"
else
  echo "warning: actool failed; shipping AppIcon.icns only" >&2
fi

echo "==> Signing"
if [ -n "${APPLE_DEVELOPER_ID:-}" ]; then
  codesign --force --options runtime --timestamp --entitlements native/macos/Support/node.entitlements \
    --sign "$APPLE_DEVELOPER_ID" "$APP/Contents/Resources/core/node"
  for tool in "$APP"/Contents/Resources/core/bin/*-cli; do
    codesign --force --options runtime --timestamp --sign "$APPLE_DEVELOPER_ID" "$tool"
  done
  codesign --force --options runtime --timestamp --entitlements native/macos/Support/Murmur.entitlements \
    --sign "$APPLE_DEVELOPER_ID" "$APP"
  SIGNED=1
else
  echo "    APPLE_DEVELOPER_ID is not set: ad-hoc signing (unsigned build)"
  codesign --force --sign - "$APP/Contents/Resources/core/node"
  for tool in "$APP"/Contents/Resources/core/bin/*-cli; do codesign --force --sign - "$tool"; done
  codesign --force --sign - --entitlements native/macos/Support/Murmur.entitlements "$APP"
  SIGNED=0
fi
codesign --verify --deep --strict "$APP"

echo "==> Creating the disk image"
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
DMG="$OUT/Murmur-$VERSION-macos-universal.dmg"
rm -f "$DMG"
hdiutil create -volname "Murmur" -srcfolder "$STAGE" -ov -format UDZO "$DMG"

if [ "$SIGNED" = 1 ]; then
  codesign --force --timestamp --sign "$APPLE_DEVELOPER_ID" "$DMG"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    echo "==> Notarizing"
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
    xcrun stapler staple "$DMG"
  else
    echo "    Notarization skipped: APPLE_ID, APPLE_TEAM_ID or APPLE_APP_PASSWORD is not set"
  fi
fi

echo "==> Done: $DMG"
