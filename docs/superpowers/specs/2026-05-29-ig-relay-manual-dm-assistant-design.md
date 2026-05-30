# ig-relay Redesign — Manual IG DM Assistant

**Feature folder:** `docs/functions/ig-relay/`
**Date:** 2026-05-29
**Status:** Design approved, pending spec review.

---

## Context

The original `ig-relay` was an always-on polling worker that watched an Instagram
DM inbox through an isolated headless Chrome and forwarded new messages into a
Discord channel, where a long-running agent ("Argus") session read them and
(in a future milestone) replied. The whole transport and interaction model was
built around Discord.

**The user does not use Discord.** They want to drop Discord entirely and instead
handle Instagram DMs directly inside an interactive Claude session: when they ask,
Claude opens Instagram live in the browser via `browser-harness`, reads their DMs,
helps draft replies, and — after explicit per-message approval — sends those
replies back on Instagram.

This collapses the feature from an autonomous background service into a **manual,
on-demand, human-in-the-loop assistant**. Most of the existing code (polling loop,
watermarks, local db, mock server, Discord push, sentinels, tests) exists only to
support unattended polling and Discord delivery, and is therefore removed.

The intended outcome: a small, reliable, manual read-and-reply workflow with a
hard approval gate before anything is sent to Instagram.

---

## Scope

### Removed (all Discord / unattended-automation machinery)

| Path | Why removed |
|------|-------------|
| `worker.ts` | Polling loop, per-thread watermarks, push-then-advance, sentinels — all serve unattended polling + Discord push. |
| `worker.test.ts` | Tests the removed worker. |
| `mock/` (`serve.ts`, `index.html`, `state.json`) | Fake inbox built to exercise the removed worker without a real account. |
| `test-helpers/` (`bh-stub.sh`, `bh-stub.ts`, `seed-state.json`) | browser-harness stub for the removed tests. |
| `db.sqlite` | Watermark + seen-message store; manual mode has no watermark concept. |
| `DESIGN.md` | Specs the Discord routing + bidirectional-sync milestone, now obsolete. |

All Discord references (`DISCORD_BOT_TOKEN`, `IG_RELAY_CHANNEL_ID`,
`IG_OPS_CHANNEL_ID`, REST pushes, sentinel posts) are deleted.

### Kept

| Path | Role |
|------|------|
| `start-headless.sh` | Unchanged. Isolated Chrome launcher (port 9334, profile `~/.browser-harness-ig`, `--gui` for one-time login). The Phase-2 path for a dedicated Instagram account. |

### Added

| Path | Role |
|------|------|
| `snippets/read_inbox.py` | browser-harness Python snippet: navigate to `https://www.instagram.com/direct/inbox/`, read the thread list and each thread's recent messages, print JSON on stdout behind a `==BH_PAYLOAD==` marker. Selectors filled in live on first real run. |
| `snippets/send_reply.py` | browser-harness Python snippet: open a specified thread, type a given message, send it. Run only after user approval. Selectors filled in live. |

### Rewritten

| Path | Change |
|------|--------|
| `CLAUDE.md` | New scope (manual read+send assistant), the flow, safety + approval rules, how to switch between real Chrome and the dedicated headless profile. |
| `README.md` | New quick-start for the manual flow. |

---

## Architecture

There is **no long-running process.** The feature is a documented procedure plus
two reusable browser-harness snippets that an interactive Claude session invokes
on demand. `browser-harness` is the only runtime dependency (already installed at
`~/.local/bin/browser-harness`).

```
User (in Claude chat)
  → Claude runs snippets/read_inbox.py via browser-harness
      → Chrome (real, or dedicated headless on 9334) → instagram.com/direct/inbox/
      → JSON of threads + recent messages back to Claude
  → Claude summarizes DMs in chat; user picks a thread, drafts a reply together
  → APPROVAL GATE: Claude shows exact text + target thread; waits for explicit "send"
  → Claude runs snippets/send_reply.py via browser-harness → message sent on IG
  → Claude re-reads the thread to confirm the reply landed
```

