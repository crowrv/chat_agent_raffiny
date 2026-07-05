#!/usr/bin/env bun
// ig-source.ts — Instagram ingestion source for the hub.
//
// Polls the Instagram DM inbox through ig-relay (read-only; reading needs no
// approval) and pushes NEW inbox activity into the hub's /ingest endpoint, so
// IG DMs flow to a Claude session exactly like Telegram messages. Replies are
// NOT sent here — the session sends them via ig-relay's send_reply after
// approval (see docs/baker_check.md). Sending is never automated.
//
// The dedicated ig-relay Chrome (port 9334) is launched HEADLESS automatically —
// this feeder runs start-headless.sh on startup and re-launches it if the browser
// dies, so it can run unattended (e.g. auto-started by ./hub.sh). You only need a
// one-time interactive login to seed the cookies the headless session reuses:
//   docs/functions/ig-relay/start-headless.sh --gui   # log into Instagram once
//
// Run:  bun run src/ig-source.ts   (or: bun run ig-source)
import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath } from "./paths.js";

const projectRoot = canonicalPath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
loadDotEnv(resolve(projectRoot, ".env"));

const IG_SH = resolve(projectRoot, "docs/functions/ig-relay/ig.sh");
const START_HEADLESS = resolve(projectRoot, "docs/functions/ig-relay/start-headless.sh");
const IG_PORT = process.env.IG_HEADLESS_PORT || "9334";
const IG_PROFILE = process.env.IG_HEADLESS_PROFILE || `${process.env.HOME}/.browser-harness-ig`;
const HUB = `http://${process.env.TELEGRAM_HUB_HOST || "127.0.0.1"}:${process.env.TELEGRAM_HUB_PORT || "4713"}`;
const POLL_SECONDS = Number(process.env.IG_POLL_SECONDS) || 120;
const STATE_FILE = process.env.IG_STATE_FILE || "/tmp/ig-source-state.json";
const EXPECTED_HUB_ID = process.env.TELEGRAM_HUB_ID || "";
// Never treat a row older than this as new inbound. The preview-only dedup can't
// tell "old message still at the top of the thread" from "new message", so an
// absolute-age guard is the backstop: a 6-week-old DM can never be ingested as new.
const MAX_AGE_HOURS = Number(process.env.IG_MAX_AGE_HOURS) || 48;

const log = (...a: unknown[]) => console.error("[ig-source]", ...a);

export type Row = { name: string; preview: string };
export type State = { previews: Record<string, string> };
const REQUIRE_REVIEW_SESSION = process.env.IG_REQUIRE_REVIEW_SESSION !== "0";

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

