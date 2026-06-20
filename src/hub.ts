#!/usr/bin/env bun
// Telegram hub: one getUpdates long-polling loop normalizes incoming messages
// into wire events and routes them over WebSocket to bound Claude sessions.
// Policy (mention rules, context, logging) lives in src/channel.ts, not here.
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type SessionInfo = {
  chatId?: string;
  label?: string;
};

type TelegramWireEvent = {
  platform: "telegram" | "instagram";
  chat_id: string;
  chat_type: string;
  chat_title?: string;
  message_thread_id?: string;
  conversation_id: string;
  message_id: string;
  content: string;
  created_timestamp: number;
  is_dm: boolean;
  mentions_bot: boolean;
  is_command: boolean;
  user_id: string;
  user_name: string;
  user_display_name: string;
  user_is_bot: boolean;
};

// Minimal slices of the Bot API types this hub actually reads.
type TgUser = { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string };
type TgChat = { id: number; type: string; title?: string };
type TgMessageEntity = { type: string; offset: number; length: number; user?: TgUser };
type TgMessage = {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  reply_to_message?: { from?: TgUser };
};
type TgUpdate = { update_id: number; message?: TgMessage };

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

loadDotEnv(resolve(projectRoot, ".env"));

const LOG_FILE = process.env.TELEGRAM_HUB_LOG_FILE || "/tmp/telegram-claude-hub.log";
const LOG_FILE_MAX_BYTES = 50 * 1024 * 1024;
let appendCount = 0;

