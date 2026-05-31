#!/usr/bin/env bash
# Run an ig-relay snippet against the DEDICATED, isolated Chrome profile only.
#
# This pins browser-harness to the ig-relay profile (port 9334, BU_NAME=ig) so it
# never touches your everyday Chrome. Set up that profile once with:
#   docs/functions/ig-relay/start-headless.sh --gui   # visible, log in by hand
#   docs/functions/ig-relay/start-headless.sh         # headless, reuses cookies
#
# Usage (snippet name, with or without the .py):
#   docs/functions/ig-relay/ig.sh read_inbox
#   IG_OPEN="Jane Choi" docs/functions/ig-relay/ig.sh read_inbox
#   IG_THREAD=<id> IG_TEXT="hi" docs/functions/ig-relay/ig.sh send_reply
#
# Env overrides: IG_HEADLESS_PORT (default 9334), BU_NAME (default ig).
# Pass-through to the snippets: IG_OPEN, IG_THREAD, IG_TEXT (set them as a prefix).
set -euo pipefail

PORT="${IG_HEADLESS_PORT:-9334}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: ig.sh <read_inbox|send_reply> (IG_OPEN=.. / IG_THREAD=.. / IG_TEXT=.. as a prefix)" >&2
  exit 2
fi

# Resolve the snippet path (accept "read_inbox" or "read_inbox.py").
name="$1"; [[ "$name" == *.py ]] || name="${name}.py"
snippet="$SCRIPT_DIR/snippets/$name"
if [[ ! -f "$snippet" ]]; then
  echo "no such snippet: $snippet" >&2
  echo "available: $(cd "$SCRIPT_DIR/snippets" && ls *.py | tr '\n' ' ')" >&2
  exit 2
fi

# browser-harness must be on PATH (installed to ~/.local/bin by default).
export PATH="$HOME/.local/bin:$PATH"
if ! command -v browser-harness >/dev/null 2>&1; then
  echo "browser-harness not found on PATH. See docs/functions/ig-relay/README.md." >&2
  exit 1
fi

# The dedicated Chrome must already be running on the debug port.
if ! curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "ig-relay Chrome is not up on port ${PORT}." >&2
  echo "Start it first:  $SCRIPT_DIR/start-headless.sh --gui   (then log into Instagram once)" >&2
  exit 1
fi

# Pin browser-harness to the dedicated profile and run the snippet.
export BU_CDP_URL="http://127.0.0.1:${PORT}"
export BU_NAME="${BU_NAME:-ig}"
exec browser-harness < "$snippet"
