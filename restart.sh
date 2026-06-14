#!/usr/bin/env bash
# restart.sh — restart everything with one command.
#
# Stops and re-starts the hub daemon fresh, then launches a new Claude session.
# (The "session" is just the foreground Claude process — restarting it means
# starting a fresh one here.)
#
#   ./restart.sh              # fallback session: handles every unrouted chat
#   ./restart.sh <chat_id>    # dedicated session bound to one chat
set -euo pipefail
cd "$(dirname "$0")"

echo "Restarting hub ..."
./hub.sh restart

echo ""
# Hand off to run.sh for the session (its hub-ensure step is a no-op now).
exec ./run.sh "$@"
