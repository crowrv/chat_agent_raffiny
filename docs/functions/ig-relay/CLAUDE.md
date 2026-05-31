# CLAUDE.md — ig-relay (Manual IG DM Assistant)

## Scope

This folder owns a **manual, on-demand Instagram DM assistant**. There is no
background process. When the user asks (e.g. "any new IG DMs?"), Claude:

1. Reads the user's Instagram DMs live through `browser-harness`.
2. Summarizes them and helps draft replies in chat.
3. Sends a reply back to Instagram **only after the user explicitly approves the
   exact text** for a specific thread.

It is **not** responsible for: background polling, notifications, Discord or any
other transport, bulk/unsolicited messaging, or creating/warming IG accounts.

## Owned Files

- `snippets/read_inbox.py`: browser-harness snippet (pure read). Modes:
  - default → list the inbox as `rows` of `{ name, preview, x, y }`.
  - `IG_OPEN="<name>"` → click the inbox row whose name contains `<name>` and read
    that conversation's recent `messages` (also returns its `thread_id`).
  - `IG_THREAD=<id|url>` → open a known thread directly and read its `messages`.
  Emits JSON after a `==BH_PAYLOAD==` marker:
  `{ page_status, page_url, page_title, mode, thread_id, rows, messages }`.
  Note: Instagram does NOT expose a thread id in the inbox list — you only get a
  `thread_id` after opening a thread (by name the first time, by id thereafter).
- `snippets/send_reply.py`: browser-harness snippet. Requires `IG_TEXT` plus one of
  `IG_OPEN="<name>"` or `IG_THREAD=<id|url>`. Opens the thread, inserts the text via
  `type_text` (Input.insertText — inserts once; per-key typing double-types Korean),
  presses Enter, reports `{ status, detail, thread_id }` where status is
  `sent | uncertain | error`. Run ONLY after user approval.
- `start-headless.sh`: isolated Chrome launcher (port 9334, profile
  `~/.browser-harness-ig`, `--gui` for one-time login). The Phase-2 path for a
  dedicated account.

## The Flow

1. **Read the inbox.** `browser-harness < snippets/read_inbox.py`. Parse the JSON
   after `==BH_PAYLOAD==`. If `page_status` is not `ok`, do NOT guess — tell the
   user to log in (Phase 1: in their Chrome; Phase 2: `start-headless.sh --gui`).
2. **Summarize** the `rows` (name + preview) in chat. Let the user pick one.
3. **Read the thread** with `IG_OPEN="<name>" browser-harness < snippets/read_inbox.py`
   to open it by name and see recent `messages` (the output's `thread_id` is the
   stable id you can reuse with `IG_THREAD=<id>` afterward). Draft a reply together.
4. **Approval gate.** Show the user the EXACT reply text and the target thread.
   Wait for an explicit "send". Never auto-send.
5. **Send.** `IG_OPEN="<name>" IG_TEXT="<approved text>" browser-harness < snippets/send_reply.py`
   (or `IG_THREAD=<id> IG_TEXT=...` if you already have the id).
6. **Confirm** by re-reading the thread (step 3, by `IG_THREAD=<id>`) and checking
   the message appears correctly. Never assume a send worked from `status` alone.

## Browser Configuration

- **Phase 1 (current — testing):** the default `browser-harness` connection =
  the user's real everyday Chrome (Way 1). No `start-headless.sh` needed. Make
  sure they're logged into Instagram in that Chrome.
- **Phase 2 (later — dedicated account):** `start-headless.sh --gui` once to log
  in, then `start-headless.sh` (headless). Point the snippets at it by exporting
  `BU_CDP_URL=http://127.0.0.1:9334` and `BU_NAME=ig` before each
  `browser-harness` call. The snippets are identical across phases.

## Safety & Rules

| Rule | Detail |
|------|--------|
| ✅ Reading is free | Reading DMs needs no approval. |
| ✅ Sending needs per-message approval | Always show exact text + target thread; wait for explicit "send". Never auto-reply. |
| ❌ No bulk / unsolicited DMs | Only reply to existing threads the user points at. One message at a time. |
| ✅ Confirm by re-reading | A send is confirmed only when the message appears in the thread on re-read. |
| ✅ Stop on auth walls | If `page_status` is `auth_required`/`challenge`/`two_factor`, stop and ask the user to log in. Don't type credentials. |
| ❌ No secrets in output | Never print cookies/tokens/credentials. |

## Verification

`browser-harness --doctor` should show `chrome running`. Then:

```bash
# list the inbox
browser-harness < docs/functions/ig-relay/snippets/read_inbox.py

# open a conversation by name and read its messages (returns its thread_id)
IG_OPEN="Jane Choi" browser-harness < docs/functions/ig-relay/snippets/read_inbox.py

# re-read a known thread by id
IG_THREAD=<id> browser-harness < docs/functions/ig-relay/snippets/read_inbox.py
```

A send is verified end-to-end only with the user present: after an approved
`send_reply.py` run, re-read the thread and confirm the message appears correctly
(watch for garbled/doubled text). IG's DOM is obfuscated and changes over time — if
`read_inbox.py` returns `unknown_layout`/empty `rows`, or `send_reply.py` reports
`uncertain`, inspect the live page with `capture_screenshot()` and `js(...)` and
update the selectors in the snippets. A `capture_screenshot()` before reading row
geometry is required — background tabs report zero-height rects and the row filter
drops everything.
