#!/usr/bin/env bun
// ig-source.ts — Instagram ingestion source for the hub.
//
// Polls the Instagram DM inbox through ig-relay (read-only; reading needs no
// approval) and pushes NEW inbox activity into the hub's /ingest endpoint, so
// IG DMs flow to a Claude session exactly like Telegram messages. Replies are
// NOT sent here — the session sends them via ig-relay's send_reply after
// approval (see docs/baker_check.md). Sending is never automated.
//
// Requires the dedicated ig-relay Chrome to be up on port 9334:
//   docs/functions/ig-relay/start-headless.sh --gui   # log into Instagram once
//
// Run:  bun run src/ig-source.ts   (or: bun run ig-source)
import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IG_SH = resolve(projectRoot, "docs/functions/ig-relay/ig.sh");
const HUB = `http://${process.env.TELEGRAM_HUB_HOST || "127.0.0.1"}:${process.env.TELEGRAM_HUB_PORT || "4713"}`;
const POLL_SECONDS = Number(process.env.IG_POLL_SECONDS) || 120;
const STATE_FILE = process.env.IG_STATE_FILE || "/tmp/ig-source-state.json";

const log = (...a: unknown[]) => console.error("[ig-source]", ...a);

type Row = { name: string; preview: string };
type State = { previews: Record<string, string> };

function loadState(): State | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    // Migrate baselines written before the age-strip fix (previews stored WITH the
    // "· 27w" suffix) so the first poll doesn't compare stripped-vs-unstripped and
    // replay every thread once.
    for (const name of Object.keys(s.previews ?? {})) {
      s.previews[name] = stripAge(s.previews[name]);
    }
    return s;
  } catch {
    return null;
  }
}
function saveState(s: State) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch (e) {
    log("WARN: could not persist state:", e);
  }
}

// Run `ig.sh read_inbox` and parse the JSON after the ==BH_PAYLOAD== marker.
async function readInbox(): Promise<{ page_status: string; rows: Row[] } | null> {
  let out: string;
  try {
    out = await $`${IG_SH} read_inbox`.text();
  } catch (e: any) {
    // ig.sh exits non-zero when the dedicated Chrome isn't up, etc.
    log("ig.sh read_inbox failed (is the IG Chrome up on :9334?):", e?.stderr?.toString?.() || e?.message || e);
    return null;
  }
  const marker = out.indexOf("==BH_PAYLOAD==");
  if (marker < 0) return null;
  const rest = out.slice(marker + "==BH_PAYLOAD==".length);
  const a = rest.indexOf("{");
  const b = rest.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    return JSON.parse(rest.slice(a, b + 1));
  } catch {
    return null;
  }
}

// Instagram renders a relative age in each inbox row ("· 27w", "· 3m", "· 1h").
// That suffix is part of the row's innerText, so it rides along in `preview` — and
// it MUTATES as real time passes (1m→3m, 26w→27w) with no new message. Comparing
// the raw preview therefore treats an age rollover as "changed" and replays old,
// already-completed threads. Strip the trailing "· <age>" so dedup keys on the
// actual message text only.
function stripAge(preview: string): string {
  return preview.replace(/\s·\s(?:\d+\s*[smhdwy]|just now|now)\b.*$/i, "").trim();
}

// A row counts as new inbound activity when its preview changed and it isn't the
// business's own outgoing message ("You: …") or a non-message status line.
function isInbound(preview: string): boolean {
  const p = preview.trim();
  if (!p) return false;
  if (/^you[: ]/i.test(p)) return false;          // our own outgoing ("You:", "You sent …")
  if (/^active /i.test(p)) return false;           // presence ("Active 1m ago", "Active 17h ago")
  if (/^(seen|typing)/i.test(p)) return false;     // status lines
  return true;
}

async function ingest(row: Row) {
  const body = {
    platform: "instagram",
    chat_id: row.name,
    chat_type: "dm",
    conversation_id: `instagram:thread:${row.name}`,
    content: `📷 Instagram DM from "${row.name}": ${row.preview}`,
    user_name: row.name,
    user_display_name: row.name,
    is_dm: true,
    mentions_bot: true,
    is_command: false,
  };
  try {
    const res = await fetch(`${HUB}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) log(`WARN: /ingest returned ${res.status} for "${row.name}"`);
    else log(`ingested DM from "${row.name}": ${row.preview.slice(0, 80)}`);
  } catch (e) {
    log("WARN: could not reach hub /ingest:", e);
  }
}

async function poll(state: State, firstRun: boolean) {
  const res = await readInbox();
  if (!res) return; // transient (Chrome down / parse fail) — try again next tick
  if (res.page_status !== "ok") {
    log(`inbox page_status=${res.page_status} — needs attention (re-run start-headless.sh --gui). Skipping.`);
    return;
  }
  for (const row of res.rows ?? []) {
    if (!row?.name) continue;
    const key = stripAge(row.preview);
    const prev = state.previews[row.name];
    const changed = prev !== key;
    state.previews[row.name] = key;
    // First run only records a baseline so we don't replay the whole inbox.
    if (firstRun) continue;
    if (changed && isInbound(key)) await ingest(row);
  }
  saveState(state);
}

async function main() {
  const existing = loadState();
  const state: State = existing ?? { previews: {} };
  const firstRun = existing === null;
  log(`polling Instagram inbox every ${POLL_SECONDS}s → ${HUB}/ingest`);
  if (firstRun) log("first run: recording a baseline (no replay of existing threads)");

  // Prime the baseline immediately, then poll on the interval.
  await poll(state, firstRun);
  let baseliningDone = true;
  setInterval(() => void poll(state, false), POLL_SECONDS * 1000);
  // Keep the event loop alive.
  void baseliningDone;
}

main();
