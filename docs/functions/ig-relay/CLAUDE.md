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

- `snippets/read_inbox.py`: browser-harness snippet. Default = read inbox thread
  list + previews. With `IG_THREAD=<id|url>` = read one thread's recent messages.
  Pure read, no side effects. Emits JSON after a `==BH_PAYLOAD==` marker.
- `snippets/send_reply.py`: browser-harness snippet. Requires `IG_THREAD` and
  `IG_TEXT`. Opens the thread, types via CDP, presses Enter, reports whether the
  composer cleared. Run ONLY after user approval.
- `start-headless.sh`: isolated Chrome launcher (port 9334, profile
  `~/.browser-harness-ig`, `--gui` for one-time login). The Phase-2 path for a
  dedicated account.

## The Flow

1. **Read.** `browser-harness < snippets/read_inbox.py`. Parse the JSON after
   `==BH_PAYLOAD==`. If `page_status` is not `ok`, do NOT guess — tell the user
   to log in (Phase 1: in their Chrome; Phase 2: `start-headless.sh --gui`).
2. **Summarize** the threads/messages in chat. Let the user pick one.
3. **Read the thread** with `IG_THREAD=<id> browser-harness < snippets/read_inbox.py`
   to see recent messages, then draft a reply together.
4. **Approval gate.** Show the user the EXACT reply text and the target thread.
   Wait for an explicit "send". Never auto-send.
5. **Send.** `IG_THREAD=<id> IG_TEXT="<approved text>" browser-harness < snippets/send_reply.py`.
6. **Confirm** by re-reading the thread (step 3) and checking the message appears.
   Never assume a send worked from `status` alone.

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
# read the inbox
browser-harness < docs/functions/ig-relay/snippets/read_inbox.py

# read one thread (replace <id> with a thread_id from the inbox output)
IG_THREAD=<id> browser-harness < docs/functions/ig-relay/snippets/read_inbox.py
```

A send is verified end-to-end only with the user present: after an approved
`send_reply.py` run, re-read the thread and confirm the message appears exactly
once. IG's DOM is obfuscated and changes over time — if `read_inbox.py` returns
`unknown_layout` or `send_reply.py` reports `uncertain`, inspect the live page
with `capture_screenshot()` and `js(...)` and update the selectors in the
snippets.
