# telegram-claude-agent

A Telegram-connected Claude Code agent built on Claude Code's **channel** protocol.
Same skeleton as the Discord "Argus" agent — the messenger is just an I/O adapter:

```
Telegram ──getUpdates──▶ hub ──WebSocket──▶ channel server (MCP, inside a Claude session)
                                                │  notifications/claude/channel  (wakes Claude)
                                                ▼
                                          Claude session ──reply tool──▶ sendMessage ──▶ Telegram
                                                │
                                                ▼
                                          SQLite (conversation_events)
```

## Files (keep the responsibility boundaries)

- `src/hub.ts` — Telegram Bot API `getUpdates` long-polling loop. Normalizes each
  `message` into a wire event and routes it over WebSocket to the bound session.
  No messenger policy lives here.
- `src/channel.ts` — the MCP **channel server**, one per Claude session. Receives
  hub events, loads recent context, fires `notifications/claude/channel` to wake
  Claude, exposes the `reply` tool (which calls Telegram `sendMessage`), and logs
  in/outbound.
- `src/history.ts` — `bun:sqlite` `conversation_events` table.

## conversation_id

- 1:1 DM → `telegram:chat:<chat_id>`
- group forum topic → `telegram:chat:<chat_id>:thread:<message_thread_id>`

Preserved on every inbound and outbound path.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. `cp .env.example .env` and set `TELEGRAM_BOT_TOKEN`.
3. `bun install`

## Run

For the Raffin deployment, run the role fleet:

```bash
./fleet.sh start       # hub + review Claude + ops Claude
./fleet.sh start-ig    # opt-in Instagram polling when the review channel is ready
./fleet.sh status
```

`RAFFIN_REVIEW_TELEGRAM_CHAT_ID` receives customer-decision work, including
Instagram draft review. `RAFFIN_OPS_TELEGRAM_CHAT_ID` receives program-management
work such as status, logs, restarts, and diagnostics. Instagram polling is not
started by foreground Claude sessions or by `hub.sh start` unless explicitly
requested.

> **⚠️ Breaking change — Instagram intake now requires a `review` session.**
> Instagram customer DMs route **only** to the `review` role session; they never
> fall back to a plain fallback/dedicated session (that would bypass the
> baker-review invariant). With `IG_REQUIRE_REVIEW_SESSION=1` (default), the
> feeder also refuses to read the inbox until a `review` session is bound, so no
> DM is marked "seen" without a place to send it. **A fallback-only deployment
> (`./run.sh` / `bun run hub` with no role session) will stop receiving Instagram
> DMs.** To keep IG intake working, run `./fleet.sh start` (which starts a
> `review` session) and set `RAFFIN_REVIEW_TELEGRAM_CHAT_ID`, then
> `./fleet.sh start-ig`. Telegram messages are unaffected — they still fall back
> when a role session is down.

For local/manual sessions, start the hub (one process):

```bash
bun run hub
```

Start a Claude session bound to a chat (the channel server launches via `.mcp.json`):

```bash
# fallback session: handles every chat with no dedicated session
TELEGRAM_CHAT=* claude --dangerously-load-development-channels server:raffiny

# or a dedicated session for one chat
TELEGRAM_CHAT=<chat_id> claude --dangerously-load-development-channels server:raffiny
```

Then DM the bot, or in a group `@`-mention it / use a `/command`.

## Response policy (`data/config.json`)

- DMs are always answered.
- Groups answer only on bot-mention or a `/command` (`defaultRule: "mention"`).
- Force-on per chat: `{"chatRules": {"<chat_id>": "all"}}`.

## Verify without a real bot

`bun run scripts/verify-roundtrip.ts` mocks the Telegram Bot API, runs the real
hub + real channel server, and drives the channel with an MCP client standing in
for Claude. It asserts the full round-trip and the SQLite inbound/outbound rows.
