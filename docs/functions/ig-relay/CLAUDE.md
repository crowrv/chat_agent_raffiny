# CLAUDE.md

## Scope

This folder owns the **ig-relay** feature: a single-loop polling worker that
watches a logged-in Instagram web session through an isolated headless Chrome
and surfaces new DMs into Discord for review.

It is responsible for:

- Driving an IG-dedicated headless Chrome (port 9334, profile `~/.browser-harness-ig`)
  via `browser-harness`.
- Polling the IG DM inbox (or a local mock) on a jittered interval.
- Maintaining a per-thread watermark so each new message reaches Discord once.
- Forwarding new messages to a Discord channel for the agent to react to.
- A mock IG inbox under `mock/` so the worker can be developed and verified
  without a real Instagram account.

It is **not** responsible for:

- Creating or warming an Instagram account (that is a human task on the mobile app).
- Sending IG replies (a later milestone — current scope is read-only inbound relay).
- Discord routing/reply policy itself (that stays in `src/` and `mcp__argus__reply`).
- Anything driving the user's real Chrome (Way 1) — see root CLAUDE.md
  "Browser Automation" rule.

## Owned Files

- `start-headless.sh`: launches the IG-dedicated headless Chrome on port 9334
  with profile `~/.browser-harness-ig`. Supports `--gui` for the one-time
  interactive login flow.
- `mock/serve.ts`: Bun HTTP server (default port 8765) that serves the mock
  inbox page and a JSON state endpoint. `POST /add-message` appends a fake
  message to simulate a new DM.
- `mock/index.html`: Minimal IG DM inbox lookalike with stable selectors so
  the worker's DOM parsing is exercisable.
- `mock/state.json`: Editable seed data for the mock. Edits show up on the
  next page poll.
- `worker.ts`: The polling worker. Single loop, jittered interval, per-thread
  watermark, push-then-advance semantics. `IG_TARGET_URL` selects mock vs
  real IG.
- `db.sqlite` (runtime, gitignored): per-thread watermarks + seen-message log.

## Contract

Input:

- `IG_TARGET_URL` env (default `http://localhost:8765`) — the page to poll.
- A reachable CDP endpoint on `127.0.0.1:9334` (`start-headless.sh` provides this).
- `DISCORD_BOT_TOKEN` + `IG_RELAY_CHANNEL_ID` env for the actual push (skeleton
  logs only until both are set).

Output:

- One Discord channel message per newly observed IG DM, posted via Discord REST
  by the worker itself (not via `mcp__argus__reply` — the worker is not a
  Claude session). The Argus session that is bound to `IG_RELAY_CHANNEL_ID`
  will then receive it through the normal channel pipeline and decide what to do.

Invariants:

- **Single execution thread.** No async fan-out across IG threads. IG private
  endpoints serialize anyway, and a single loop keeps watermark logic race-free.
- **Per-IG-thread watermark.** Never a global watermark — a stale ts on one
  thread must not mask a new message on another.
- **Push-then-advance.** A thread's watermark only moves after the Discord
  push for that message returns 2xx. On failure: keep watermark, log, retry
  next tick. Reversing this order silently drops messages on transient
  Discord errors.
- **Jittered polling.** `base ± random` seconds, never a fixed metronome.
  Even on the mock, keep the jitter active so behavior matches production.
- **No secrets in logs / DB rows / Discord pushes.** Bot token stays in `.env`.

## Safety

- IG ToS gray zone: this worker is intended to be pointed at a **dedicated**
  Instagram account that the user warmed on the mobile app for 1–2 weeks
  before any automation. Do not point it at a primary account.
- Default `IG_TARGET_URL` is the local mock. Switching to `instagram.com/direct/`
  requires a logged-in `~/.browser-harness-ig` profile and explicit env override.
- The one-time GUI login (`start-headless.sh --gui`) is the only path that
  should ever drive a non-headless Chrome from this feature, and it is meant
  to be run interactively by the human, not autonomously.
- Conservative defaults: 45s ± 15s polling interval, max 50 new messages
  processed per tick (cap to avoid floods on first run against a large inbox).

## Verification

Run:

```bash
bun run typecheck
```

Automated regression — covers every manual curl scenario below (fresh seed
flush, watermark dedup, /add-message push, /set-state challenge + recovery,
cdp_down sentinel) in ~6 seconds without needing real Chrome or Instagram:

```bash
bun test features/ig-relay/worker.test.ts
```