### Components

- **`read_inbox.py`** — pure read. Input: none (defaults to the IG inbox URL).
  Output: JSON `{ threads: [{ thread_id, user_name, user_full_name, url,
  messages: [{ from, text, ts? }] }] }`. Depends on: a logged-in IG session in
  the connected Chrome. No writes, no side effects.
- **`send_reply.py`** — write action. Input (via env or argv): target thread
  identifier (thread URL or user handle) and the message text. Output: success/
  failure sentinel. Depends on: a logged-in IG session and a valid thread target.
- **`CLAUDE.md`** — the contract: how Claude runs the snippets, the approval gate,
  safety rules, and browser-config switching.

These are independently understandable: a reader can see what each snippet does,
how to call it, and what it depends on, without reading the others.

---

## Browser Configuration

- **Phase 1 (testing, now):** use the default `browser-harness` connection = the
  user's real everyday Chrome (Way 1, already connected and verified). No
  `start-headless.sh` required. The user explicitly chose to start here and
  revisit the account question after functionality is confirmed.
- **Phase 2 (later, optional):** switch to a dedicated Instagram account in the
  isolated headless Chrome: run `start-headless.sh --gui` once to log in, then
  `start-headless.sh` (headless), and point the snippets at it with
  `BU_CDP_URL=http://127.0.0.1:9334` and `BU_NAME=ig`. The snippets are identical
  across both phases — only the CDP endpoint changes.

---

## Safety & Approval Rules (documented in CLAUDE.md)

- **Reading is free; sending always requires explicit, per-message user approval.**
  Claude never auto-replies and never sends without showing the exact text and
  target thread first.
- **No bulk sending and no unsolicited DMs.** Only replies to existing threads the
  user explicitly points at.
- **Human-paced volume.** The user reviews one message at a time; no batch loops.
- **IG ToS awareness.** Instagram automation is a gray zone. Manual, low-volume,
  human-approved replies keep risk low. Phase 2's dedicated-account path exists for
  users who want to isolate this from their primary account.
- **No secrets in snippet output or logs.**

---

## Error Handling

- **Not logged in / challenge / 2FA page:** `read_inbox.py` detects a non-inbox
  page (login/challenge/2FA URL markers or missing inbox anchor) and returns a
  clear status instead of empty data. Claude tells the user to log in (Phase 1:
  in their Chrome; Phase 2: re-run `start-headless.sh --gui`) rather than guessing.
- **`browser-harness` not reachable / Chrome not running:** the snippet errors;
  Claude surfaces the harness error and points to `browser-harness --doctor`.
- **Send fails (selector miss / send button absent):** `send_reply.py` returns a
  failure sentinel; Claude reports it did NOT send, and does not retry blindly.
  Confirmation is always by re-reading the thread, never assumed.

---

## Verification

The first real run is a **discovery session** (no real IG selectors exist yet):

1. With the user logged into Instagram in the connected Chrome, run `read_inbox.py`.
   Inspect the live DM DOM via `browser-harness`, fill in selectors until it
   returns the user's real threads and latest messages correctly as JSON.
2. Confirm the not-logged-in / challenge detection by checking the status branch
   (e.g., when viewing IG while logged out).
3. Draft a reply to a thread the user chooses. After explicit approval, run
   `send_reply.py` to send one message.
4. Confirm end-to-end: re-read the thread and verify the sent message appears.
5. No duplicate send: re-running is gated by the user, not automated, so there is
   no watermark to verify — confirmation is purely "the message appears once in
   the thread."

Done when: `read_inbox.py` reliably returns real threads, the approval gate works,
and one approved reply is confirmed delivered by re-reading the thread.

---

## Out of Scope (YAGNI)

- No background polling, notifications, or scheduling.
- No local database, watermarks, or dedup state.
- No mock server or automated test harness (the flow is interactive and
  browser-dependent; verification is the live discovery session above).
- No Discord or any other external transport.
