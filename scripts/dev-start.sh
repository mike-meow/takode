#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# dev-start.sh — Idempotent dev environment bootstrap
#
# Usage: ./scripts/dev-start.sh          Start/verify dev servers
#        ./scripts/dev-start.sh --stop   Stop all dev servers
#        ./scripts/dev-start.sh --status Check if running
#
# Starts the Bun backend and Vite frontend used by this helper script.
# Requires installed web dependencies; run `bun install --cwd web` first.
# Idempotent: safe to run N times. If servers are healthy, exits instantly.
# =============================================================================

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
BACKEND_PORT=3457
VITE_PORT=5174
BACKEND_HEALTH_PATH="/api/health"
VITE_HEALTH_PATH="/"
BACKEND_PID_FILE="$ROOT_DIR/.dev-backend.pid"
VITE_PID_FILE="$ROOT_DIR/.dev-vite.pid"
BACKEND_LOG="$ROOT_DIR/.dev-backend.log"
VITE_LOG="$ROOT_DIR/.dev-vite.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[ok]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!!]${NC} $*"; }
die()   { echo -e "${RED}[xx]${NC} $*" >&2; exit 1; }
step()  { echo -e "${CYAN}-->>${NC} $*"; }

# --------------- helpers ---------------

missing_dependency_marker() {
  local markers=(
    "$WEB_DIR/node_modules/.bin/vite"
    "$WEB_DIR/node_modules/hono/package.json"
    "$WEB_DIR/node_modules/react/package.json"
  )

  local marker
  for marker in "${markers[@]}"; do
    if [ ! -e "$marker" ]; then
      echo "$marker"
      return 0
    fi
  done

  return 1
}

require_installed_web_dependencies() {
  local missing_marker
  if ! missing_marker=$(missing_dependency_marker); then
    return 0
  fi

  die "Missing local web dependencies in $WEB_DIR.
Expected install artifact not found: $missing_marker
Run: bun install --cwd web
Then start local dev with: make dev
Or rerun this helper after install: ./scripts/dev-start.sh"
}

start_detached() {
  local log_file="$1"
  shift
  python3 - "$log_file" "$@" <<'PY'
import subprocess
import sys

log_path = sys.argv[1]
cmd = sys.argv[2:]

with open(log_path, "ab", buffering=0) as log:
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
        close_fds=True,
    )

print(proc.pid)
PY
}

is_port_listening() {
  lsof -iTCP:"$1" -sTCP:LISTEN -t &>/dev/null
}

is_http_healthy() {
  local port="$1"
  local path="${2:-/}"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:$port$path" 2>/dev/null || echo "000")
  [[ "$code" =~ ^[23] ]]
}