The test injects a fake browser-harness via `BH_BIN`
(`test-helpers/bh-stub.sh`) that reads the mock's `/state` directly, so the
worker, mock server, and sentinel paths all run as-is. Use the manual smoke
test below when changing the actual `browser-harness` invocation, DOM
selectors, or anything the stub doesn't cover.

Feature-specific smoke test (mock-only, no IG account required):

```bash
# Terminal 1: mock server
bun features/ig-relay/mock/serve.ts

# Terminal 2: headless Chrome on 9334
features/ig-relay/start-headless.sh

# Terminal 3: worker pointed at mock (no Discord push yet — log-only)
IG_TARGET_URL=http://localhost:8765 bun features/ig-relay/worker.ts
```

Then, in a 4th terminal:

```bash
curl -X POST http://localhost:8765/add-message \
  -H 'content-type: application/json' \
  -d '{"thread_id":"t_alice","text":"새 메시지!"}'
```

Runtime verification is complete only when:

- Worker logs "new message m_xxx on thread t_alice" within one poll cycle of
  the curl above.
- A second curl with the same payload **does not** re-trigger a log line
  (idempotency via watermark).
- Killing the mock server mid-poll does not crash the worker — it just logs
  the navigation failure and retries on the next tick.
- With `DISCORD_BOT_TOKEN` + `IG_RELAY_CHANNEL_ID` set, a new mock message
  produces exactly one Discord channel post.

## Sentinels

The worker emits sentinels for conditions that would otherwise cause silent
inbound-message loss:

- `cdp_down`: scrape failed `IG_SCRAPE_FAIL_ALERT` ticks in a row. The
  per-scrape timeout `IG_SCRAPE_TIMEOUT_S` exists because `browser-harness`
  hangs (rather than failing fast) when its CDP endpoint is unreachable —
  without the timeout the worker would just go quiet.
- `page_<status>`: the inbox probe returned a non-`ok` page status for
  `IG_STATUS_FAIL_ALERT` ticks in a row. Status is one of `auth_required`,
  `challenge`, `two_factor`, `unknown_layout`. **Watermarks never advance**
  while the page status is non-ok, so recovery does not lose messages.

Detection markers:

- URL-based (real IG): `/accounts/login`, `/login/`, `/challenge`,
  `/two_factor`, `/2fa`.
- DOM marker (mock): an element carrying `[data-ig-sim-state="<state>"]`.
  The mock mounts this overlay when `mock/state.json#sim_state` is non-ok.
- `unknown_layout` fires when the probe found `ok` status, zero threads, AND
  the inbox anchor `[data-thread-list]` is missing — i.e. we're on some page
  the selectors do not recognize.

Sentinels go to `IG_OPS_CHANNEL_ID` if `DISCORD_BOT_TOKEN` is set, otherwise
they only print to the worker log. Repeated sentinels of the same kind are
throttled by `IG_SENTINEL_THROTTLE_S` (the per-tick `[page-status #N]` /
`[scrape-fail #N]` lines remain so operators can see the ongoing condition).

Smoke test (mock, four sentinel paths):

```bash
# Toggle a challenge state — expect [sentinel:page_challenge] after IG_STATUS_FAIL_ALERT ticks.
curl -X POST http://localhost:8765/set-state -H 'content-type: application/json' \
  -d '{"sim_state":"challenge"}'

# Recover — expect counter to reset and pushes to resume on the next tick.
curl -X POST http://localhost:8765/set-state -H 'content-type: application/json' \
  -d '{"sim_state":"ok"}'

# Point at an unreachable CDP — expect [sentinel:cdp_down] after IG_SCRAPE_FAIL_ALERT
# ticks (each tick will hit IG_SCRAPE_TIMEOUT_S before the failure registers).
BU_CDP_URL=http://127.0.0.1:9999 IG_SCRAPE_TIMEOUT_S=4 bun features/ig-relay/worker.ts
```

## Failure Modes

- `CDP not reachable on 9334`: `start-headless.sh` not running, or another
  process has the port. Run the launcher.
- `browser-harness: command not found`: per global SKILL.md, browser-harness
  is expected on `$PATH`. Install per its install.md.
- `IG login challenge / 2FA page`: the headless profile lost its session.
  Re-run `start-headless.sh --gui` and complete the login by hand.
- Worker keeps re-pushing the same message: Discord push is returning non-2xx
  (check token / channel id / channel permissions). Watermark intentionally
  does not advance until push succeeds.
- DOM parser returns empty thread list against real IG: IG redesigned the
  inbox page. Update the selectors in `worker.ts`'s `extractInbox()` block.
  Mock still works in the meantime.
