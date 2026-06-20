#!/usr/bin/env bun
// MCP channel server, one per Claude Code session. Receives wire events from
// the hub over WebSocket, wakes the session via notifications/claude/channel,
// and exposes the reply tool that posts back through Telegram sendMessage.
// Launch: TELEGRAM_CHAT=<chat_id|*> claude --dangerously-load-development-channels server:raffiny
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getRecentConversationEvents,
  initConversationDb,
  logConversationEvent,
  type ConversationEventRow,
} from "./history.js";

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

type ChatRule = "all" | "mention";

type Config = {
  chatRules?: Record<string, ChatRule>;
  defaultRule?: ChatRule;
};

const PARSE_MODES = ["HTML", "MarkdownV2", "plain"] as const;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const configPath = resolve(projectRoot, "data", "config.json");

loadDotEnv(resolve(projectRoot, ".env"));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error("[telegram-channel] ERROR: TELEGRAM_BOT_TOKEN required");
  process.exit(1);
}

const HUB_ID = process.env.TELEGRAM_HUB_ID;
if (!HUB_ID) {
  console.error("[telegram-channel] ERROR: TELEGRAM_HUB_ID required");
  process.exit(1);
}

const API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const API = `${API_BASE}/bot${TELEGRAM_BOT_TOKEN}`;

const boundChat = process.env.TELEGRAM_CHAT?.trim();
const isChatSession = !!boundChat && boundChat !== "*";
// Telegram chat the session forwards Instagram DMs to for baker review.
const bakerChat = process.env.BAKER_TELEGRAM_CHAT_ID?.trim() || "";

let hubWs: WebSocket | undefined;
let reconnect = true;
// Initialized before the top-level `await waitForHub()` below: on loopback the
// WS can open fast enough that handlers run while later `let` declarations
// would still be in TDZ, which crashes the MCP server (see Argus history).
const recentInboundByChat = new Map<string, TelegramWireEvent>();
const inboundByMessageId = new Map<string, TelegramWireEvent>();

try {
  initConversationDb();
} catch (err) {
  console.error("[telegram-channel] WARN: conversation DB init failed", err);
}

const log = (...args: unknown[]) => {
  const message = args.map(formatLogArg).join(" ");
  console.error("[telegram-channel]", message);
  if (hubWs?.readyState === WebSocket.OPEN) {
    try {
      hubWs.send(JSON.stringify({ type: "log", message }));
    } catch {}
  }
};

const soulPrompt = loadSoulPrompt();

const instructions = [
  soulPrompt ? `## Personality\n\n${soulPrompt}` : "",
  "## Channel",
  "Telegram messages arrive through the Claude channel envelope from the raffiny channel server. The envelope metadata includes channel_id (the Telegram chat_id), user_id, user_name, ts, message_id, and conversation_id.",
  "Every Telegram-originated turn must end with the reply tool, not plain assistant text. Terminal-facing assistant text is invisible to Telegram users.",
  "Reply with the reply tool. Pass chat_id, message_id, and conversation_id from the inbound metadata when responding to a user message.",
  "Telegram-specific chat, topic, mention, and command details are included in a <telegram-context> block before the message text. If message_thread_id is present (a forum topic), pass it to the reply tool so the answer lands in that topic.",
  'Formatting: by default reply text is sent with parse_mode "HTML". Use only Telegram\'s HTML subset (<b>, <i>, <u>, <s>, <a href="...">, <code>, <pre>, <blockquote>) and escape literal <, >, & as &lt;, &gt;, &amp;. Use real newlines, never <br>. For plain text pass parse_mode "plain". Keep replies concise unless the user asks for detail.',
  isChatSession
    ? `You are dedicated to Telegram chat ${boundChat}.`
    : "You are the Telegram fallback session. You receive events from every chat that has no dedicated session.",
  "## Instagram (via ig-relay) — baker-reviewed replies",
  'Some events are Instagram DMs: platform "instagram", conversation_id like instagram:thread:<name>, content prefixed `📷 Instagram DM from "<name>"`. These are baker-reviewed. Do NOT reply to the Instagram customer directly, and do NOT treat them as a Telegram conversation to answer with the reply tool.',
  `Handle an Instagram DM like this:`,
  `1. Read the full thread for context: \`IG_OPEN="<name>" docs/functions/ig-relay/ig.sh read_inbox\`.`,
  `2. Draft a suggested reply in Raffin's voice, grounded in the knowledge sources.`,
  `3. Register the draft so it can be tracked: \`IG_DRAFT_NAME="<name>" IG_DRAFT_MESSAGE="<customer message>" IG_DRAFT_REPLY="<your draft>" bun run scripts/ig-drafts.ts add\`. It returns a draft id like IG-7.`,
  `4. Forward it to the baker for review with the reply tool, chat_id ${bakerChat || "<set BAKER_TELEGRAM_CHAT_ID in .env>"} — include the draft id, the sender name, the customer's message, and your suggested reply, and tell the baker to respond with "approve IG-7", "edit IG-7 <new text>", or "skip IG-7".`,
  `5. When a baker Telegram message references a draft id: load it with \`bun run scripts/ig-drafts.ts get <id>\` to recover the IG name. For approve/edit, send the final text to Instagram: \`IG_OPEN="<name from draft>" IG_TEXT="<final text>" docs/functions/ig-relay/ig.sh send_reply\`, then \`IG_DRAFT_FINAL="<final text>" bun run scripts/ig-drafts.ts resolve <id> sent\`. For skip, \`bun run scripts/ig-drafts.ts resolve <id> skipped\` and send nothing.`,
  `Never send to Instagram without an approved draft id. \`bun run scripts/ig-drafts.ts list --pending\` shows drafts still awaiting the baker. See docs/baker_check.md.`,
].filter(Boolean).join("\n");

