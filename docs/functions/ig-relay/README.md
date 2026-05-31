# ig-relay — Manual Instagram DM Assistant

On-demand helper that reads your Instagram DMs through `browser-harness` and
sends replies you approve. No background process, no Discord, no database.

See `CLAUDE.md` for the full contract, safety rules, and the read→approve→send
flow Claude follows.

## Prerequisites

- `browser-harness` installed and on PATH (`browser-harness --doctor`).
- The dedicated ig-relay Chrome running and logged into Instagram (see Setup).

## Setup (one time)

ig-relay uses a **dedicated, isolated Chrome profile** (`~/.browser-harness-ig`,
port 9334) so it never touches your everyday browsing.

```bash
docs/functions/ig-relay/start-headless.sh --gui   # opens a visible window
# → log into Instagram in that window (handles 2FA). Cookies then persist on disk.
```

Re-run `start-headless.sh` (with or without `--gui`) anytime to bring it back up;
the login is reused until Instagram ends the session.

## Quick start

Run snippets with the `ig.sh` wrapper — it pins browser-harness to the dedicated
profile and errors if that Chrome isn't up.

```bash
# 1. List your DM inbox (rows of name + preview)
docs/functions/ig-relay/ig.sh read_inbox

# 2. Open a conversation by name and read its messages (returns its thread_id)
IG_OPEN="Jane Choi" docs/functions/ig-relay/ig.sh read_inbox
#    …or re-read a known thread by id:
IG_THREAD=<thread_id> docs/functions/ig-relay/ig.sh read_inbox

# 3. Send an approved reply (only after you OK the exact text)
IG_OPEN="Jane Choi" IG_TEXT="your message" docs/functions/ig-relay/ig.sh send_reply
#    …or by id:
IG_THREAD=<thread_id> IG_TEXT="your message" docs/functions/ig-relay/ig.sh send_reply
```

Each snippet prints a `==BH_PAYLOAD==` line followed by one JSON object. Instagram
only reveals a thread id once a conversation is opened, so target by name
(`IG_OPEN`) the first time and reuse the returned `thread_id` afterward.

## Layout

```
docs/functions/ig-relay/
├── CLAUDE.md            ← contract, flow, safety
├── README.md            ← this file
├── ig.sh                ← wrapper: run a snippet against the dedicated profile
├── start-headless.sh    ← isolated Chrome launcher (dedicated profile, port 9334)
└── snippets/
    ├── read_inbox.py    ← list inbox / open+read a thread by name or id (pure read)
    └── send_reply.py    ← send an approved reply (IG_TEXT + IG_OPEN or IG_THREAD)
```
