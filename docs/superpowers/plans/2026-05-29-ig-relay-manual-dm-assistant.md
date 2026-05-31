# ig-relay Manual DM Assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Discord-based, always-on ig-relay polling worker with a manual, human-in-the-loop assistant: Claude reads Instagram DMs live via `browser-harness` and sends replies only after explicit per-message approval.

**Architecture:** No long-running process. The feature is a documented procedure (`CLAUDE.md`) plus two reusable `browser-harness` Python snippets — `read_inbox.py` (pure read) and `send_reply.py` (approved send). `browser-harness` is the only runtime dependency. Reading uses `js()` DOM extraction against stable anchors; sending types via CDP `Input.insertText` + Enter.

**Tech Stack:** `browser-harness` (Python CDP harness, installed at `~/.local/bin/browser-harness`), Chrome, Instagram web.

**Important — no automated test suite:** This feature drives a real browser against a live, logged-in Instagram session. There is no mock and no CI-runnable test (that machinery is being deleted). "Verification" for each snippet means *running it via `browser-harness` and observing the JSON/behavior*, and the final task is an interactive live discovery+verification session with the user present. Do not fabricate a unit-test harness.

**Spec:** `docs/superpowers/specs/2026-05-29-ig-relay-manual-dm-assistant-design.md`

**Feature folder:** `docs/functions/ig-relay/` (note: NOT `features/ig-relay/` — the old docs used that path; the real path in this repo is `docs/functions/ig-relay/`).

---

### Task 1: Remove Discord / unattended-automation machinery

Delete every file that exists only to support background polling and Discord delivery. Keep `start-headless.sh`.

**Files:**
- Delete: `docs/functions/ig-relay/worker.ts`
- Delete: `docs/functions/ig-relay/worker.test.ts`
- Delete: `docs/functions/ig-relay/mock/` (serve.ts, index.html, state.json)
- Delete: `docs/functions/ig-relay/test-helpers/` (bh-stub.sh, bh-stub.ts, seed-state.json)
- Delete: `docs/functions/ig-relay/db.sqlite`
- Delete: `docs/functions/ig-relay/DESIGN.md`
- Keep: `docs/functions/ig-relay/start-headless.sh`
- Keep (rewritten later): `CLAUDE.md`, `README.md`

- [ ] **Step 1: Delete the files**

```bash
cd /Users/siyoung/Documents/git-local-repo
git rm docs/functions/ig-relay/worker.ts \
       docs/functions/ig-relay/worker.test.ts \
       docs/functions/ig-relay/DESIGN.md \
       docs/functions/ig-relay/db.sqlite
git rm -r docs/functions/ig-relay/mock docs/functions/ig-relay/test-helpers
```

(If `db.sqlite` is untracked/gitignored, `git rm` may warn — in that case run `rm -f docs/functions/ig-relay/db.sqlite`.)

- [ ] **Step 2: Verify only the intended files remain**

Run: `ls -A docs/functions/ig-relay/`
Expected: `CLAUDE.md  README.md  start-headless.sh` (and nothing else — no `mock/`, `test-helpers/`, `worker.ts`, `worker.test.ts`, `db.sqlite`, `DESIGN.md`).

- [ ] **Step 3: Commit**

```bash
git commit -m "Remove ig-relay Discord worker, mock, tests, and db

Manual-assistant redesign drops unattended polling and Discord delivery.
start-headless.sh kept for the future dedicated-account path."
```

---

### Task 2: Create `read_inbox.py` snippet

A `browser-harness` snippet that reads the IG inbox (thread list + previews) or, when `IG_THREAD` is set, one thread's recent messages. Prints JSON after a `==BH_PAYLOAD==` marker so Claude can parse stdout the same way the old worker did.

**Files:**
- Create: `docs/functions/ig-relay/snippets/read_inbox.py`

- [ ] **Step 1: Create the snippet file**

