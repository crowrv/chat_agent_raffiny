#!/usr/bin/env bash
# run.sh — launch a Claude session connected to the shared hub.
#
# The hub is a persistent, session-independent daemon (managed by hub.sh). This
# script ensures the hub is up, then runs one Claude session in the foreground.
# Quitting Claude does NOT stop the hub — other sessions and services keep
# running. Stop the hub explicitly with `./hub.sh stop` when you're done.
#
#   ./run.sh              # fallback session: handles every unrouted chat
#   ./run.sh <chat_id>    # dedicated session bound to one chat
set -euo pipefail
cd "$(dirname "$0")"

command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found on PATH." >&2; exit 1; }

# Which chat this session handles. The hub itself is never bound to a chat —
# only this session-side binding is. "*" = fallback for all unrouted chats.
export TELEGRAM_CHAT="${1:-*}"

# Ensure the shared hub is running, but never tie its lifecycle to this session.
./hub.sh start

echo ""
echo "Launching Claude session (chat binding: $TELEGRAM_CHAT)."
echo "Quitting Claude leaves the hub running. Stop it later with: ./hub.sh stop"
echo ""

claude --dangerously-load-development-channels server:raffiny