const origConsoleError = console.error.bind(console);
const fileAppend = (line: string) => {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
    if (++appendCount % 1000 === 0) {
      try {
        if (statSync(LOG_FILE).size > LOG_FILE_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.old`);
      } catch {}
    }
  } catch {}
};

console.error = (...args: unknown[]) => {
  origConsoleError(...args);
  fileAppend(args.map(formatLogArg).join(" "));
};

const log = (...args: unknown[]) => console.error("[telegram-hub]", ...args);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  log("ERROR: TELEGRAM_BOT_TOKEN required");
  process.exit(1);
}

const HUB_ID = process.env.TELEGRAM_HUB_ID;
if (!HUB_ID) {
  log("ERROR: TELEGRAM_HUB_ID required");
  process.exit(1);
}

const API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const API = `${API_BASE}/bot${TELEGRAM_BOT_TOKEN}`;

const sessions = new Map<string, Bun.ServerWebSocket<unknown>>();
const sessionInfo = new WeakMap<Bun.ServerWebSocket<unknown>, SessionInfo>();
let fallbackWs: Bun.ServerWebSocket<unknown> | undefined;

const port = Number(process.env.TELEGRAM_HUB_PORT) || 4713;
const bindAddr = process.env.TELEGRAM_HUB_BIND_ADDR || "127.0.0.1";

Bun.serve<{ remoteAddress?: string }>({
  hostname: bindAddr,
  port,
  fetch(req, server) {
    if (server.upgrade(req, { data: { remoteAddress: server.requestIP(req)?.address } })) return;
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/ingest") {
      return handleIngest(req);
    }
    if (url.pathname === "/debug/route-event" && process.env.TELEGRAM_HUB_DEBUG_INJECT === "1") {
      return handleDebugRouteEvent(req);
    }
    return Response.json({ ok: true, name: "telegram-claude-hub" });
  },
  websocket: {
    open(ws) {
      log(`Session connected from ${ws.data.remoteAddress || "?"}`);
    },
    message(ws, msg) {
      try {
        const data = JSON.parse(String(msg));
        handleSessionMessage(ws, data);
      } catch (err) {
        log("WARN: invalid session message", err);
      }
    },
    close(ws) {
      unbindSession(ws);
    },
  },
});

// getMe must succeed before polling: mention/command detection needs the bot's
// own username and id.
let botId = 0;
let botUsername = "";
try {
  const me = await tg("getMe") as { id: number; username?: string };
  botId = me.id;
  botUsername = me.username ?? "";
  log(`Telegram ready as @${botUsername} (${botId})`);
} catch (err) {
  log("ERROR: getMe failed — check TELEGRAM_BOT_TOKEN:", err);
  process.exit(1);
}

log(`Hub ready on ${bindAddr}:${port} (instance=${HUB_ID})`);

let running = true;

const sweepInterval = setInterval(() => {
  pruneSessions();
  if (fallbackWs && fallbackWs.readyState !== WebSocket.OPEN) {
    fallbackWs = undefined;
    log("[sweep] pruned dead fallback");
  }
}, 60_000);

void pollLoop();

async function pollLoop(): Promise<void> {
  let offset: number | undefined;
  while (running) {
    try {
      const updates = await tg("getUpdates", {
        timeout: 50,
        offset,
        allowed_updates: ["message"],
      }) as TgUpdate[];
      for (const update of updates) {
        offset = update.update_id + 1;
        if (!update.message) continue;
        const event = normalizeMessage(update.message);
        if (!event) continue;
        if (event.user_is_bot) continue;
        log(
          `[message] chat=${event.chat_id} type=${event.chat_type} user=${event.user_name} content=${event.content.slice(0, 120)}`,
        );
        routeEvent(event);
      }
    } catch (err) {
      if (!running) return;
      log("getUpdates error (retrying in 3s):", err);
      await Bun.sleep(3000);
    }
  }
}

async function tg(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: params ? JSON.stringify(params) : undefined,
  });
  const data = await res.json().catch(() => undefined) as
    | { ok: boolean; result?: unknown; error_code?: number; description?: string }
    | undefined;
  if (!data || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data?.error_code ?? res.status} ${data?.description ?? ""}`);
  }
  return data.result;
}

function normalizeMessage(m: TgMessage): TelegramWireEvent | undefined {
  const content = m.text ?? m.caption;
  if (!content || !m.from) return undefined;
  const chatId = String(m.chat.id);
  // Forum-topic messages carry the topic in message_thread_id. Plain in-group
  // replies also set message_thread_id, but only is_topic_message marks a real
  // topic — gating on it keeps a normal group as ONE conversation key.
  const threadId = m.is_topic_message && m.message_thread_id != null ? String(m.message_thread_id) : undefined;
  const conversationId = threadId
    ? `telegram:chat:${chatId}:thread:${threadId}`
    : `telegram:chat:${chatId}`;
  const displayName = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ");

  return {
    platform: "telegram",
    chat_id: chatId,
    chat_type: m.chat.type,
    chat_title: m.chat.title,
    message_thread_id: threadId,
    conversation_id: conversationId,
    message_id: String(m.message_id),
    content,
    created_timestamp: m.date * 1000,
    is_dm: m.chat.type === "private",
    mentions_bot: detectMention(m, content),
    is_command: detectCommand(m, content),
    user_id: String(m.from.id),
    user_name: m.from.username ?? displayName,
    user_display_name: displayName,
    user_is_bot: m.from.is_bot,
  };
}

function detectMention(m: TgMessage, content: string): boolean {
  // Replying to one of the bot's messages is Telegram's natural way to address
  // it in a group, so it counts as a mention.
  if (m.reply_to_message?.from?.id === botId) return true;
  for (const entity of m.entities ?? m.caption_entities ?? []) {
    if (entity.type === "mention") {
      const tag = content.slice(entity.offset, entity.offset + entity.length);
      if (tag.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
    }
    if (entity.type === "text_mention" && entity.user?.id === botId) return true;
  }
  return false;
}

function detectCommand(m: TgMessage, content: string): boolean {
  const entity = (m.entities ?? []).find((e) => e.type === "bot_command" && e.offset === 0);
  if (!entity) return false;
  // "/cmd@OtherBot" in a group is addressed to a different bot.
  const raw = content.slice(0, entity.length);
  const at = raw.indexOf("@");
  if (at !== -1) return raw.slice(at + 1).toLowerCase() === botUsername.toLowerCase();
  return true;
}

function routeEvent(event: TelegramWireEvent) {
  const payload = JSON.stringify({ type: "event", event });
  if (safeSend(sessions.get(event.chat_id), payload, `chat:${event.chat_id}`)) {
    debugRoute(event, `chat:${event.chat_id}`);
    return;
  }
  if (safeSend(fallbackWs, payload, "fallback")) {
    debugRoute(event, "fallback");
    return;
  }
  log(`(unrouted) chat=${event.chat_id} | ${event.user_name}: ${event.content.slice(0, 60)}`);
}

function debugRoute(event: TelegramWireEvent, target: string) {
  log(
    `[route] target=${target} chat=${event.chat_id} thread=${event.message_thread_id || "-"} mentions_bot=${event.mentions_bot} command=${event.is_command} user=${event.user_name} content=${event.content.slice(0, 80)}`,
  );
}

function handleSessionMessage(ws: Bun.ServerWebSocket<unknown>, data: any) {
  if (data.type === "bind-chat") {
    if (!checkInstanceId(ws, data, "bind-chat")) return;
    if (!data.chatId) {
      log("WARN: bind-chat missing chatId, ignored");
      return;
    }
    const prev = sessions.get(data.chatId);
    if (rejectDuplicateBind(ws, prev, `chat:${data.chatId}`, "duplicate-chat-session")) return;
    sessions.set(data.chatId, ws);
    sessionInfo.set(ws, { chatId: data.chatId, label: data.label || data.chatId });
    log(`Bound chat: ${data.label || data.chatId} (${data.chatId})`);
    return;
  }

  if (data.type === "bind-fallback") {
    if (!checkInstanceId(ws, data, "bind-fallback")) return;
    if (rejectDuplicateBind(ws, fallbackWs, "fallback", "duplicate-fallback-session")) return;
    fallbackWs = ws;
    sessionInfo.set(ws, { label: "fallback" });
    log("Bound fallback");
    return;
  }

  if (data.type === "log") {
    const info = sessionInfo.get(ws);
    log(`[${info?.label ?? "unknown"}] ${data.message}`);
  }
}

// Generic ingestion endpoint: any local source (e.g. the Instagram feeder in
// src/ig-source.ts) POSTs a normalized wire event here and the hub routes it
// exactly like a Telegram message. Localhost-bound, so the bind address is the
// trust boundary. Requires chat_id + content; everything else gets sane defaults.
async function handleIngest(req: Request): Promise<Response> {
  try {
    const body = await req.json() as Partial<TelegramWireEvent>;
    if (!body.chat_id || !body.content) {
      return Response.json({ ok: false, error: "chat_id and content are required" }, { status: 400 });
    }
    const now = Date.now();
    const platform = body.platform === "instagram" ? "instagram" : "telegram";
    const chatId = String(body.chat_id);
    const event: TelegramWireEvent = {
      platform,
      chat_id: chatId,
      chat_type: body.chat_type || "dm",
      chat_title: body.chat_title,
      message_thread_id: body.message_thread_id,
      conversation_id: body.conversation_id || `${platform}:chat:${chatId}`,
      message_id: body.message_id || `${platform}-${now}`,
      content: body.content,
      created_timestamp: body.created_timestamp || now,
      is_dm: body.is_dm !== false,
      mentions_bot: body.mentions_bot !== false,
      is_command: body.is_command === true,
      user_id: body.user_id || chatId,
      user_name: body.user_name || chatId,
      user_display_name: body.user_display_name || body.user_name || chatId,
      user_is_bot: false,
    };
    log(`[ingest] platform=${platform} chat=${chatId} content=${event.content.slice(0, 100)}`);
    routeEvent(event);
    return Response.json({ ok: true, routed: { conversation_id: event.conversation_id } });
  } catch (err) {
    return Response.json({ ok: false, error: formatLogArg(err) }, { status: 400 });
  }
}

async function handleDebugRouteEvent(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method-not-allowed" }, { status: 405 });
  }
  try {
    const body = await req.json() as Partial<TelegramWireEvent>;
    const now = Date.now();
    const chatId = body.chat_id || "debug-chat";
    const event: TelegramWireEvent = {
      platform: "telegram",
      chat_id: chatId,
      chat_type: body.chat_type || "private",
      chat_title: body.chat_title,
      message_thread_id: body.message_thread_id,
      conversation_id: body.conversation_id || `telegram:chat:${chatId}`,
      message_id: body.message_id || `debug-${now}`,
      content: body.content || "DEBUG TEST: reply with exactly TELEGRAM_CHANNEL_OK",
      created_timestamp: body.created_timestamp || now,
      is_dm: body.is_dm !== false,
      mentions_bot: body.mentions_bot !== false,
      is_command: body.is_command === true,
      user_id: body.user_id || "debug-user",
      user_name: body.user_name || "debug-user",
      user_display_name: body.user_display_name || "Debug User",
      user_is_bot: false,
    };
    routeEvent(event);
    return Response.json({ ok: true, routed: event });
  } catch (err) {
    return Response.json({ ok: false, error: formatLogArg(err) }, { status: 400 });
  }
}

function checkInstanceId(ws: Bun.ServerWebSocket<unknown>, data: any, kind: string): boolean {
  if (data.instanceId !== HUB_ID) {
    log(`WARN: rejected ${kind} — instanceId mismatch (got=${data.instanceId ?? "missing"})`);
    safeSend(ws, JSON.stringify({ type: "error", message: "instance-mismatch", expected: HUB_ID }), "instance-mismatch");
    return false;
  }
  return true;
}

function rejectDuplicateBind(
  ws: Bun.ServerWebSocket<unknown>,
  prev: Bun.ServerWebSocket<unknown> | undefined,
  label: string,
  message: string,
): boolean {
  if (!prev || prev === ws || prev.readyState !== WebSocket.OPEN) return false;
  log(`WARN: rejected duplicate ${label} bind`);
  safeSend(ws, JSON.stringify({ type: "error", message }), label);
  try {
    ws.close(1008, message);
  } catch {}
  return true;
}

function safeSend(ws: Bun.ServerWebSocket<unknown> | undefined, payload: string, label: string): boolean {
  if (!ws) return false;
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(payload);
    return true;
  } catch (err) {
    log(`send failed [${label}]:`, err);
    return false;
  }
}

function unbindSession(ws: Bun.ServerWebSocket<unknown>) {
  const info = sessionInfo.get(ws);
  if (ws === fallbackWs) {
    fallbackWs = undefined;
    log("Unbound fallback");
    return;
  }
  if (info?.chatId && sessions.get(info.chatId) === ws) {
    sessions.delete(info.chatId);
    log(`Unbound chat: ${info.label || info.chatId} (${info.chatId})`);
  }
}

function pruneSessions() {
  for (const [key, ws] of sessions) {
    if (ws.readyState !== WebSocket.OPEN) {
      sessions.delete(key);
      log(`[sweep] pruned dead chat:${key}`);
    }
  }
}

function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["'](.*)["']$/, "$1");
    if (!process.env[key]) process.env[key] = value;
  }
}

function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function shutdown() {
  log("Shutting down...");
  running = false;
  clearInterval(sweepInterval);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// The hub is a persistent, session-independent daemon: ignore SIGHUP so closing
// the launching terminal (or the Claude session that started it) does not stop
// it. Stop it explicitly with `./hub.sh stop` (SIGTERM) instead.
process.on("SIGHUP", () => log("SIGHUP ignored (running as daemon)"));
