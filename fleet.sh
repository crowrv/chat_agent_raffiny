#!/usr/bin/env bash
# fleet.sh — tmux supervisor for the Raffin channel fleet.
#
# The hub routes messages. Claude sessions bind themselves as review/ops roles.
# Instagram polling is controlled separately so starting the program does not
# silently monitor customer DMs.
set -euo pipefail
cd "$(dirname "$0")"

command -v tmux >/dev/null 2>&1 || { echo "ERROR: tmux not found." >&2; exit 1; }
command -v bun >/dev/null 2>&1 || export PATH="/opt/homebrew/bin:$PATH"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

SESSION="${RAFFIN_TMUX_SESSION:-raffiny}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
KEEP_AWAKE=""
if command -v caffeinate >/dev/null 2>&1; then
  KEEP_AWAKE="caffeinate -ids"
fi

usage() {
  cat >&2 <<'EOF'
Usage: ./fleet.sh <command>

Fleet:
  start            Start hub + review + ops, and IG if RAFFIN_START_IG_SOURCE=1
  stop             Stop IG/hub and kill the tmux fleet
  status           Show hub, IG, and tmux window status
  attach           Attach to the raffiny tmux session
  logs             Tail hub and IG logs

Components:
  start-hub        Start hub only
  restart-hub      Restart hub only
  start-review     Start review Claude session
  restart-review   Restart review Claude session
  start-ops        Start ops Claude session
  restart-ops      Restart ops Claude session
  start-ig         Start Instagram feeder only
  stop-ig          Stop Instagram feeder only
  restart-ig       Restart Instagram feeder only
  status-ig        Show Instagram feeder/browser status
EOF
  exit 2
}

tmux_has_session() {
  tmux has-session -t "$SESSION" 2>/dev/null
}

tmux_window_exists() {
  tmux_has_session && tmux list-windows -t "$SESSION" -F '#W' | grep -qx "$1"
}

run_window() {
  local name="$1"
  local cmd="$2"
  if tmux_window_exists "$name"; then
    echo "tmux window '$name' already exists in $SESSION"
    return 0
  fi
  if tmux_has_session; then
    tmux new-window -d -t "$SESSION:" -n "$name" "$cmd"
  else
    tmux new-session -d -s "$SESSION" -n "$name" "$cmd"
  fi
  echo "started tmux window '$name'"
}

kill_window() {
  local name="$1"
  if tmux_window_exists "$name"; then
    tmux kill-window -t "$SESSION:$name"
  fi
}

require_env() {
  local key="$1"
  if [ -z "${!key:-}" ]; then
    echo "ERROR: $key is required. Set it in .env." >&2
    exit 1
  fi
}

hub_url() {
  echo "http://${TELEGRAM_HUB_HOST:-127.0.0.1}:${TELEGRAM_HUB_PORT:-4713}"
}

hub_review_ready() {
  local url
  url="$(hub_url)/health"
  bun -e '
    const [url, expectedInstance, expectedRoot] = process.argv.slice(1);
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) process.exit(1);
    const data = await res.json().catch(() => ({}));
    const sameHub = data?.instance === expectedInstance && data?.projectRoot === expectedRoot;
    process.exit(sameHub && data?.roles?.review === true ? 0 : 1);
  ' "$url" "${TELEGRAM_HUB_ID:-}" "$PWD"
}

wait_for_review() {
  for _ in $(seq 1 120); do
    if hub_review_ready; then
      return 0
    fi
    sleep 0.5
  done
  echo "ERROR: review session is not bound on the hub; refusing to start Instagram polling." >&2
  echo "Start or restart it with: ./fleet.sh start-review" >&2
  exit 1
}

start_hub() {
  IG_SOURCE=0 ./hub.sh start
  run_window hub "cd '$PWD' && tail -f /tmp/telegram-claude-hub.log"
}

restart_hub() {
  IG_SOURCE=0 ./hub.sh restart
}

start_review() {
  require_env RAFFIN_REVIEW_TELEGRAM_CHAT_ID
  command -v "$CLAUDE_BIN" >/dev/null 2>&1 || { echo "ERROR: $CLAUDE_BIN not found on PATH." >&2; exit 1; }
  run_window review "cd '$PWD' && $KEEP_AWAKE env RAFFIN_SESSION_ROLE=review TELEGRAM_CHAT='$RAFFIN_REVIEW_TELEGRAM_CHAT_ID' '$CLAUDE_BIN' --dangerously-load-development-channels server:raffiny"
}

restart_review() {
  kill_window review
  start_review
}

start_ops() {
  require_env RAFFIN_OPS_TELEGRAM_CHAT_ID
  command -v "$CLAUDE_BIN" >/dev/null 2>&1 || { echo "ERROR: $CLAUDE_BIN not found on PATH." >&2; exit 1; }
  run_window ops "cd '$PWD' && $KEEP_AWAKE env RAFFIN_SESSION_ROLE=ops TELEGRAM_CHAT='$RAFFIN_OPS_TELEGRAM_CHAT_ID' '$CLAUDE_BIN' --dangerously-load-development-channels server:raffiny"
}

restart_ops() {
  kill_window ops
  start_ops
}

start_ig() {
  start_hub
  wait_for_review
  ./hub.sh start-ig
  run_window ig-source "cd '$PWD' && tail -f /tmp/ig-source.log"
}

stop_ig() {
  ./hub.sh stop-ig
  kill_window ig-source
}

restart_ig() {
  stop_ig
  start_ig
}

status_ig() {
  ./hub.sh status-ig
}

start_all() {
  start_hub
  start_review
  start_ops
  if [ "${RAFFIN_START_IG_SOURCE:-0}" = "1" ]; then
    start_ig
  else
    echo "IG feeder not started (RAFFIN_START_IG_SOURCE=0). Use ./fleet.sh start-ig when ready."
  fi
}

stop_all() {
  ./hub.sh stop-ig || true
  ./hub.sh stop || true
  if tmux_has_session; then
    tmux kill-session -t "$SESSION"
  fi
}

status_all() {
  ./hub.sh status
  ./hub.sh status-ig
  if tmux_has_session; then
    echo "tmux session '$SESSION' RUNNING"
    tmux list-windows -t "$SESSION" -F '  #{window_name}'
  else
    echo "tmux session '$SESSION' STOPPED"
  fi
}

case "${1:-}" in
  start) start_all ;;
  stop) stop_all ;;
  status) status_all ;;
  attach) tmux attach -t "$SESSION" ;;
  logs) tail -f /tmp/telegram-claude-hub.log /tmp/ig-source.log ;;
  start-hub) start_hub ;;
  restart-hub) restart_hub ;;
  start-review) start_review ;;
  restart-review) restart_review ;;
  start-ops) start_ops ;;
  restart-ops) restart_ops ;;
  start-ig) start_ig ;;
  stop-ig) stop_ig ;;
  restart-ig) restart_ig ;;
  status-ig) status_ig ;;
  *) usage ;;
esac