```python
# read_inbox.py — browser-harness snippet (pure read; no side effects).
#
# Modes:
#   (default)            read the DM inbox: thread list + preview line per thread
#   IG_THREAD=<id|url>   read ONE thread's recent messages
#
# Run:
#   browser-harness < docs/functions/ig-relay/snippets/read_inbox.py
#   IG_THREAD=<thread_id> browser-harness < docs/functions/ig-relay/snippets/read_inbox.py
#
# Output: a line "==BH_PAYLOAD==" followed by one JSON object:
#   { page_status, page_detail, page_url, page_title, mode, threads, messages }
# page_status is one of: ok | auth_required | challenge | two_factor | unknown_layout
import json, os

THREAD = os.environ.get("IG_THREAD", "").strip()

if THREAD:
    target = THREAD if THREAD.startswith("http") \
        else "https://www.instagram.com/direct/t/" + THREAD.strip("/") + "/"
else:
    target = "https://www.instagram.com/direct/inbox/"

new_tab(target)
wait_for_load()

# Status probe sets a window global both extraction blocks read.
js("""
  const url = location.href;
  let status='ok', detail='';
  if (url.includes('/accounts/login') || /\\/login(\\/|$|\\?)/.test(url)) { status='auth_required'; detail='login url'; }
  else if (url.includes('/challenge')) { status='challenge'; detail='challenge url'; }
  else if (url.includes('/two_factor') || url.includes('/2fa')) { status='two_factor'; detail='2fa url'; }
  window.__ig = { status, detail, url, title: document.title };
""")

INBOX_JS = """
  const seen = new Set(), threads = [];
  for (const a of document.querySelectorAll('a[href^="/direct/t/"]')) {
    const href = a.getAttribute('href');
    const id = (href.match(/\\/direct\\/t\\/([^/]+)/) || [])[1] || '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const lines = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    threads.push({ thread_id: id, url: href, user_full_name: lines[0] || '', preview: lines.slice(1).join(' ') });
  }
  const s = window.__ig;
  if (s.status === 'ok' && threads.length === 0) { s.status = 'unknown_layout'; s.detail = 'no /direct/t/ links'; }
  return { page_status: s.status, page_detail: s.detail, page_url: s.url, page_title: s.title, mode: 'inbox', threads, messages: [] };
"""

THREAD_JS = """
  const msgs = [];
  for (const r of document.querySelectorAll('div[role="row"]')) {
    const t = (r.innerText || '').trim();
    if (t) msgs.push({ text: t });
  }
  const messages = msgs.slice(-20);
  const s = window.__ig;
  if (s.status === 'ok' && messages.length === 0) { s.status = 'unknown_layout'; s.detail = 'no message rows'; }
  return { page_status: s.status, page_detail: s.detail, page_url: s.url, page_title: s.title, mode: 'thread', threads: [], messages };
"""

data = js(THREAD_JS if THREAD else INBOX_JS)
print("==BH_PAYLOAD==")
print(json.dumps(data))
```

- [ ] **Step 2: Run it against the live inbox and observe**

Pre-req: Chrome is connected (`browser-harness --doctor` shows `chrome running`) and logged into Instagram.

Run: `browser-harness < docs/functions/ig-relay/snippets/read_inbox.py`

Expected: a `==BH_PAYLOAD==` line followed by JSON. On a logged-in inbox, `page_status` is `ok` and `threads` is a non-empty array of `{thread_id, url, user_full_name, preview}`. If `page_status` is `auth_required`/`challenge`, log into IG in Chrome and retry. If `unknown_layout` with `threads: []`, the selector needs refinement — that is handled in Task 6 (live discovery), so for now confirm the snippet runs and emits valid JSON without throwing.

- [ ] **Step 3: Commit**

```bash
git add docs/functions/ig-relay/snippets/read_inbox.py
git commit -m "Add read_inbox.py browser-harness snippet for manual IG DM reads"
```

---

### Task 3: Create `send_reply.py` snippet

A `browser-harness` snippet that opens a given thread, types a given message via CDP, presses Enter, and reports whether the composer cleared. Refuses to run without both inputs. Only ever invoked by Claude AFTER the user approves the exact text.

**Files:**
- Create: `docs/functions/ig-relay/snippets/send_reply.py`

- [ ] **Step 1: Create the snippet file**

