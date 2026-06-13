#!/usr/bin/env bun
// Live round-trip against the REAL Telegram Bot API. Uses the token in .env,
// runs the real hub + real channel.ts, and drives the channel with an MCP
// client standing in for Claude. You send the bot a DM from your phone; the
// chain proves getUpdates -> hub route -> channel envelope -> reply tool ->
// real sendMessage -> SQLite inbound+outbound under one conversation_id.
//
// This is the plumbing test (build steps 1-2 + channel). It does NOT exercise a
// real Claude session, so it cannot reproduce the Claude-Code surrogate-pair
// emoji bug — that needs `claude --dangerously-load-development-channels`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUB_PORT = 4713;
const WAIT_MS = 180_000;
const dbPath = resolve(projectRoot, "data", "conversations.db");

const env = loadDotEnv(resolve(projectRoot, ".env"));
const token = env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  log("ERROR: TELEGRAM_BOT_TOKEN is empty in .env — paste your @BotFather token first.");
  process.exit(1);
}
const API = `https://api.telegram.org/bot${token}`;

// ---- Preflight: confirm the token and clear any webhook (polling needs none).
const me = await tg("getMe") as { username?: string; id: number };
log(`token OK — bot is @${me.username} (${me.id})`);
await tg("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
log("ensured no webhook is set (getUpdates polling can run)");

const childEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  TELEGRAM_HUB_PORT: String(HUB_PORT),
  TELEGRAM_HUB_HOST: "127.0.0.1",
  TELEGRAM_HUB_BIND_ADDR: "127.0.0.1",
};

// ---- Real hub (sole getUpdates consumer for this token while the test runs).
const hub = Bun.spawn(["bun", "run", "src/hub.ts"], {
  cwd: projectRoot,
  env: childEnv,
  stdout: "inherit",
  stderr: "inherit",
});
await waitForHttp(`http://127.0.0.1:${HUB_PORT}/`, 8000);
log("hub is up");

// ---- Real channel.ts driven by an MCP client (the Claude stand-in).
let done = false;
let capturedConversationId: string | undefined;
let replyError: string | undefined;
const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/channel.ts"],
  cwd: projectRoot,
  env: { ...childEnv, TELEGRAM_CHAT: "*" },
  stderr: "inherit",
});
const client = new Client({ name: "live-test-claude-stand-in", version: "0.0.0" }, { capabilities: {} });

client.fallbackNotificationHandler = async (notification) => {
  if (notification.method !== "notifications/claude/channel") return;
  const params = (notification.params ?? {}) as { content?: string; meta?: Record<string, unknown> };
  const meta = params.meta ?? {};
  capturedConversationId = meta.conversation_id != null ? String(meta.conversation_id) : undefined;
  log(`channel notification received from ${meta.user_name} (conversation=${capturedConversationId})`);
  try {
    await client.callTool({
      name: "reply",
      arguments: {
        chat_id: String(meta.channel_id),
        text: "[live-test] 라핀 케이크 봇 연결 확인 완료예요 🎂 (이건 자동 응답 테스트입니다)",
        message_id: meta.message_id != null ? String(meta.message_id) : undefined,
        conversation_id: capturedConversationId,
      },
    });
    log("reply sent via real Telegram sendMessage");
    done = true;
  } catch (err) {
    replyError = String(err);
    log(`reply tool ERROR: ${replyError}`);
  }
};

await client.connect(transport);
await Bun.sleep(1500); // let channel.ts bind as fallback on the hub
log("");
log("==================================================================");
log(`  NOW: open Telegram and send @${me.username} any DM (e.g. "ping").`);
log(`  Waiting up to ${WAIT_MS / 1000}s for the round-trip...`);
log("==================================================================");
log("");

const ok = await waitUntil(() => done, WAIT_MS);

// ---- Assertions
const failures: string[] = [];
if (!ok) failures.push(`no round-trip completed within ${WAIT_MS / 1000}s (did you DM the bot?)`);
if (replyError) failures.push(`reply tool errored: ${replyError}`);

let rows: Array<{ direction: string; conversation_id: string; chat_id: string; content: string }> = [];
if (capturedConversationId) {
  const db = new Database(dbPath, { readonly: true });
  rows = db.prepare(
    "SELECT direction, conversation_id, chat_id, content FROM conversation_events WHERE conversation_id = ? ORDER BY id",
  ).all(capturedConversationId) as typeof rows;
  db.close();
  const inbound = rows.find((r) => r.direction === "inbound");
  const outbound = rows.find((r) => r.direction === "outbound");
  if (!inbound) failures.push("no inbound row in SQLite");
  if (!outbound) failures.push("no outbound row in SQLite");
  if (inbound && outbound && inbound.conversation_id !== outbound.conversation_id) {
    failures.push("inbound/outbound conversation_id differ");
  }
} else if (ok) {
  failures.push("round-trip ran but conversation_id was not captured");
}

log("");
if (capturedConversationId) {
  log(`SQLite rows for ${capturedConversationId}:`);
  for (const r of rows) log(`  [${r.direction}] chat=${r.chat_id} content=${JSON.stringify(r.content)}`);
}
log("");

// ---- Cleanup (kill the hub so it stops consuming getUpdates for this token).
try { await client.close(); } catch {}
try { hub.kill(); } catch {}

if (failures.length === 0) {
  log("PASS — live Telegram round-trip verified end to end (real getUpdates -> hub -> channel envelope -> reply tool -> real sendMessage -> SQLite inbound+outbound under one conversation_id). Check your Telegram: you should see the bot's reply.");
  process.exit(0);
} else {
  log("FAIL:");
  for (const f of failures) log(`  - ${f}`);
  process.exit(1);
}

// ---- helpers
function log(...args: unknown[]) {
  console.error("[live-test]", ...args);
}

async function tg(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: params ? JSON.stringify(params) : undefined,
  });
  const data = await res.json().catch(() => undefined) as
    | { ok: boolean; result?: unknown; error_code?: number; description?: string } | undefined;
  if (!data || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data?.error_code ?? res.status} ${data?.description ?? ""}`);
  }
  return data.result;
}

function loadDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["'](.*)["']$/, "$1");
  }
  return out;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await Bun.sleep(150);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(250);
  }
  return pred();
}
