# CLAUDE.md — ig-relay (Manual IG DM Assistant)

## Scope

This folder owns an **auto-polling Instagram DM intake with baker-reviewed replies**.

- **Inbound is automated.** The hub feeder (`src/ig-source.ts`) polls the IG inbox
  on an interval and pushes each new inbound DM into the hub, which routes it to a
  Claude session — the same path Telegram messages take. Reading needs no approval.
- **Replies are baker-reviewed, never auto-sent.** For each IG DM the session drafts
  a suggested reply in Raffin's voice, forwards the customer's message + the draft to
  the **baker's Telegram** for review, and sends to Instagram **only after the baker
  approves** the exact text (via `ig.sh send_reply`).

It is **not** responsible for: auto-replying to Instagram, bulk/unsolicited
messaging, Discord or any other transport, or creating/warming IG accounts.

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

## The Flow (auto-poll → baker review → approved send)

Inbound is automated by `src/ig-source.ts`; the session handles draft + send.
Paths below are relative to repo root. Run snippets via `ig.sh` (it pins to the
dedicated profile).

1. **Auto-poll (inbound).** `src/ig-source.ts` runs `ig.sh read_inbox` every
   `IG_POLL_SECONDS` (default 120s) and POSTs each NEW inbound row to the hub's
   `/ingest` as `platform: "instagram"`, `conversation_id: instagram:thread:<name>`.
   The bound Claude session receives it (content prefixed `📷 Instagram DM from "<name>"`).
   If `read_inbox` returns `page_status != ok`, the feeder skips that cycle — the
   session needs attention (re-run `start-headless.sh --gui` and log in).
2. **Read the full thread** for context:
   `IG_OPEN="<name>" docs/functions/ig-relay/ig.sh read_inbox`
   (returns recent `messages` plus the stable `thread_id` to reuse with `IG_THREAD=<id>`).
3. **Draft + forward to the baker.** Draft a suggested reply in Raffin's voice
   (grounded in the knowledge sources), then forward it to the **baker's Telegram**
   (chat `BAKER_TELEGRAM_CHAT_ID`) with the channel `reply` tool — include the
   sender name, the customer's message, and your suggested reply, and ask the baker
   to **approve, edit, or skip**.
4. **Baker reviews on Telegram.** Approve as-is, send an edited version, or skip.
5. **Send to Instagram (approved only).** On approve/edit, post the final text:
   `IG_OPEN="<name>" IG_TEXT="<approved text>" docs/functions/ig-relay/ig.sh send_reply`
   (or `IG_THREAD=<id> IG_TEXT=...`). On skip, do nothing. Never send without the
   baker's explicit approval.
6. **Confirm** by re-reading the thread (`IG_THREAD=<id> ig.sh read_inbox`) and
   checking the message appears correctly. Never assume a send worked from `status` alone.

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
| ✅ Reading is free & auto-polled | Inbound reading needs no approval; `src/ig-source.ts` polls it automatically. |
| ✅ Sending needs baker approval | Forward the message + suggested reply to the baker's Telegram; send to IG only after the baker approves the exact text. Never auto-reply. |
| ❌ No bulk / unsolicited DMs | Only reply to existing threads, one message at a time, after baker approval. |
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
