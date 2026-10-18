#!/usr/bin/env bash
# Builds whisper.cpp's parakeet-cli (NVIDIA Parakeet) and whisper-cli for macOS as static universal
# binaries (arm64 + x86_64) with Metal, so Murmur.app runs speech recognition without Homebrew.
# Usage: scripts/build-speech-cli.sh [out-dir]   (default build/speech-bin)
set -euo pipefail

# whisper.cpp 1.9.5 with Parakeet support. Bump deliberately and re-test dictation when changing it.
# macOS 13.3 is the floor: ggml calls cblas_sgemm, which Accelerate added in 13.3.
WHISPER_CPP_COMMIT="0c7be696371069e0baa2515ed7aa08d5a5473aa6"
TOOLS=(parakeet-cli whisper-cli)

cd "$(dirname "$0")/.."
OUT="${1:-build/speech-bin}"
WORK="build/whisper-cpp"

if [ "$(cat "$OUT/.commit" 2>/dev/null)" = "$WHISPER_CPP_COMMIT" ] && [ -x "$OUT/parakeet-cli" ] && [ -x "$OUT/whisper-cli" ]; then
  echo "==> Speech CLIs already built for whisper.cpp $WHISPER_CPP_COMMIT"
  exit 0
fi

echo "==> Fetching whisper.cpp $WHISPER_CPP_COMMIT"
mkdir -p "$WORK" "$OUT"
if [ ! -d "$WORK/src/.git" ]; then
  git init -q "$WORK/src"
  git -C "$WORK/src" remote add origin https://github.com/ggml-org/whisper.cpp
fi
git -C "$WORK/src" fetch -q --depth 1 origin "$WHISPER_CPP_COMMIT"
git -C "$WORK/src" checkout -q --force FETCH_HEAD

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
for arch in arm64 x86_64; do
  echo "==> Building $arch"
  cmake -S "$WORK/src" -B "$WORK/build-$arch" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$arch" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.3 \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF \
    -DGGML_METAL=ON \
    -DGGML_METAL_EMBED_LIBRARY=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_SERVER=OFF >/dev/null
  cmake --build "$WORK/build-$arch" --config Release -j "$JOBS" --target "${TOOLS[@]}" >/dev/null
done

for tool in "${TOOLS[@]}"; do
  lipo -create "$WORK/build-arm64/bin/$tool" "$WORK/build-x86_64/bin/$tool" -output "$OUT/$tool"
  chmod +x "$OUT/$tool"
  lipo -info "$OUT/$tool"
done
cp "$WORK/src/LICENSE" "$OUT/WHISPER-CPP-LICENSE"
echo "$WHISPER_CPP_COMMIT" > "$OUT/.commit"
echo "==> Speech CLIs in $OUT"
