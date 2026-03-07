#!/usr/bin/env bash
# tailscale-serve.sh — Expose Companion (Takode) over Tailscale HTTPS.
#
# Usage:
#   ./scripts/tailscale-serve.sh prod    # HTTPS :443 → localhost:3456
#   ./scripts/tailscale-serve.sh dev     # HTTPS :443 → localhost:5174
#   ./scripts/tailscale-serve.sh status  # Show current tailscale serve config
#   ./scripts/tailscale-serve.sh stop    # Remove all tailscale serve rules
#
# The resulting URL is:
#   https://whattoeat-server.tail02550e.ts.net
#
# Why this exists:
#   Safari (iOS/macOS) requires a secure context (HTTPS) for microphone
#   access via getUserMedia(). Tailscale Serve provides HTTPS with
#   auto-provisioned Let's Encrypt certs on *.ts.net domains, trusted
#   by all browsers including Safari.
#
# First-time setup:
#   1. Enable Serve on this node in the Tailscale admin console.
#      If not enabled, `tailscale serve` will print a URL to visit.
#   2. Ensure MagicDNS and HTTPS are enabled in your tailnet DNS settings
#      (https://login.tailscale.com/admin/dns).
#
# Prerequisites:
#   - Tailscale installed and logged in (`tailscale status`)
#   - Serve enabled for this node (see above)
#   - The target server (prod or dev) must be running before accessing the URL
#
# Notes:
#   - WebSocket connections (app WS + Vite HMR) work through tailscale serve.
#   - The frontend auto-detects the hostname via location.host, so wss:// works
#     without any code changes.
#   - In dev mode, Vite's internal proxy (/api, /ws → localhost:3457) still works
#     because the proxy runs server-side on the Vite process.
#   - Always use the full *.ts.net FQDN, not the short hostname, to avoid cert
#     warnings.

set -euo pipefail

PROD_PORT="${COMPANION_PORT:-3456}"
DEV_PORT="${COMPANION_DEV_PORT:-5174}"

fqdn() {
  tailscale status --json 2>/dev/null | jq -r '.Self.DNSName' | sed 's/\.$//'
}

serve_reset() {
  # Clear any existing serve configuration
  sudo tailscale serve reset 2>/dev/null || true
}

preflight() {
  if ! command -v tailscale &>/dev/null; then
    echo "Error: tailscale not found on PATH" >&2; exit 1
  fi
  if ! tailscale status &>/dev/null; then
    echo "Error: tailscale is not connected. Run: sudo tailscale up" >&2; exit 1
  fi
  if ! command -v jq &>/dev/null; then
    echo "Error: jq not found (needed for FQDN lookup)" >&2; exit 1
  fi
}

serve_start() {
  local port="$1"
  local mode="$2"
  preflight
  local host
  host=$(fqdn)

  serve_reset
  if ! sudo tailscale serve --bg "$port"; then
    echo ""
    echo "tailscale serve failed. If Serve is not enabled for this node,"
    echo "visit the URL above to enable it, then retry."
    exit 1
  fi

  echo ""
  echo "Tailscale HTTPS ($mode) is live:"
  echo "  https://${host}"
  echo ""
  echo "Proxying HTTPS :443 → localhost:${port}"
  echo ""
  if [[ "$mode" == "dev" ]]; then
    echo "Make sure the dev server is running:"
    echo "  cd ~/companion && make dev"
  else
    echo "Make sure the production server is running:"
    echo "  cd ~/companion && npm start"
  fi
}

case "${1:-help}" in
  prod)
    serve_start "$PROD_PORT" "prod"
    ;;
  dev)
    serve_start "$DEV_PORT" "dev"
    ;;
  status)
    tailscale serve status
    ;;
  stop)
    serve_reset
    echo "Tailscale serve stopped."
    ;;
  *)
    echo "Usage: $0 {prod|dev|status|stop}"
    echo ""
    echo "  prod    Proxy HTTPS → localhost:${PROD_PORT} (production server)"
    echo "  dev     Proxy HTTPS → localhost:${DEV_PORT} (Vite dev server)"
    echo "  status  Show current serve configuration"
    echo "  stop    Remove all serve rules"
    exit 1
    ;;
esac