const mcp = new Server(
  { name: "raffiny", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
      tools: {},
    },
    instructions,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a Telegram message via the bot. For user replies, pass message_id to create a native Telegram reply to the inbound message. Text is sent with parse_mode HTML by default — use Telegram's HTML subset and escape literal <, >, & — or pass parse_mode 'plain' for unformatted text.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "Telegram chat ID from the inbound metadata (channel_id)" },
          text: { type: "string", description: "Message content" },
          message_id: { type: "string", description: "Optional Telegram message ID to native-reply to" },
          message_thread_id: { type: "string", description: "Optional forum topic ID from the inbound <telegram-context>; required to answer inside a group topic" },
          conversation_id: { type: "string", description: "Conversation location key from the inbound message" },
          parse_mode: { type: "string", enum: [...PARSE_MODES], description: "Formatting mode for text. Default HTML. 'plain' sends without a parse_mode." },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

  if (name !== "reply") return text(`Unknown tool: ${name}`);
  if (typeof a.chat_id !== "string" || !a.chat_id) {
    return { ...text("Rejected: chat_id is required."), isError: true };
  }
  if (typeof a.text !== "string" || !a.text.trim()) {
    return { ...text("Rejected: text is required."), isError: true };
  }
  const parseModeArg = typeof a.parse_mode === "string" ? a.parse_mode : "HTML";
  if (!PARSE_MODES.includes(parseModeArg as typeof PARSE_MODES[number])) {
    return { ...text(`Rejected: parse_mode must be one of ${PARSE_MODES.join(", ")}.`), isError: true };
  }
  const parseMode = parseModeArg === "plain" ? undefined : parseModeArg;
  const chatId = a.chat_id;
  const replyToMessageId = typeof a.message_id === "string" && a.message_id ? a.message_id : undefined;
  const recent = replyToMessageId
    ? inboundByMessageId.get(replyToMessageId) ?? recentInboundByChat.get(chatId)
    : recentInboundByChat.get(chatId);
  const threadId = typeof a.message_thread_id === "string" && a.message_thread_id
    ? a.message_thread_id
    : recent?.message_thread_id;

  const result = await sendTelegramMessage({
    chatId,
    text: a.text,
    messageId: replyToMessageId,
    threadId,
    parseMode,
  });
  if (!result.ok) return { ...text(`Rejected: ${result.error}`), isError: true };

  const conversationId = typeof a.conversation_id === "string" && a.conversation_id
    ? a.conversation_id
    : recent?.conversation_id
      ?? (threadId ? `telegram:chat:${chatId}:thread:${threadId}` : `telegram:chat:${chatId}`);
  try {
    logConversationEvent({
      direction: "outbound",
      conversation_id: conversationId,
      chat_id: chatId,
      message_thread_id: threadId,
      message_id: result.messageId,
      user_id: "telegram-bot",
      user_name: "Claude",
      content: a.text,
    });
  } catch (err) {
    log("WARN: outbound log failed:", err);
  }
  return text(result.fallbackNote ? `sent (${result.fallbackNote})` : "sent");
});

await mcp.connect(new StdioServerTransport());
log("MCP connected");

await waitForHub();
log("Ready.");

