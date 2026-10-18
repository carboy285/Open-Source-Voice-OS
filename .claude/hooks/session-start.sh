#!/bin/bash
# Prepares cloud sessions: npm dependencies plus the Ghidra install that REA's MCP server uses.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"
npm install --no-audit --no-fund

GHIDRA_VERSION="12.1.4"
GHIDRA_BUILD="20260921"
GHIDRA_DIR="$HOME/tools/ghidra_${GHIDRA_VERSION}_PUBLIC"
GHIDRA_ZIP="ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_BUILD}.zip"
GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/${GHIDRA_ZIP}"

# A failed Ghidra download must not block the session; REA's other analyzers still work.
install_ghidra() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$HOME/tools"
  curl -fsSL --retry 3 --retry-delay 5 -o "$tmp/$GHIDRA_ZIP" "$GHIDRA_URL"
  unzip -q "$tmp/$GHIDRA_ZIP" -d "$tmp/out"
  rm -rf "$GHIDRA_DIR"
  mv "$tmp/out/ghidra_${GHIDRA_VERSION}_PUBLIC" "$GHIDRA_DIR"
}

if [ ! -f "$GHIDRA_DIR/Ghidra/application.properties" ]; then
  install_ghidra || echo "warning: Ghidra install failed; REA native analysis will be unavailable" >&2
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export GHIDRA_INSTALL_DIR=\"$GHIDRA_DIR\"" >> "$CLAUDE_ENV_FILE"
fi
