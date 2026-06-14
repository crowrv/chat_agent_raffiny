#!/usr/bin/env bash
# hub.sh — control the shared, persistent Telegram hub daemon.
#
# The hub is a long-lived router. It is NOT tied to any chat or Claude session:
# it polls incoming messages and routes each one (by chat_id, with a fallback)
# to whichever sessions have bound themselves. Start it once; open as many
# Claude sessions against it as you like. Closing a session never stops the hub.
#
#   ./hub.sh start     # start the daemon if not already running
#   ./hub.sh stop      # stop the daemon
#   ./hub.sh restart   # stop then start
#   ./hub.sh status    # is it running?
#   ./hub.sh logs      # follow the hub log
set -euo pipefail
cd "$(dirname "$0")"

command -v bun >/dev/null 2>&1 || export PATH="/opt/homebrew/bin:$PATH"

PID_FILE="/tmp/telegram-hub.pid"
LOG_FILE="/tmp/telegram-claude-hub.log"
BOOT_LOG="/tmp/telegram-hub-boot.log"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start() {
  if is_running; then
    echo "Hub already running (pid $(cat "$PID_FILE"))."
    return 0
  fi
  command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not found. brew install oven-sh/bun/bun" >&2; exit 1; }
  # Only one getUpdates poller is allowed per bot token — clear any stray hub.
  pkill -f "src/hub.ts" 2>/dev/null || true
  sleep 1
  echo "Starting hub daemon ..."
  # nohup + disown + detached stdin so it outlives the launching shell/terminal.
  nohup bun run src/hub.ts >> "$BOOT_LOG" 2>&1 < /dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$PID_FILE"
  for _ in $(seq 1 30); do
    if curl -s "http://127.0.0.1:4713/" >/dev/null 2>&1; then
      echo "Hub ready (pid $pid). Logs: $LOG_FILE"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done
  echo "ERROR: hub failed to start. Recent output:" >&2
  tail -20 "$BOOT_LOG" >&2
  rm -f "$PID_FILE"
  exit 1
}

stop() {
  if ! is_running; then
    echo "Hub is not running."
    rm -f "$PID_FILE"
    return 0
  fi
  local pid; pid="$(cat "$PID_FILE")"
  echo "Stopping hub (pid $pid) ..."
  kill "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
}

status() {
  if is_running; then
    echo "Hub RUNNING (pid $(cat "$PID_FILE")) on 127.0.0.1:4713"
  else
    echo "Hub STOPPED"
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  logs)    tail -f "$LOG_FILE" ;;
  *) echo "Usage: ./hub.sh {start|stop|restart|status|logs}" >&2; exit 1 ;;
esac