async function handleHubEvent(event: TelegramWireEvent) {
  const decision = acceptDecision(event);
  if (!decision.accept) {
    log(
      `Ignored event: reason=${decision.reason} chat=${event.chat_id} mentions_bot=${event.mentions_bot} command=${event.is_command} conversation=${event.conversation_id}`,
    );
    return;
  }
  log(
    `Accepted event: reason=${decision.reason} chat=${event.chat_id} mentions_bot=${event.mentions_bot} command=${event.is_command} conversation=${event.conversation_id}`,
  );

  // Context is loaded BEFORE inserting the current message so it contains only
  // prior turns.
  const recentEvents = safeRecentConversationEvents(event.conversation_id, 10);
  recentInboundByChat.set(event.chat_id, event);
  inboundByMessageId.set(event.message_id, event);
  if (inboundByMessageId.size > 500) {
    const first = inboundByMessageId.keys().next().value;
    if (first) inboundByMessageId.delete(first);
  }
  try {
    logConversationEvent({
      direction: "inbound",
      conversation_id: event.conversation_id,
      chat_id: event.chat_id,
      message_thread_id: event.message_thread_id,
      message_id: event.message_id,
      user_id: event.user_id,
      user_name: event.user_name,
      content: event.content,
    });
  } catch (err) {
    log("WARN: inbound log failed:", err);
  }

  void sendTypingIndicator(event.chat_id, event.message_thread_id);
  await forwardToClaudeChannel(event, formatConversationContext(recentEvents));
}

async function forwardToClaudeChannel(event: TelegramWireEvent, contextBlock: string) {
  const content = [formatTelegramContext(event), contextBlock, event.content].join("");
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content,
        meta: {
          channel_id: event.chat_id,
          user_id: event.user_id,
          user_name: event.user_name,
          user_level: "member",
          ts: new Date(event.created_timestamp).toISOString(),
          message_id: event.message_id,
          conversation_id: event.conversation_id,
        },
      },
    });
    log(`Forwarded event to Claude channel: message=${event.message_id} conversation=${event.conversation_id}`);
  } catch (err) {
    log("ERROR: Claude channel notification failed:", err);
  }
}

function formatTelegramContext(event: TelegramWireEvent): string {
  const attrs = [
    ["chat_id", event.chat_id],
    ["chat_type", event.chat_type],
    ["chat_title", event.chat_title],
    ["message_thread_id", event.message_thread_id],
    ["conversation_id", event.conversation_id],
    ["message_id", event.message_id],
    ["user_id", event.user_id],
    ["user_name", event.user_name],
    ["user_display_name", event.user_display_name],
    ["is_dm", String(event.is_dm)],
    ["mentions_bot", String(event.mentions_bot)],
    ["is_command", String(event.is_command)],
  ]
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
    .join(" ");
  return `<telegram-context ${attrs}></telegram-context>\n\n`;
}

function acceptDecision(event: TelegramWireEvent): { accept: boolean; reason: string } {
  if (isChatSession && event.chat_id !== boundChat) {
    return { accept: false, reason: "different-chat" };
  }
  if (event.is_dm) return { accept: true, reason: "dm-direct" };

  const rule = chatRuleFor(event.chat_id);
  if (rule === "all") return { accept: true, reason: "rule-all" };
  if (event.mentions_bot) return { accept: true, reason: "rule-mention" };
  if (event.is_command) return { accept: true, reason: "rule-command" };
  return { accept: false, reason: "rule-mention-without-mention" };
}

function chatRuleFor(chatId: string): ChatRule {
  const config = loadConfig();
  return config.chatRules?.[chatId] ?? config.defaultRule ?? "mention";
}

function bindPayload(): Record<string, unknown> {
  const base = { instanceId: HUB_ID };
  if (isChatSession) return { ...base, type: "bind-chat", chatId: boundChat, label: boundChat };
  return { ...base, type: "bind-fallback" };
}

function hubAddress(): string {
  const host = process.env.TELEGRAM_HUB_HOST || "127.0.0.1";
  const port = process.env.TELEGRAM_HUB_PORT || "4713";
  if (host.startsWith("ws://") || host.startsWith("wss://")) return host;
  return host.includes(":") ? `ws://${host}` : `ws://${host}:${port}`;
}

