# send_reply.py — browser-harness snippet (SEND action; requires prior user approval).
#
# Target the conversation by EITHER:
#   IG_OPEN="<name>"     click the inbox row whose name contains <name>, OR
#   IG_THREAD=<id|url>   open a known thread directly
# Plus (required):
#   IG_TEXT="the exact approved reply text"
#
# Run (only after the user approves the exact text):
#   IG_OPEN="Jane Choi" IG_TEXT="hi!" browser-harness < docs/functions/ig-relay/snippets/send_reply.py
#   IG_THREAD=112169376842688 IG_TEXT="hi!" browser-harness < docs/functions/ig-relay/snippets/send_reply.py
#
# Output: "==BH_PAYLOAD==" then JSON { status, detail, thread_id }.
#   status: sent | uncertain | error
# Always confirm a real send by RE-READING the thread with read_inbox.py afterward.
import json, os, time

OPEN = os.environ.get("IG_OPEN", "").strip()
THREAD = os.environ.get("IG_THREAD", "").strip()
TEXT = os.environ.get("IG_TEXT", "")
INBOX_URL = "https://www.instagram.com/direct/inbox/"

def emit(status, detail, thread_id=None):
    print("==BH_PAYLOAD==")
    print(json.dumps({"status": status, "detail": detail, "thread_id": thread_id}, ensure_ascii=False))
    raise SystemExit(0)

if not TEXT or not (OPEN or THREAD):
    emit("error", "IG_TEXT is required, plus one of IG_OPEN or IG_THREAD")

# Navigate: direct to a known thread, else to the inbox (for open-by-name).
if THREAD:
    target = THREAD if THREAD.startswith("http") \
        else "https://www.instagram.com/direct/t/" + THREAD.strip("/") + "/"
    new_tab(target)
else:
    new_tab(INBOX_URL)
wait_for_load()
time.sleep(2.0)
capture_screenshot()  # force foreground layout so getBoundingClientRect is valid

guard = js("""
  const url = location.href;
  if (url.includes('/accounts/login') || /\\/login(\\/|$|\\?)/.test(url)) return { ok:false, reason:'auth_required' };
  if (url.includes('/challenge')) return { ok:false, reason:'challenge' };
  return { ok:true };
""")
if not guard.get("ok"):
    emit("error", "cannot send: " + str(guard.get("reason")))

# OPEN by name: find the matching inbox row and click it open.
if OPEN and not THREAD:
    rows = js("""
      const rows = [];
      for (const b of document.querySelectorAll('div[role="button"]')) {
        const img = b.querySelector('img');
        const r = b.getBoundingClientRect();
        const txt = (b.innerText || '').trim();
        if (img && txt && r.height > 40 && r.height < 130 && r.left < 470 && r.width > 150) {
          const lines = txt.split('\\n').map(s => s.trim()).filter(Boolean);
          rows.push({ name: lines[0] || '', x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
        }
      }
      return rows;
    """)
    match = next((r for r in rows if OPEN.lower() in r["name"].lower()), None)
    if not match:
        emit("error", "no inbox row name matched IG_OPEN=" + OPEN)
    click_at_xy(match["x"], match["y"])
    time.sleep(2.0)

# Locate and focus the composer, then insert the text ONCE via Input.insertText.
# (press_key/fill_input emit the char in both a keyDown-with-text and a `char`
# event, which double-types every character — including multibyte Korean. insertText
# inserts exactly once and still fires the native input event IG's composer reads.)
# Then Enter sends.
COMPOSER = 'div[contenteditable="true"][role="textbox"]'
if not js("(()=>{const e=document.querySelector(%s);if(!e)return false;e.focus();return true;})()" % json.dumps(COMPOSER)):
    emit("error", "composer_not_found")
type_text(TEXT)
time.sleep(0.4)
press_key("Enter")
time.sleep(1.5)

# Heuristic confirmation: after a successful send the composer goes empty.
chk = js("""
  const box = document.querySelector('div[contenteditable="true"][role="textbox"]') || document.querySelector('textarea');
  const text = box ? (box.innerText || box.value || '').trim() : null;
  return { empty: text === '', url: location.href };
""")
tid = chk["url"].split("/direct/t/")[1].split("/")[0] if "/direct/t/" in chk.get("url", "") else None
if chk.get("empty"):
    emit("sent", "composer cleared after send", thread_id=tid)
emit("uncertain", "composer not cleared; verify by re-reading the thread", thread_id=tid)