// Is the dedicated ig-relay Chrome answering CDP on its debug port?
async function chromeUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${IG_PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

// Inspect the MAIN Chrome browser process bound to our debug port + profile and
// report whether it was launched headless. A leftover GUI instance (from the
// one-time `--gui` login) also answers CDP, so chromeUp() alone can't tell them
// apart — and a GUI window gets raised to the foreground on every poll. Skips the
// renderer/gpu/utility children (they carry --type=); only the browser process
// has the --headless flag. Returns "headless", "gui", or "none".
async function chromeMode(): Promise<"headless" | "gui" | "none"> {
  let out: string;
  try {
    out = await $`ps -axww -o command=`.text();
  } catch {
    return "none";
  }
  for (const line of out.split("\n")) {
    if (!line.includes(`--remote-debugging-port=${IG_PORT}`)) continue;
    if (!line.includes(IG_PROFILE)) continue;
    if (line.includes("--type=")) continue; // child process, not the browser
    return line.includes("--headless") ? "headless" : "gui";
  }
  return "none";
}

// Kill every Chrome process bound to our debug port (browser + children). The
// match pattern deliberately omits the leading "--": pkill -f treats an argument
// starting with "--" as end-of-options, which would make the match a silent no-op.
async function killChrome(): Promise<void> {
  try {
    await $`pkill -f ${`remote-debugging-port=${IG_PORT}`}`.quiet();
  } catch {
    // pkill exits non-zero when nothing matched — fine.
  }
}

// Make sure a HEADLESS dedicated Chrome is serving the debug port, launching it
// via the idempotent start-headless.sh if needed. If a GUI instance is holding
// the port (leftover from the manual login), replace it with headless so the
// feeder runs unattended without a window popping up every poll — the login
// cookies persist in the profile dir, so no re-login is required.
// Returns false when the browser couldn't be brought up — caller skips this tick.
async function ensureChrome(): Promise<boolean> {
  const mode = await chromeMode();
  if (mode === "headless" && (await chromeUp())) return true;
  if (mode === "gui") {
    log("IG Chrome is running in GUI mode — replacing it with headless to save resources.");
    await killChrome();
    for (let i = 0; i < 20 && (await chromeUp()); i++) await Bun.sleep(250);
  }
  if (await chromeUp()) return true;
  log(`IG Chrome not up on :${IG_PORT} — launching headless …`);
  try {
    await $`${START_HEADLESS}`.quiet();
  } catch (e: any) {
    log("start-headless.sh failed:", e?.stderr?.toString?.() || e?.message || e);
  }
  return await chromeUp();
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

// Parse the relative age Instagram renders in the row ("· 6w", "· 3m", "· just now")
// into hours. Returns null when no age token is present (then we don't gate on it).
// IG units: s=seconds, m=minutes, h=hours, d=days, w=weeks, y=years.
function ageHours(preview: string): number | null {
  const m = preview.match(/·\s*(?:(\d+)\s*([smhdwy])|(just now|now))\b/i);
  if (!m) return null;
  if (m[3]) return 0; // "just now" / "now"
  const per: Record<string, number> = { s: 1 / 3600, m: 1 / 60, h: 1, d: 24, w: 168, y: 8760 };
  return Number(m[1]) * (per[m[2].toLowerCase()] ?? Infinity);
}

// Recent enough to be considered new inbound? An unparseable age is allowed
// through (rare; better than silently dropping a genuine message).
function isRecent(preview: string): boolean {
  const h = ageHours(preview);
  return h === null ? true : h <= MAX_AGE_HOURS;
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

async function ingest(row: Row): Promise<boolean> {
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
    const data = await res.json().catch(() => undefined) as { ok?: boolean; error?: string } | undefined;
    if (!res.ok || data?.ok !== true) {
      log(`WARN: /ingest returned ${res.status} for "${row.name}" (${data?.error ?? "unknown error"})`);
      return false;
    }
    log(`ingested DM from "${row.name}": ${row.preview.slice(0, 80)}`);
    return true;
  } catch (e) {
    log("WARN: could not reach hub /ingest:", e);
    return false;
  }
}

async function reviewSessionReady(): Promise<boolean> {
  if (!REQUIRE_REVIEW_SESSION) return true;
  try {
    const res = await fetch(`${HUB}/health`);
    if (!res.ok) return false;
    const data = await res.json();
    return isExpectedReviewHub(data, EXPECTED_HUB_ID, projectRoot);
  } catch {
    return false;
  }
}

export function isExpectedReviewHub(
  data: unknown,
  expectedInstance: string,
  expectedProjectRoot: string,
): boolean {
  if (!expectedInstance || !expectedProjectRoot || !data || typeof data !== "object") return false;
  const health = data as { instance?: unknown; projectRoot?: unknown; roles?: { review?: unknown } };
  return health.instance === expectedInstance
    && health.projectRoot === expectedProjectRoot
    && health.roles?.review === true;
}

export async function applyInboxRows(
  state: State,
  rows: Row[],
  firstRun: boolean,
  deliver: (row: Row) => Promise<boolean> = ingest,
): Promise<boolean> {
  let changedState = false;
  for (const row of rows ?? []) {
    if (!row?.name) continue;
    const key = stripAge(row.preview);
    const prev = state.previews[row.name];
    const changed = prev !== key;
    // First run only records a baseline so we don't replay the whole inbox.
    if (firstRun) {
      if (changed) {
        state.previews[row.name] = key;
        changedState = true;
      }
      continue;
    }
    if (!changed) continue;
    if (!isInbound(key)) {
      state.previews[row.name] = key;
      changedState = true;
      continue;
    }
    if (!isRecent(row.preview)) {
      state.previews[row.name] = key;
      changedState = true;
      log(`skipping stale row from "${row.name}" (age ${ageHours(row.preview)}h > ${MAX_AGE_HOURS}h)`);
      continue;
    }
    if (await deliver(row)) {
      state.previews[row.name] = key;
      changedState = true;
    } else {
      log(`delivery failed for "${row.name}" — keeping previous preview so it retries next tick`);
    }
  }
  return changedState;
}

async function poll(state: State, firstRun: boolean): Promise<boolean> {
  if (!(await reviewSessionReady())) {
    log("review session is not bound on the hub — skipping inbox read so no DMs are acknowledged");
    return false;
  }
  if (!(await ensureChrome())) {
    log(`IG Chrome unavailable on :${IG_PORT} — retrying next tick.`);
    return false;
  }
  const res = await readInbox();
  if (!res) return false; // transient (Chrome down / parse fail) — try again next tick
  if (res.page_status !== "ok") {
    log(`inbox page_status=${res.page_status} — needs attention (re-run start-headless.sh --gui). Skipping.`);
    return false;
  }
  if (await applyInboxRows(state, res.rows ?? [], firstRun)) saveState(state);
  return true;
}

async function main() {
  const existing = loadState();
  const state: State = existing ?? { previews: {} };
  let needsBaseline = existing === null;
  log(`polling Instagram inbox every ${POLL_SECONDS}s → ${HUB}/ingest`);
  if (needsBaseline) log("first run: recording a baseline (no replay of existing threads)");

  // Reentrancy guard: a slow read (headless IG) can outlast the poll interval. Two
  // overlapping ticks each spin up ig.sh, which collide on the shared browser-harness
  // daemon socket (/tmp/bu-ig.sock) — that read then fails and the tick bails before
  // saveState, leaving the dedup baseline stale. Skip a tick while one is in flight.
  let inFlight = false;
  const tick = async () => {
    if (inFlight) {
      log("previous poll still running — skipping this tick");
      return;
    }
    inFlight = true;
    try {
      const completed = await poll(state, needsBaseline);
      if (completed && needsBaseline) needsBaseline = false;
    } finally {
      inFlight = false;
    }
  };

  // Prime the baseline immediately, then poll on the interval.
  await tick();
  setInterval(() => void tick(), POLL_SECONDS * 1000);
}

function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

if (import.meta.main) {
  main();
}
