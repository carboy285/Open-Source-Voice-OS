#!/bin/bash
# Stand-in for the codex CLI: records its arguments and stdin, writes a canned final message.
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
  esac
  all="$all $1"
  shift
done
cat > "${FAKE_CODEX_STDIN:-/dev/null}"
echo "$all" > "${FAKE_CODEX_ARGS:-/dev/null}"
default='{"text":"ok","tool_calls":[]}'
printf '%s' "${FAKE_CODEX_REPLY:-$default}" > "$out"
