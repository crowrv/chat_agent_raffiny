#!/usr/bin/env bash
# hub.sh — control the shared, persistent Telegram hub daemon.
#
# The hub is a long-lived router. It is NOT tied to any chat or Claude session:
# it polls incoming messages and routes each one (by chat_id, with a fallback)
# to whichever sessions have bound themselves. Start it once; open as many
# Claude sessions against it as you like. Closing a session never stops the hub.
#
# Instagram feeder lifecycle is separate by default. Set IG_SOURCE=1 with
# `start`, or use `start-ig`, to poll IG DMs into the hub.
#
#   ./hub.sh start     # start the daemon only by default
#   ./hub.sh stop      # stop the daemon only
#   ./hub.sh restart   # stop then start the daemon only
#   ./hub.sh status    # is it running?
#   ./hub.sh start-ig  # start only the Instagram feeder
#   ./hub.sh stop-ig   # stop only the Instagram feeder
#   ./hub.sh logs      # follow the hub log
set -euo pipefail
cd "$(dirname "$0")"

command -v bun >/dev/null 2>&1 || export PATH="/opt/homebrew/bin:$PATH"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

APP_ID="${RAFFIN_PROCESS_ID:-$(printf "%s" "$PWD" | shasum | awk '{print substr($1,1,12)}')}"
HUB_SCRIPT="$PWD/src/hub.ts"
IG_SCRIPT="$PWD/src/ig-source.ts"
HUB_REL_SCRIPT="src/hub.ts"
IG_REL_SCRIPT="src/ig-source.ts"
PID_FILE="${TELEGRAM_HUB_PID_FILE:-/tmp/telegram-hub-${APP_ID}.pid}"
LOG_FILE="/tmp/telegram-claude-hub.log"
BOOT_LOG="/tmp/telegram-hub-boot.log"

# Instagram feeder (src/ig-source.ts): polls IG DMs and pushes them to the hub's
# /ingest endpoint. It is opt-in so session startup does not silently monitor IG.
IG_SOURCE="${IG_SOURCE:-0}"
IG_PID_FILE="${IG_SOURCE_PID_FILE:-/tmp/ig-source-${APP_ID}.pid}"
IG_LOG="/tmp/ig-source.log"
HUB_HOST="${TELEGRAM_HUB_HOST:-127.0.0.1}"
HUB_PORT="${TELEGRAM_HUB_PORT:-4713}"
EXPECTED_HUB_ID="${TELEGRAM_HUB_ID:-}"
# Canonical project root (symlinks + true case resolved) so the hub-identity
# health check matches src/hub.ts, which reports realpathSync(projectRoot).
PROJECT_ROOT="$(bun -e 'console.log(require("fs").realpathSync(process.cwd()))' 2>/dev/null || echo "$PWD")"

process_matches() {
  local pid="$1"
  local abs_script="$2"
  local rel_script="$3"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local command_line
  command_line="$(ps -p "$pid" -ww -o command= 2>/dev/null || true)"
  case "$command_line" in
    *"$abs_script"*) return 0 ;;
    *"$rel_script"*) process_cwd_matches "$pid" && return 0 ;;
  esac
  return 1
}

process_cwd_matches() {
  local pid="$1"
  local cwd=""
  if [ -L "/proc/$pid/cwd" ]; then
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  fi
  [ -n "$cwd" ] && [ "$cwd" = "$PROJECT_ROOT" ]
}

find_owned_pids() {
  local abs_script="$1"
  local rel_script="$2"
  ps -axww -o pid= -o command= | while read -r pid command_line; do
    [ -n "${pid:-}" ] || continue
    case "$command_line" in
      *"$abs_script"*) echo "$pid" ;;
      *"$rel_script"*) process_cwd_matches "$pid" && echo "$pid" ;;
    esac
  done
}

running_pid() {
  local pid_file="$1"
  local abs_script="$2"
  local rel_script="$3"
  local pid=""
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if process_matches "$pid" "$abs_script" "$rel_script"; then
      echo "$pid"
      return 0
    fi
  fi
  find_owned_pids "$abs_script" "$rel_script" | head -1
}

owned_pids() {
  local pid_file="$1"
  local abs_script="$2"
  local rel_script="$3"
  {
    running_pid "$pid_file" "$abs_script" "$rel_script"
    find_owned_pids "$abs_script" "$rel_script"
  } | awk 'NF && !seen[$1]++'
}

hub_health_matches() {
  [ -n "$EXPECTED_HUB_ID" ] || return 1
  local url="http://${HUB_HOST}:${HUB_PORT}/health"
  bun -e '
    const [url, expectedInstance, expectedRoot] = process.argv.slice(1);
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) process.exit(1);
    const data = await res.json().catch(() => ({}));
    process.exit(data?.instance === expectedInstance && data?.projectRoot === expectedRoot ? 0 : 1);
  ' "$url" "$EXPECTED_HUB_ID" "$PROJECT_ROOT"
}

hub_review_ready() {
  [ -n "$EXPECTED_HUB_ID" ] || return 1
  local url="http://${HUB_HOST}:${HUB_PORT}/health"
  bun -e '
    const [url, expectedInstance, expectedRoot] = process.argv.slice(1);
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) process.exit(1);
    const data = await res.json().catch(() => ({}));
    const sameHub = data?.instance === expectedInstance && data?.projectRoot === expectedRoot;
    process.exit(sameHub && data?.roles?.review === true ? 0 : 1);
  ' "$url" "$EXPECTED_HUB_ID" "$PROJECT_ROOT"
}

