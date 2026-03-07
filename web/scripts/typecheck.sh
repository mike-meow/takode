#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}/companion-typecheck"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "node executable not found" >&2
  exit 1
fi

mkdir -p "$TMP_ROOT"

if command -v sha256sum >/dev/null 2>&1; then
  CACHE_KEY="$(printf '%s' "$WEB_ROOT" | sha256sum | cut -c1-16)"
elif command -v shasum >/dev/null 2>&1; then
  CACHE_KEY="$(printf '%s' "$WEB_ROOT" | shasum -a 256 | cut -c1-16)"
else
  CACHE_KEY="$(printf '%s' "$WEB_ROOT" | cksum | awk '{print $1}')"
fi

BUILD_INFO="${TMP_ROOT}/${CACHE_KEY}.tsbuildinfo"

exec "$NODE_BIN" "$WEB_ROOT/node_modules/typescript/lib/tsc.js" \
  --noEmit \
  --pretty false \
  --incremental \
  --tsBuildInfoFile "$BUILD_INFO" \
  "$@"
