# read_inbox.py — browser-harness snippet (pure read; no messages sent).
#
# Modes (env):
#   (none)              list the DM inbox: rows of { name, preview, x, y }
#   IG_OPEN="<name>"    open the inbox row whose name contains <name> (case-insensitive),
#                       then read that conversation's recent messages
#   IG_THREAD=<id|url>  open a known thread directly (by id or full /direct/t/<id>/ url),
#                       then read its recent messages
#
# Run:
#   browser-harness < docs/functions/ig-relay/snippets/read_inbox.py
#   IG_OPEN="Jane Choi" browser-harness < docs/functions/ig-relay/snippets/read_inbox.py
#   IG_THREAD=112169376842688 browser-harness < docs/functions/ig-relay/snippets/read_inbox.py
#
# Output: a line "==BH_PAYLOAD==" followed by one JSON object:
#   { page_status, page_url, page_title, mode, thread_id, rows, messages }
# page_status is one of: ok | auth_required | challenge | two_factor | unknown_layout
#
# Notes on the approach (learned against live Instagram, 2026-05):
# - The inbox renders conversations as div[role="button"] rows, NOT <a> links;
#   Instagram exposes a thread id only in the URL after a row is opened.
# - capture_screenshot() is called after load to force the tab foreground so
#   getBoundingClientRect() returns valid geometry (background tabs report 0).
# - Thread messages live in div[dir="auto"] nodes.
import json, os, time

OPEN = os.environ.get("IG_OPEN", "").strip()
THREAD = os.environ.get("IG_THREAD", "").strip()
INBOX_URL = "https://www.instagram.com/direct/inbox/"

def emit(d):
    print("==BH_PAYLOAD==")
    print(json.dumps(d, ensure_ascii=False))
    raise SystemExit(0)

STATUS_JS = """
  const url = location.href;
  let status = 'ok';
  if (url.includes('/accounts/login') || /\\/login(\\/|$|\\?)/.test(url)) status = 'auth_required';
  else if (url.includes('/challenge')) status = 'challenge';
  else if (url.includes('/two_factor') || url.includes('/2fa')) status = 'two_factor';
  return { status, url, title: document.title };
"""

ROWS_JS = """
  const rows = [];
  for (const b of document.querySelectorAll('div[role="button"]')) {
    const img = b.querySelector('img');
    const r = b.getBoundingClientRect();
    const txt = (b.innerText || '').trim();
    if (img && txt && r.height > 40 && r.height < 130 && r.left < 470 && r.width > 150) {
      const lines = txt.split('\\n').map(s => s.trim()).filter(Boolean);
      rows.push({ name: lines[0] || '', preview: lines.slice(1).join(' '),
                  x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    }
  }
  return rows;
"""

MSGS_JS = """
  const msgs = [];
  for (const d of document.querySelectorAll('div[dir="auto"]')) {
    const t = (d.innerText || '').trim();
    if (t) msgs.push(t);
  }
  return { messages: msgs.slice(-25), url: location.href };
"""

# Navigate: direct to a known thread, else to the inbox (for list or open-by-name).
if THREAD:
    target = THREAD if THREAD.startswith("http") \
        else "https://www.instagram.com/direct/t/" + THREAD.strip("/") + "/"
    new_tab(target)
else:
    new_tab(INBOX_URL)
wait_for_load()
time.sleep(2.0)
capture_screenshot()  # force foreground layout so getBoundingClientRect is valid

st = js(STATUS_JS)
mode = "thread" if (THREAD or OPEN) else "inbox"
if st["status"] != "ok":
    emit({"page_status": st["status"], "page_url": st["url"], "page_title": st["title"],
          "mode": mode, "thread_id": None, "rows": [], "messages": []})

# OPEN by name: find the matching inbox row and click it open.
if OPEN and not THREAD:
    rows = js(ROWS_JS)
    match = next((r for r in rows if OPEN.lower() in r["name"].lower()), None)
    if not match:
        emit({"page_status": "ok", "page_url": st["url"], "page_title": st["title"],
              "mode": "open", "thread_id": None, "rows": rows, "messages": [],
              "error": "no inbox row name matched IG_OPEN=" + OPEN})
    click_at_xy(match["x"], match["y"])
    time.sleep(2.0)

# Read messages for a thread (opened by id/url or by name).
if THREAD or OPEN:
    msg = js(MSGS_JS)
    tid = msg["url"].split("/direct/t/")[1].split("/")[0] if "/direct/t/" in msg["url"] else None
    emit({"page_status": "ok" if msg["messages"] else "unknown_layout",
          "page_url": msg["url"], "page_title": st["title"],
          "mode": "thread", "thread_id": tid, "rows": [], "messages": msg["messages"]})

# Default: list the inbox.
rows = js(ROWS_JS)
emit({"page_status": "ok" if rows else "unknown_layout",
      "page_url": st["url"], "page_title": st["title"],
      "mode": "inbox", "thread_id": None, "rows": rows, "messages": []})