```python
# send_reply.py — browser-harness snippet (SEND action; requires prior user approval).
#
# Required env:
#   IG_THREAD=<thread_id|full /direct/t/<id>/ url>   target conversation
#   IG_TEXT="the exact approved reply text"          message to send
#
# Run (only after the user approves the text):
#   IG_THREAD=<id> IG_TEXT="hi!" browser-harness < docs/functions/ig-relay/snippets/send_reply.py
#
# Output: "==BH_PAYLOAD==" then JSON { status, detail, thread }.
#   status: sent | uncertain | error
# Always confirm a real send by RE-READING the thread with read_inbox.py afterward.
import json, os, time

THREAD = os.environ.get("IG_THREAD", "").strip()
TEXT = os.environ.get("IG_TEXT", "")

def emit(status, detail):
    print("==BH_PAYLOAD==")
    print(json.dumps({"status": status, "detail": detail, "thread": THREAD}))
    raise SystemExit(0)

if not THREAD or not TEXT:
    emit("error", "IG_THREAD and IG_TEXT env vars are both required")

target = THREAD if THREAD.startswith("http") \
    else "https://www.instagram.com/direct/t/" + THREAD.strip("/") + "/"
new_tab(target)
wait_for_load()

# Confirm we're on a usable thread page and focus the composer.
found = js("""
  const url = location.href;
  if (url.includes('/accounts/login') || /\\/login(\\/|$|\\?)/.test(url)) return { ok:false, reason:'auth_required' };
  if (url.includes('/challenge')) return { ok:false, reason:'challenge' };
  const box = document.querySelector('div[contenteditable="true"][role="textbox"]') || document.querySelector('textarea');
  if (!box) return { ok:false, reason:'composer_not_found' };
  box.focus();
  return { ok:true };
""")
if not found.get("ok"):
    emit("error", "cannot send: " + str(found.get("reason")))

# Type via CDP (layout-independent; works on IG's React contenteditable) and send.
cdp("Input.insertText", {"text": TEXT})
time.sleep(0.3)
cdp("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
cdp("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13})
time.sleep(1.0)

# Heuristic confirmation: after a successful send the composer goes empty.
check = js("""
  const box = document.querySelector('div[contenteditable="true"][role="textbox"]') || document.querySelector('textarea');
  const text = box ? (box.innerText || box.value || '').trim() : null;
  return { composerEmpty: text === '' };
""")
if check.get("composerEmpty"):
    emit("sent", "composer cleared after send")
emit("uncertain", "composer not cleared; verify by re-reading the thread")
```

- [ ] **Step 2: Confirm the guard rejects missing inputs**

Run: `browser-harness < docs/functions/ig-relay/snippets/send_reply.py`
Expected: `==BH_PAYLOAD==` then `{"status": "error", "detail": "IG_THREAD and IG_TEXT env vars are both required", ...}` and no navigation/typing. (A real send is exercised with the user present in Task 6, never blindly here.)

- [ ] **Step 3: Commit**

```bash
git add docs/functions/ig-relay/snippets/send_reply.py
git commit -m "Add send_reply.py browser-harness snippet (approval-gated IG send)"
```

---

### Task 4: Rewrite `CLAUDE.md`

Replace the worker/Discord contract with the manual-assistant contract: scope, the read→draft→approve→send flow, safety rules, and how to switch between real Chrome (Phase 1) and the dedicated headless profile (Phase 2).

**Files:**
- Modify (full rewrite): `docs/functions/ig-relay/CLAUDE.md`

- [ ] **Step 1: Replace the file contents**

````markdown
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
````

- [ ] **Step 2: Verify no Discord references remain**

Run: `grep -in "discord\|watermark\|argus\|IG_RELAY_CHANNEL\|sentinel" docs/functions/ig-relay/CLAUDE.md`
Expected: no matches (exit code 1 / empty output).

- [ ] **Step 3: Commit**

```bash
git add docs/functions/ig-relay/CLAUDE.md
git commit -m "Rewrite ig-relay CLAUDE.md for the manual DM assistant flow"
```

---

### Task 5: Rewrite `README.md`

Replace the worker quick-start with the manual-flow quick-start.

**Files:**
- Modify (full rewrite): `docs/functions/ig-relay/README.md`

