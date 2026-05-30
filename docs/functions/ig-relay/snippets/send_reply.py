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
