#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-3120}"
LOG_FILE="${LOG_FILE:-/tmp/msg2-socket-smoke.log}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

PORT="$PORT" bun run src/server.ts >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
sleep 2

bun run socket:check -- --base "http://127.0.0.1:${PORT}"

echo "socket smoke passed on http://127.0.0.1:${PORT}"
