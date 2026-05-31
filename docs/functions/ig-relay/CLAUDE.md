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
- `ig.sh`: **the standard way to run the snippets.** Pins browser-harness to the
  dedicated isolated profile (port 9334, `BU_NAME=ig`) so ig-relay never touches
  the everyday Chrome, errors clearly if that Chrome isn't up, and passes through
  `IG_OPEN`/`IG_THREAD`/`IG_TEXT`. Usage: `ig.sh read_inbox`, `ig.sh send_reply`.
- `start-headless.sh`: isolated Chrome launcher (port 9334, profile
  `~/.browser-harness-ig`, `--gui` for a visible window / one-time login).

## The Flow

Run snippets via `ig.sh` (it pins to the dedicated profile). Paths below are
relative to this folder.

1. **Read the inbox.** `ig.sh read_inbox`. Parse the JSON after `==BH_PAYLOAD==`.
   If `page_status` is not `ok`, do NOT guess — the session needs attention
   (re-run `start-headless.sh --gui` and log in).
2. **Summarize** the `rows` (name + preview) in chat. Let the user pick one.
3. **Read the thread** with `IG_OPEN="<name>" ig.sh read_inbox` to open it by name
   and see recent `messages` (the output's `thread_id` is the stable id you can
   reuse with `IG_THREAD=<id>` afterward). Draft a reply together.
4. **Approval gate.** Show the user the EXACT reply text and the target thread.
   Wait for an explicit "send". Never auto-send.
5. **Send.** `IG_OPEN="<name>" IG_TEXT="<approved text>" ig.sh send_reply`
   (or `IG_THREAD=<id> IG_TEXT=...` if you already have the id).
6. **Confirm** by re-reading the thread (step 3, by `IG_THREAD=<id>`) and checking
   the message appears correctly. Never assume a send worked from `status` alone.

## Browser Configuration

**Default: a dedicated isolated profile** (`~/.browser-harness-ig`, port 9334),
kept separate from the everyday Chrome. `ig.sh` always targets it; it never drives
the user's main browser. Setup:

1. `start-headless.sh --gui` — opens a visible window on the dedicated profile.
2. Get Instagram logged in there, EITHER:
   - log in by hand in that window (handles 2FA), or
   - transfer the session cookies from an already-logged-in Chrome via CDP
     (`Storage.getCookies` on the source → `Network.setCookies` on port 9334).
     Route cookie values through a temp file, never into chat; delete it after.
3. Cookies persist in the profile dir, so later runs reuse the login until IG
   ends the session (logout / password change / checkpoint → re-run `--gui`).

**Fallback (everyday Chrome / "Way 1"):** running `browser-harness < snippets/...`
WITHOUT `ig.sh` (no `BU_CDP_URL`) targets whatever Chrome has remote debugging on.
Use only for quick tests; it is not isolated from the user's browsing.

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

Make sure the dedicated Chrome is up (`start-headless.sh`), then:

```bash
# list the inbox
docs/functions/ig-relay/ig.sh read_inbox

# open a conversation by name and read its messages (returns its thread_id)
IG_OPEN="Jane Choi" docs/functions/ig-relay/ig.sh read_inbox

# re-read a known thread by id
IG_THREAD=<id> docs/functions/ig-relay/ig.sh read_inbox
```

A send is verified end-to-end only with the user present: after an approved
`send_reply.py` run, re-read the thread and confirm the message appears correctly
(watch for garbled/doubled text). IG's DOM is obfuscated and changes over time — if
`read_inbox.py` returns `unknown_layout`/empty `rows`, or `send_reply.py` reports
`uncertain`, inspect the live page with `capture_screenshot()` and `js(...)` and
update the selectors in the snippets. A `capture_screenshot()` before reading row
geometry is required — background tabs report zero-height rects and the row filter
drops everything.