async function connectToHub() {
  if (!reconnect) return;
  const addr = hubAddress();
  try {
    const ws = new WebSocket(addr);
    ws.onopen = () => {
      hubWs = ws;
      ws.send(JSON.stringify(bindPayload()));
      log(`Connected to hub at ${addr}`);
    };
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(String(msg.data));
        if (data.type === "error") {
          log(`ERROR from hub: ${data.message}`);
          if (data.message === "duplicate-chat-session" || data.message === "duplicate-fallback-session" || data.message === "instance-mismatch") {
            reconnect = false;
            process.exit(1);
          }
          return;
        }
        if (data.type === "event") void handleHubEvent(data.event as TelegramWireEvent);
      } catch (err) {
        log("WARN: hub message handling failed:", err);
      }
    };
    ws.onclose = () => {
      hubWs = undefined;
      if (!reconnect) return;
      log("Hub connection lost; reconnecting in 3s...");
      setTimeout(connectToHub, 3000);
    };
    ws.onerror = () => {};
  } catch {
    setTimeout(connectToHub, 3000);
  }
}

async function waitForHub() {
  log(`Waiting for hub at ${hubAddress()}...`);
  await connectToHub();
  let waited = 0;
  while (!hubWs) {
    await Bun.sleep(100);
    waited += 100;
    if (waited % 30_000 === 0) log(`Still waiting for hub at ${hubAddress()}...`);
  }
}

async function sendTypingIndicator(chatId: string, threadId?: string): Promise<void> {
  // Telegram's typing indicator auto-expires after ~5s; one shot per inbound
  // event is enough feedback without a refresh loop.
  try {
    const body: Record<string, unknown> = { chat_id: chatId, action: "typing" };
    if (threadId) body.message_thread_id = Number(threadId);
    await fetch(`${API}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log("WARN: typing indicator failed:", err);
  }
}

async function sendTelegramMessage(args: {
  chatId: string;
  text: string;
  messageId?: string;
  threadId?: string;
  parseMode?: string;
}): Promise<{ ok: true; messageId?: string; fallbackNote?: string } | { ok: false; error: string }> {
  const body: Record<string, unknown> = {
    chat_id: args.chatId,
    text: args.text,
  };
  if (args.parseMode) body.parse_mode = args.parseMode;
  if (args.threadId) body.message_thread_id = Number(args.threadId);
  if (args.messageId) {
    body.reply_parameters = {
      message_id: Number(args.messageId),
      allow_sending_without_reply: true,
    };
  }

  const first = await postSendMessage(body);
  if (first.ok) return first;

  // Formatting rejections (400 can't parse entities) would otherwise eat the
  // reply; resend as plain text so the user always gets the content.
  if (args.parseMode && first.status === 400 && /parse|entit/i.test(first.error)) {
    const { parse_mode: _dropped, ...plainBody } = body;
    const second = await postSendMessage(plainBody);
    if (second.ok) {
      return { ...second, fallbackNote: `parse_mode=${args.parseMode} rejected by Telegram, delivered as plain text — fix your formatting next time: ${first.error}` };
    }
    return second;
  }
  return first;
}

async function postSendMessage(
  body: Record<string, unknown>,
): Promise<{ ok: true; messageId?: string } | { ok: false; error: string; status: number }> {
  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => undefined) as
    | { ok: boolean; result?: { message_id?: number }; error_code?: number; description?: string }
    | undefined;
  if (data?.ok) {
    return { ok: true, messageId: data.result?.message_id != null ? String(data.result.message_id) : undefined };
  }
  return {
    ok: false,
    error: `Telegram API ${data?.error_code ?? res.status}: ${data?.description ?? "unknown error"}`,
    status: data?.error_code ?? res.status,
  };
}

function safeRecentConversationEvents(conversationId: string, limit: number): ConversationEventRow[] {
  try {
    return getRecentConversationEvents(conversationId, limit);
  } catch (err) {
    log("WARN: recent context load failed:", err);
    return [];
  }
}

function formatConversationContext(events: ConversationEventRow[]): string {
  if (events.length === 0) return "";
  const lines = events.map((event) => {
    const speaker = event.direction === "outbound"
      ? "assistant"
      : event.user_name || event.user_id || "unknown";
    const body = event.content.replace(/\s+/g, " ").trim().slice(0, 500);
    return `[${event.direction}] ${speaker}: ${body}`;
  });
  return `<conversation-context events="${events.length}">\n${lines.join("\n")}\n</conversation-context>\n\n`;
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

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Config;
  } catch {
    return { defaultRule: "mention" };
  }
}

// Optional persona, injected into the MCP server instructions as ## Personality.
// Absent SOUL.md -> instructions carry only the channel protocol (unchanged).
function loadSoulPrompt(): string {
  try {
    const path = resolve(projectRoot, "SOUL.md");
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  reconnect = false;
  try {
    hubWs?.close();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
