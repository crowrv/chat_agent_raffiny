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