get_pid_on_port() {
  lsof -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

kill_by_pid_file() {
  local pid_file="$1"
  if [ -f "$pid_file" ]; then
    local pid
    pid=$(cat "$pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}

kill_on_port() {
  local port="$1"
  if is_port_listening "$port"; then
    local pid
    pid=$(get_pid_on_port "$port")
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
}

clean_stale_pid() {
  local pid_file="$1"
  if [ -f "$pid_file" ]; then
    local pid
    pid=$(cat "$pid_file")
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pid_file"
    fi
  fi
}

wait_for_port() {
  local port="$1"
  local label="$2"
  local pid_file="$3"
  local health_path="$4"
  local max_wait=60
  local waited=0

  while [ $waited -lt $max_wait ]; do
    if is_http_healthy "$port" "$health_path"; then
      return 0
    fi
    if [ -f "$pid_file" ] && ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      local log_file
      [ "$port" = "$BACKEND_PORT" ] && log_file="$BACKEND_LOG" || log_file="$VITE_LOG"
      die "$label crashed. Logs:\n$(tail -20 "$log_file")"
    fi
    printf "."
    sleep 1
    waited=$((waited + 1))
  done

  local log_file
  [ "$port" = "$BACKEND_PORT" ] && log_file="$BACKEND_LOG" || log_file="$VITE_LOG"
  die "Timeout waiting for $label health at http://localhost:$port$health_path (${max_wait}s). Logs:\n$(tail -20 "$log_file")"
}

# --------------- commands ---------------

cmd_stop() {
  step "Stopping dev servers..."
  kill_by_pid_file "$BACKEND_PID_FILE"
  kill_by_pid_file "$VITE_PID_FILE"
  kill_on_port "$BACKEND_PORT"
  kill_on_port "$VITE_PORT"
  sleep 1
  info "Dev servers stopped"
}

cmd_status() {
  local ok=true

  if is_port_listening "$BACKEND_PORT" && is_http_healthy "$BACKEND_PORT" "$BACKEND_HEALTH_PATH"; then
    info "Backend running on http://localhost:$BACKEND_PORT (PID: $(get_pid_on_port "$BACKEND_PORT"))"
  elif is_port_listening "$BACKEND_PORT"; then
    warn "Backend port $BACKEND_PORT occupied but health check failed at $BACKEND_HEALTH_PATH"
    ok=false
  else
    warn "Backend is not running"
    ok=false
  fi

  if is_port_listening "$VITE_PORT" && is_http_healthy "$VITE_PORT" "$VITE_HEALTH_PATH"; then
    info "Vite running on http://localhost:$VITE_PORT (PID: $(get_pid_on_port "$VITE_PORT"))"
  elif is_port_listening "$VITE_PORT"; then
    warn "Vite port $VITE_PORT occupied but health check failed at $VITE_HEALTH_PATH"
    ok=false
  else
    warn "Vite is not running"
    ok=false
  fi

  $ok && return 0 || return 1
}

cmd_start() {
  cd "$WEB_DIR"

  # --- Fast path: both already running and healthy ---
  if is_port_listening "$BACKEND_PORT" && is_http_healthy "$BACKEND_PORT" "$BACKEND_HEALTH_PATH" \
     && is_port_listening "$VITE_PORT" && is_http_healthy "$VITE_PORT" "$VITE_HEALTH_PATH"; then
    info "Backend already running on http://localhost:$BACKEND_PORT"
    info "Vite already running on http://localhost:$VITE_PORT"
    exit 0
  fi

  # --- Check bun ---
  command -v bun &>/dev/null || die "bun not found. Install: https://bun.sh"
  command -v python3 &>/dev/null || die "python3 not found. Required for detached dev server startup."
  info "bun $(bun --version)"

  # --- Fail fast if local install state is missing or incomplete ---
  step "Checking installed web dependencies..."
  require_installed_web_dependencies
  info "Installed web dependencies OK"

  # --- Start backend if needed ---
  if is_port_listening "$BACKEND_PORT" && is_http_healthy "$BACKEND_PORT" "$BACKEND_HEALTH_PATH"; then
    info "Backend already running on http://localhost:$BACKEND_PORT"
  else
    if is_port_listening "$BACKEND_PORT"; then
      warn "Backend port $BACKEND_PORT occupied but unhealthy -- restarting..."
      kill_by_pid_file "$BACKEND_PID_FILE"
      kill_on_port "$BACKEND_PORT"
      sleep 1
    fi
    clean_stale_pid "$BACKEND_PID_FILE"

    step "Starting backend on port $BACKEND_PORT..."
    start_detached "$BACKEND_LOG" bun server/index.ts > "$BACKEND_PID_FILE"

    wait_for_port "$BACKEND_PORT" "Backend" "$BACKEND_PID_FILE" "$BACKEND_HEALTH_PATH"
    echo ""
    info "Backend ready on http://localhost:$BACKEND_PORT (PID: $(cat "$BACKEND_PID_FILE"))"
  fi

  # --- Start Vite if needed ---
  if is_port_listening "$VITE_PORT" && is_http_healthy "$VITE_PORT" "$VITE_HEALTH_PATH"; then
    info "Vite already running on http://localhost:$VITE_PORT"
  else
    if is_port_listening "$VITE_PORT"; then
      warn "Vite port $VITE_PORT occupied but unhealthy -- restarting..."
      kill_by_pid_file "$VITE_PID_FILE"
      kill_on_port "$VITE_PORT"
      sleep 1
    fi
    clean_stale_pid "$VITE_PID_FILE"

    step "Starting Vite dev server on port $VITE_PORT..."
    start_detached "$VITE_LOG" bun run dev:vite > "$VITE_PID_FILE"

    wait_for_port "$VITE_PORT" "Vite" "$VITE_PID_FILE" "$VITE_HEALTH_PATH"
    echo ""
    info "Vite ready on http://localhost:$VITE_PORT (PID: $(cat "$VITE_PID_FILE"))"
  fi

  echo ""
  info "Dev environment ready!"
  echo -e "  Backend API:  ${CYAN}http://localhost:$BACKEND_PORT${NC}"
  echo -e "  Frontend UI:  ${CYAN}http://localhost:$VITE_PORT${NC}"
}

# --------------- main ---------------

case "${1:-}" in
  --stop)   cmd_stop   ;;
  --status) cmd_status ;;
  *)        cmd_start  ;;
esac
