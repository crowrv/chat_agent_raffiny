#!/usr/bin/env bash
# Launch the IG-dedicated headless Chrome on port 9334 with profile
# ~/.browser-harness-ig. Separate from scripts/browser-harness-headless.sh
# (port 9333, empty profile) so the IG-logged-in session stays isolated and
# does not contaminate other automation.
#
# Pass --gui to launch the same profile *with* a visible window — used once
# to log into Instagram by hand (so 2FA / SMS / challenges can be solved).
# Close the window when done; cookies persist on disk.
#
# Idempotent: if CDP already answers on the port, exits 0 silently.
#
# Usage:
#   features/ig-relay/start-headless.sh           # headless, automation use
#   features/ig-relay/start-headless.sh --gui     # visible, one-time login
#   BU_CDP_URL=http://127.0.0.1:9334 BU_NAME=ig browser-harness -c '...'
#
# Env overrides: IG_HEADLESS_PORT, IG_HEADLESS_PROFILE, BH_CHROME.
set -euo pipefail

PORT="${IG_HEADLESS_PORT:-9334}"
PROFILE="${IG_HEADLESS_PROFILE:-$HOME/.browser-harness-ig}"

GUI=0
for arg in "$@"; do
  case "$arg" in
    --gui) GUI=1 ;;
    -h|--help)
      sed -n '1,18p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

find_chrome() {
  if [[ -n "${BH_CHROME:-}" ]]; then printf '%s' "$BH_CHROME"; return 0; fi
  local app_candidates=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  )
  local c
  for c in "${app_candidates[@]}"; do
    [[ -x "$c" ]] && { printf '%s' "$c"; return 0; }
  done
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  return 1
}

if curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "ig chrome already up on ${PORT}"
  exit 0
fi

CHROME="$(find_chrome)" || {
  echo "no Chrome/Chromium found; set BH_CHROME=<path>" >&2
  exit 1
}

mkdir -p "$PROFILE"

if [[ $GUI -eq 1 ]]; then
  echo "launching IG profile with GUI (one-time login). Close the window when done."
  "$CHROME" --remote-debugging-port="$PORT" \
    --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
    https://www.instagram.com/accounts/login/ \
    >/tmp/ig-chrome.log 2>&1 &
  echo "pid=$! on ${PORT} (GUI)"
else
  "$CHROME" --headless=new --remote-debugging-port="$PORT" \
    --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
    >/tmp/ig-chrome.log 2>&1 &
  echo "launched ig headless chrome pid=$! on ${PORT}"
fi

for _ in $(seq 1 20); do
  if curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "CDP ready on ${PORT}"
    exit 0
  fi
  sleep 0.5
done

echo "CDP did not come up on ${PORT} (see /tmp/ig-chrome.log)" >&2
exit 1
