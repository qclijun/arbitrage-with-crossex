#!/usr/bin/env bash
# Stop the CrossEx-Boros-Terminal service.
#
# Kills the Fastify server regardless of how it was launched:
#   yarn server / yarn start  -> tsx src/server/index.ts
#   yarn dev                  -> concurrently + tsx watch + Vite
# In `yarn dev`, the concurrently process itself matches the pattern below, so
# killing it tears down the watcher and the Vite dev server too.
#
# Usage:
#   yarn stop             # default port 6688
#   PORT=7000 yarn stop   # if the server was started with PORT=7000

set -u

PORT="${PORT:-6688}"
# The [.] keeps the pattern from matching this script's own pkill/pgrep argv.
PATTERN='src/server/index[.]ts'

is_running() {
  pgrep -f "$PATTERN" >/dev/null 2>&1 ||
    { command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ":${PORT} "; }
}

signal_tree() {
  pkill "-${1}" -f "$PATTERN" 2>/dev/null || true
}

echo "Stopping arb-tools terminal server (port ${PORT})..."

signal_tree TERM
sleep 1

if is_running; then
  echo "Still running after SIGTERM; sending SIGKILL..."
  signal_tree KILL
  sleep 1
fi

# Backstop: kill whatever is holding the port in case its cmdline doesn't
# match the pattern above.
if command -v fuser >/dev/null 2>&1; then
  fuser -k -TERM "${PORT}/tcp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  lsof -t -i "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | xargs -r kill -TERM 2>/dev/null || true
fi

sleep 1

if is_running; then
  echo "ERROR: server is still running." >&2
  exit 1
fi

echo "Stopped."
