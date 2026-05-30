# ig-relay — Manual Instagram DM Assistant

On-demand helper that reads your Instagram DMs through `browser-harness` and
sends replies you approve. No background process, no Discord, no database.

See `CLAUDE.md` for the full contract, safety rules, and the read→approve→send
flow Claude follows.

## Prerequisites

- `browser-harness` installed and on PATH (`browser-harness --doctor`).
- Chrome running and logged into Instagram (Phase 1 uses your everyday Chrome).

## Quick start

```bash
# 1. Read your DM inbox (thread list + previews)
browser-harness < docs/functions/ig-relay/snippets/read_inbox.py

# 2. Read one conversation's recent messages
IG_THREAD=<thread_id> browser-harness < docs/functions/ig-relay/snippets/read_inbox.py

# 3. Send an approved reply (only after you OK the exact text)
IG_THREAD=<thread_id> IG_TEXT="your message" browser-harness < docs/functions/ig-relay/snippets/send_reply.py
```

Each snippet prints a `==BH_PAYLOAD==` line followed by one JSON object.

## Dedicated account (later)

To isolate this from your primary Instagram, switch to a dedicated account in an
isolated headless Chrome:

```bash
docs/functions/ig-relay/start-headless.sh --gui   # one-time: log in by hand
docs/functions/ig-relay/start-headless.sh         # headless, reuses cookies
export BU_CDP_URL=http://127.0.0.1:9334 BU_NAME=ig
# then run the same snippets above
```

## Layout

```
docs/functions/ig-relay/
├── CLAUDE.md            ← contract, flow, safety
├── README.md            ← this file
├── start-headless.sh    ← isolated Chrome launcher (dedicated-account path)
└── snippets/
    ├── read_inbox.py    ← read inbox / one thread (pure read)
    └── send_reply.py    ← send an approved reply (requires IG_THREAD + IG_TEXT)
```