wait_for_hub_health() {
  local pid="$1"
  for _ in $(seq 1 30); do
    if hub_health_matches; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done
  return 1
}

is_running() {
  [ -n "$(running_pid "$PID_FILE" "$HUB_SCRIPT" "$HUB_REL_SCRIPT")" ]
}

ig_running() {
  [ -n "$(running_pid "$IG_PID_FILE" "$IG_SCRIPT" "$IG_REL_SCRIPT")" ]
}

start_ig_source() {
  if [ "$IG_SOURCE" = "0" ]; then
    echo "Skipping IG feeder (IG_SOURCE=0)."
    return 0
  fi
  local existing_pid
  existing_pid="$(running_pid "$IG_PID_FILE" "$IG_SCRIPT" "$IG_REL_SCRIPT")"
  if [ -n "$existing_pid" ]; then
    echo "$existing_pid" > "$IG_PID_FILE"
    echo "IG feeder already running (pid $existing_pid)."
    return 0
  fi
  # Launch detached so it outlives this shell. Stop only the pid we own.
  nohup bun run "$IG_SCRIPT" >> "$IG_LOG" 2>&1 < /dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$IG_PID_FILE"
  echo "IG feeder started (pid $pid). Logs: $IG_LOG"
}

stop_ig_source() {
  local stopped=0
  local pid
  for pid in $(owned_pids "$IG_PID_FILE" "$IG_SCRIPT" "$IG_REL_SCRIPT"); do
    echo "Stopping IG feeder (pid $pid) ..."
    kill "$pid" 2>/dev/null || true
    stopped=1
  done
  if [ "$stopped" = "0" ]; then
    echo "IG feeder is not running."
  fi
  rm -f "$IG_PID_FILE"
}

start_ig() {
  local previous_ig_source="$IG_SOURCE"
  IG_SOURCE=0
  start
  IG_SOURCE="$previous_ig_source"
  if ! hub_review_ready; then
    echo "ERROR: review session is not bound on this hub; refusing to start Instagram polling." >&2
    echo "Start or restart it with: ./fleet.sh start-review" >&2
    exit 1
  fi
  IG_SOURCE=1
  start_ig_source
  IG_SOURCE="$previous_ig_source"
}

restart_ig() {
  stop_ig_source
  sleep 1
  start_ig
}

start() {
  local existing_pid
  existing_pid="$(running_pid "$PID_FILE" "$HUB_SCRIPT" "$HUB_REL_SCRIPT")"
  if [ -n "$existing_pid" ]; then
    if wait_for_hub_health "$existing_pid"; then
      echo "$existing_pid" > "$PID_FILE"
      echo "Hub already running (pid $existing_pid)."
      start_ig_source
      return 0
    fi
    echo "Existing hub pid $existing_pid failed health identity check; stopping it before restart." >&2
    kill "$existing_pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    sleep 1
  fi
  command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not found. brew install oven-sh/bun/bun" >&2; exit 1; }
  echo "Starting hub daemon ..."
  # nohup + disown + detached stdin so it outlives the launching shell/terminal.
  nohup bun run "$HUB_SCRIPT" >> "$BOOT_LOG" 2>&1 < /dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$PID_FILE"
  if wait_for_hub_health "$pid"; then
    echo "Hub ready (pid $pid). Logs: $LOG_FILE"
    start_ig_source
    return 0
  fi
  echo "ERROR: hub failed to start. Recent output:" >&2
  tail -20 "$BOOT_LOG" >&2
  rm -f "$PID_FILE"
  exit 1
}

stop() {
  local stopped=0
  local pid
  for pid in $(owned_pids "$PID_FILE" "$HUB_SCRIPT" "$HUB_REL_SCRIPT"); do
    echo "Stopping hub (pid $pid) ..."
    kill "$pid" 2>/dev/null || true
    stopped=1
  done
  if [ "$stopped" = "0" ]; then
    echo "Hub is not running."
    rm -f "$PID_FILE"
    return 0
  fi
  rm -f "$PID_FILE"
}

status() {
  local pid
  pid="$(running_pid "$PID_FILE" "$HUB_SCRIPT" "$HUB_REL_SCRIPT")"
  if [ -n "$pid" ]; then
    echo "Hub RUNNING (pid $pid) on ${HUB_HOST}:${HUB_PORT}"
  else
    echo "Hub STOPPED"
  fi
}

status_ig() {
  local pid
  pid="$(running_pid "$IG_PID_FILE" "$IG_SCRIPT" "$IG_REL_SCRIPT")"
  if [ -n "$pid" ]; then
    echo "IG feeder RUNNING (pid $pid)"
  else
    echo "IG feeder STOPPED"
  fi
  if curl -s "http://127.0.0.1:${IG_HEADLESS_PORT:-9334}/json/version" >/dev/null 2>&1; then
    echo "IG Chrome RUNNING on 127.0.0.1:${IG_HEADLESS_PORT:-9334}"
  else
    echo "IG Chrome STOPPED on 127.0.0.1:${IG_HEADLESS_PORT:-9334}"
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  start-ig) start_ig ;;
  stop-ig)  stop_ig_source ;;
  restart-ig) restart_ig ;;
  status-ig) status_ig ;;
  logs)    tail -f "$LOG_FILE" ;;
  *) echo "Usage: ./hub.sh {start|stop|restart|status|start-ig|stop-ig|restart-ig|status-ig|logs}" >&2; exit 1 ;;
esac