- [ ] **Step 1: Replace the file contents**

````markdown
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
````

- [ ] **Step 2: Verify no stale references remain**

Run: `grep -in "discord\|worker.ts\|mock/\|db.sqlite" docs/functions/ig-relay/README.md`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add docs/functions/ig-relay/README.md
git commit -m "Rewrite ig-relay README for the manual DM assistant flow"
```

---

### Task 6: Live discovery + end-to-end verification (interactive, user present)

The snippets ship with best-effort selectors. Instagram's DOM is obfuscated, so the first real run validates and refines them. **This task requires the user to be present and logged into Instagram.** Do not run a real send without explicit approval.

**Files:**
- Modify (only if selectors need fixing): `docs/functions/ig-relay/snippets/read_inbox.py`, `docs/functions/ig-relay/snippets/send_reply.py`

- [ ] **Step 1: Verify the inbox read returns real threads**

Run: `browser-harness < docs/functions/ig-relay/snippets/read_inbox.py`
Expected: `page_status: ok` and a `threads` array matching the user's real conversations. If `unknown_layout` or wrong data: `capture_screenshot()` and `js(...)` to inspect the live inbox DOM, adjust the `INBOX_JS` selectors in `read_inbox.py`, and re-run until correct.

- [ ] **Step 2: Verify the single-thread read returns messages**

Pick a `thread_id` from Step 1.
Run: `IG_THREAD=<thread_id> browser-harness < docs/functions/ig-relay/snippets/read_inbox.py`
Expected: `mode: thread`, `page_status: ok`, and a `messages` array with the conversation's recent message text. Refine `THREAD_JS` selectors if empty/wrong.

- [ ] **Step 3: Verify the not-logged-in branch**

Ask the user to confirm behavior when not on a usable page (or temporarily view IG while logged out in a spare tab). Confirm `read_inbox.py` returns `page_status` of `auth_required`/`challenge` rather than empty `ok` data. (Optional if the user doesn't want to log out — note it as unverified.)

- [ ] **Step 4: End-to-end approved send**

With the user choosing a safe thread and approving exact text:
Run: `IG_THREAD=<thread_id> IG_TEXT="<approved text>" browser-harness < docs/functions/ig-relay/snippets/send_reply.py`
Expected: `status: sent`. If `uncertain`, inspect with `capture_screenshot()`; the composer selector or send key may need adjustment in `send_reply.py`.

- [ ] **Step 5: Confirm delivery by re-reading**

Run: `IG_THREAD=<thread_id> browser-harness < docs/functions/ig-relay/snippets/read_inbox.py`
Expected: the approved message appears exactly once in the thread's `messages`.

- [ ] **Step 6: Commit any selector refinements**

```bash
git add docs/functions/ig-relay/snippets/
git commit -m "Refine ig-relay snippet selectors against live Instagram"
```

(Skip if no changes were needed in Steps 1–5.)

---

## Self-Review Notes

- **Spec coverage:** Removals (Task 1) cover the spec's "Removed" table including `DESIGN.md`. `read_inbox.py`/`send_reply.py` (Tasks 2–3) cover "Added". `CLAUDE.md`/`README.md` (Tasks 4–5) cover "Rewritten". `start-headless.sh` is kept (Task 1 keeps it). Safety/approval rules → Task 4. Error handling (auth/challenge, send fail) → snippet status branches + Task 4 rules. Verification/discovery → Task 6.
- **No automated tests by design:** documented at the top; verification is live + interactive, matching the spec's "Out of Scope" (no mock/test harness).
- **Path note:** all paths use the real `docs/functions/ig-relay/` location, not the legacy `features/ig-relay/` used in old docs (kept only inside the rewritten README's Phase-2 example, which mirrors the original launcher invocation style — adjust to your actual path when running).
- **Type/shape consistency:** both snippets emit `==BH_PAYLOAD==` + a single JSON object; `read_inbox.py` keys (`page_status`, `threads[].thread_id`, `messages[].text`) are consumed consistently by the flow in `CLAUDE.md`; `send_reply.py` uses `IG_THREAD`/`IG_TEXT` consistently across snippet, CLAUDE.md, and README.
