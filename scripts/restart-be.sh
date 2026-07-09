#!/usr/bin/env bash
#
# restart-be.sh — cleanly restart the backend dev server.
#
# Use this whenever you change MONGO_URI (or any other value) in `.env`.
# `tsx watch` does NOT reload on `.env` changes, and a lingering process
# keeps holding port 3001 — so a plain "save + reload" silently keeps the
# OLD database connection. This script kills every backend process, frees
# the port, and starts exactly one fresh server that reads the current
# `.env`.
#
# Usage:  ./scripts/restart-be.sh        (foreground — shows logs, Ctrl-C to stop)
#         ./scripts/restart-be.sh -d     (detached  — runs in background)
#
set -euo pipefail

# Resolve the backend package dir from this script's location, so it works
# no matter where you invoke it from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${PORT:-3001}"

cd "$BE_DIR"

# Show which DB this restart will connect to (password redacted).
DB_LINE="$(grep -E '^MONGO_URI=' .env 2>/dev/null | head -1 | sed -E 's/:[^:@]+@/:****@/')"
echo "→ Restarting backend"
echo "  ${DB_LINE:-MONGO_URI not found in .env!}"

# 1) Kill every backend process (the tsx watcher + its node child).
echo "→ Stopping any running backend processes…"
pkill -9 -f "tsx watch src/index.ts" 2>/dev/null || true
pkill -9 -f "node .*src/index.ts"   2>/dev/null || true

# 2) Make sure port 3001 is actually free before starting (guards against a
#    leftover process still holding it).
for _ in 1 2 3 4 5 10; do
  if lsof -ti ":$PORT" >/dev/null 2>&1; then
    lsof -ti ":$PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
    sleep 1
  else
    break
  fi
done

if lsof -ti ":$PORT" >/dev/null 2>&1; then
  echo "✗ Port $PORT is still in use — could not free it. Check: lsof -nP -i :$PORT" >&2
  exit 1
fi
echo "→ Port $PORT is free."

# 3) Start one fresh server.
if [[ "${1:-}" == "-d" || "${1:-}" == "--detach" ]]; then
  LOG="$BE_DIR/dev-server.log"
  echo "→ Starting detached (logs → $LOG)…"
  nohup npm run dev >"$LOG" 2>&1 &
  echo "  started pid $!  —  tail -f \"$LOG\" to watch, or curl :$PORT/health"
else
  echo "→ Starting (foreground — Ctrl-C to stop)…"
  exec npm run dev
fi
