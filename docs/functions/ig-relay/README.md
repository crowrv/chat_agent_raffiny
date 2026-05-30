# ig-relay

Single-loop polling worker that watches Instagram DMs through an isolated
headless Chrome and forwards new messages to Discord for review.

See `CLAUDE.md` (this folder) for scope, contract, and safety rules. See the
root `CLAUDE.md` "Browser Automation" section for the headless-vs-real-Chrome
rule.

## Quick start (mock only — no IG account required)

```bash
# 1. start mock IG inbox server (port 8765)
bun features/ig-relay/mock/serve.ts

# 2. start IG-dedicated headless Chrome (port 9334)
features/ig-relay/start-headless.sh

# 3. run the polling worker against the mock
IG_TARGET_URL=http://localhost:8765 bun features/ig-relay/worker.ts

# 4. simulate a new DM
curl -X POST http://localhost:8765/add-message \
  -H 'content-type: application/json' \
  -d '{"thread_id":"t_alice","text":"안녕"}'
```

Within one poll cycle (45s ± 15s) the worker should log the new message and,
if `DISCORD_BOT_TOKEN` + `IG_RELAY_CHANNEL_ID` are set, post it to that channel.

## When the real IG account is warmed up

1. `features/ig-relay/start-headless.sh --gui` — opens non-headless Chrome
   on port 9334 with the dedicated profile so you can log into Instagram
   interactively (2FA / SMS handled by hand). Close the window when done.
2. Re-run `features/ig-relay/start-headless.sh` (no `--gui`) — the cookies
   from step 1 are reused.
3. `IG_TARGET_URL=https://www.instagram.com/direct/inbox/ bun features/ig-relay/worker.ts`

Real IG parsing in `worker.ts` is a stub today (selectors will be filled in
once a logged-in session exists to inspect). The mock path is fully wired.

## Layout

```
features/ig-relay/
├── CLAUDE.md           ← feature scope/contract/safety/verification
├── README.md           ← this file
├── start-headless.sh   ← headless Chrome launcher (port 9334, profile ~/.browser-harness-ig)
├── worker.ts           ← polling worker (single loop, per-thread watermark)
├── db.sqlite           ← runtime: watermarks + seen-message log (gitignored)
└── mock/
    ├── serve.ts        ← Bun HTTP server (port 8765)
    ├── index.html      ← mock IG inbox page
    └── state.json      ← editable seed data
```
