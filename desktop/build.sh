#!/usr/bin/env bash
# build.sh — Build the Takode macOS .app bundle.
#
# Prerequisites:
#   - Rust toolchain (rustup.rs)
#   - Xcode Command Line Tools (xcode-select --install)
#   - Bun (https://bun.sh)
#   - cargo-tauri v2 (cargo install tauri-cli@^2)
#
# Usage:
#   cd desktop && ./build.sh
#
# The .app bundle will be at:
#   src-tauri/target/release/bundle/macos/Takode.app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_DIR="$SCRIPT_DIR/src-tauri"
BUNDLE_WEB="$TAURI_DIR/web"

echo "==> Building web app..."
cd "$REPO_ROOT/web"
bun install --frozen-lockfile
bun run build

echo "==> Preparing bundled web resources..."
# Start clean — only bundle what the production server needs.
rm -rf "$BUNDLE_WEB"
mkdir -p "$BUNDLE_WEB"

# Copy build output (Vite-compiled frontend).
cp -R "$REPO_ROOT/web/dist" "$BUNDLE_WEB/dist"

# Copy server source (Hono backend — runs via bun at runtime).
cp -R "$REPO_ROOT/web/server" "$BUNDLE_WEB/server"
cp -R "$REPO_ROOT/web/bin" "$BUNDLE_WEB/bin"

# Copy package manifests for production install.
cp "$REPO_ROOT/web/package.json" "$BUNDLE_WEB/package.json"
cp "$REPO_ROOT/web/tsconfig.json" "$BUNDLE_WEB/tsconfig.json"
# Copy lockfile (bun.lock is at repo root).
cp "$REPO_ROOT/bun.lock" "$BUNDLE_WEB/bun.lock"

# Install production dependencies only (no devDependencies).
echo "==> Installing production node_modules..."
cd "$BUNDLE_WEB"
bun install --frozen-lockfile --production

echo "==> Bundling bun binary..."
mkdir -p "$TAURI_DIR/binaries"
BUN_PATH="$(which bun)"
cp "$BUN_PATH" "$TAURI_DIR/binaries/bun"
chmod +x "$TAURI_DIR/binaries/bun"

echo "==> Building Tauri app..."
cd "$SCRIPT_DIR"
cargo tauri build 2>&1

APP_PATH="$TAURI_DIR/target/release/bundle/macos/Takode.app"
if [ -d "$APP_PATH" ]; then
  echo ""
  echo "==> Build succeeded!"
  echo "    $APP_PATH"
  echo ""
  echo "    Open it with:  open \"$APP_PATH\""
else
  echo "ERROR: .app bundle not found at $APP_PATH"
  exit 1
fi
