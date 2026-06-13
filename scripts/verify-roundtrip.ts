#!/usr/bin/env bun
// Integration harness: proves the channel protocol end-to-end WITHOUT a real
// bot token or a live Claude session. It stands up a mock Telegram Bot API,
// runs the real hub against it, and drives the real channel.ts through an MCP
// stdio client that plays the exact role Claude Code plays — receive the
// notifications/claude/channel notification, then call the reply tool. Asserts
// that sendMessage fired and that SQLite holds inbound+outbound rows under one
// conversation_id.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = 4799;
const HUB_PORT = 4798;
const HUB_ID = "verify-harness";
const CHAT_ID = String(900000 + (Date.now() % 100000));
const CONVERSATION_ID = `telegram:chat:${CHAT_ID}`;
const dbPath = resolve(projectRoot, "data", "conversations.db");

// Fresh DB so the assertion sees only this run's rows.
for (const suffix of ["", "-shm", "-wal"]) {
  try { rmSync(`${dbPath}${suffix}`); } catch {}
}

// ---- Mock Telegram Bot API -------------------------------------------------
let queuedUpdate: unknown | undefined;
let deliveredUpdate = false;
const sentMessages: Array<Record<string, unknown>> = [];
let nextUpdateId = 100;
let nextMessageId = 2000;

const mock = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = url.pathname.split("/").pop();
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    if (method === "getMe") {
      return Response.json({ ok: true, result: { id: 42, is_bot: true, first_name: "Raffiny", username: "raffiny_test_bot" } });
    }
    if (method === "getUpdates") {
      if (queuedUpdate && !deliveredUpdate) {
        deliveredUpdate = true;
        const u = queuedUpdate;
        queuedUpdate = undefined;
        return Response.json({ ok: true, result: [u] });
      }
      await Bun.sleep(200); // gentle poll; don't honor the 50s long-poll in tests
      return Response.json({ ok: true, result: [] });
    }
    if (method === "sendChatAction") {
      return Response.json({ ok: true, result: true });
    }
    if (method === "sendMessage") {
      sentMessages.push(body as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: nextMessageId++, chat: { id: (body as any).chat_id }, text: (body as any).text } });
    }
    return Response.json({ ok: false, error_code: 404, description: `mock has no method ${method}` }, { status: 404 });
  },
});
log(`mock Telegram API on :${MOCK_PORT}`);

const childEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  TELEGRAM_BOT_TOKEN: "verify-harness-token",
  TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
  TELEGRAM_HUB_ID: HUB_ID,
  TELEGRAM_HUB_PORT: String(HUB_PORT),
  TELEGRAM_HUB_HOST: "127.0.0.1",
  TELEGRAM_HUB_BIND_ADDR: "127.0.0.1",
  TELEGRAM_HUB_LOG_FILE: "/tmp/telegram-verify-hub.log",
};

// ---- Real hub --------------------------------------------------------------
const hub = Bun.spawn(["bun", "run", "src/hub.ts"], {
  cwd: projectRoot,
  env: childEnv,
  stdout: "inherit",
  stderr: "inherit",
});
await waitForHttp(`http://127.0.0.1:${HUB_PORT}/`, 5000);
log("hub is up");

// ---- Real channel.ts driven by an MCP client (the Claude stand-in) ---------
let replyError: string | undefined;
const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/channel.ts"],
  cwd: projectRoot,
  env: { ...childEnv, TELEGRAM_CHAT: "*" },
  stderr: "inherit",
});
const client = new Client({ name: "verify-claude-stand-in", version: "0.0.0" }, { capabilities: {} });

// This is the whole point of the channel protocol: a notification wakes the
// "session", which then calls the reply tool. We mimic exactly that.
client.fallbackNotificationHandler = async (notification) => {
  if (notification.method !== "notifications/claude/channel") return;
  const params = (notification.params ?? {}) as { meta?: Record<string, unknown> };
  const meta = params.meta ?? {};
  log(`channel notification received (conversation=${meta.conversation_id})`);
  try {
    const res = await client.callTool({
      name: "reply",
      arguments: {
        chat_id: String(meta.channel_id ?? CHAT_ID),
        text: "PONG <b>ok</b> from verify harness",
        message_id: meta.message_id != null ? String(meta.message_id) : undefined,
        conversation_id: meta.conversation_id != null ? String(meta.conversation_id) : undefined,
      },
    });
    log(`reply tool returned: ${JSON.stringify(res.content)}`);
  } catch (err) {
    replyError = String(err);
    log(`reply tool ERROR: ${replyError}`);
  }
};

await client.connect(transport);
log("MCP client connected to channel.ts");

// Give channel.ts a moment to bind as the fallback session on the hub.
await Bun.sleep(1500);

// ---- Inject one inbound Telegram message ----------------------------------
queuedUpdate = {
  update_id: nextUpdateId++,
  message: {
    message_id: 1001,
    from: { id: 555, is_bot: false, first_name: "Verify", username: "verify_user" },
    chat: { id: Number(CHAT_ID), type: "private" },
    date: Math.floor(Date.now() / 1000),
    text: "Ping from verify harness",
  },
};
log(`injected inbound message into mock (chat=${CHAT_ID})`);

// ---- Wait for the round-trip to complete -----------------------------------
const ok = await waitUntil(() => sentMessages.length > 0, 10000);

// ---- Assertions ------------------------------------------------------------
const failures: string[] = [];
if (!ok) failures.push("no sendMessage reached the mock within 10s");
if (replyError) failures.push(`reply tool errored: ${replyError}`);

const sent = sentMessages[0];
if (sent) {
  if (String(sent.chat_id) !== CHAT_ID) failures.push(`sendMessage chat_id mismatch: ${sent.chat_id}`);
  if (typeof sent.text !== "string" || !sent.text.includes("PONG")) failures.push(`sendMessage text unexpected: ${sent.text}`);
  if (sent.parse_mode !== "HTML") failures.push(`expected parse_mode HTML, got ${sent.parse_mode}`);
}

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(
  "SELECT direction, conversation_id, chat_id, content FROM conversation_events WHERE conversation_id = ? ORDER BY id",
).all(CONVERSATION_ID) as Array<{ direction: string; conversation_id: string; chat_id: string; content: string }>;
db.close();

const inbound = rows.find((r) => r.direction === "inbound");
const outbound = rows.find((r) => r.direction === "outbound");
if (!inbound) failures.push("no inbound row in SQLite");
if (!outbound) failures.push("no outbound row in SQLite");
if (inbound && outbound && inbound.conversation_id !== outbound.conversation_id) {
  failures.push("inbound/outbound conversation_id differ");
}

log("");
log(`SQLite rows for ${CONVERSATION_ID}:`);
for (const r of rows) log(`  [${r.direction}] chat=${r.chat_id} content=${JSON.stringify(r.content)}`);
log(`mock sendMessage payloads: ${JSON.stringify(sentMessages)}`);
log("");

// ---- Cleanup ---------------------------------------------------------------
try { await client.close(); } catch {}
try { hub.kill(); } catch {}
try { mock.stop(true); } catch {}

if (failures.length === 0) {
  log("✅ PASS — full round-trip verified (inbound → channel envelope → reply tool → sendMessage → SQLite inbound+outbound under one conversation_id)");
  process.exit(0);
} else {
  log("❌ FAIL:");
  for (const f of failures) log(`  - ${f}`);
  process.exit(1);
}

// ---- helpers ---------------------------------------------------------------
function log(...args: unknown[]) {
  console.error("[verify]", ...args);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(150);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(100);
  }
  return pred();
}
