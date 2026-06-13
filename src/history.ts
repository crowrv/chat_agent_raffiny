import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ConversationDirection = "inbound" | "outbound";

export type ConversationEventInput = {
  direction: ConversationDirection;
  conversation_id: string;
  chat_id: string;
  message_thread_id?: string;
  message_id?: string;
  user_id?: string;
  user_name?: string;
  content: string;
};

export type ConversationEventRow = ConversationEventInput & {
  id: number;
  created_at: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const dataDir = resolve(projectRoot, "data");
const dbPath = resolve(dataDir, "conversations.db");

let db: Database | undefined;

export function initConversationDb(): void {
  mkdirSync(dataDir, { recursive: true });
  db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      conversation_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_thread_id TEXT,
      message_id TEXT,
      user_id TEXT,
      user_name TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_conversation ON conversation_events(conversation_id, created_at);
  `);
}

export function logConversationEvent(input: ConversationEventInput): number {
  const database = requireDb();
  const result = database
    .prepare(`
      INSERT INTO conversation_events (
        direction,
        conversation_id,
        chat_id,
        message_thread_id,
        message_id,
        user_id,
        user_name,
        content
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.direction,
      input.conversation_id,
      input.chat_id,
      input.message_thread_id ?? null,
      input.message_id ?? null,
      input.user_id ?? null,
      input.user_name ?? null,
      input.content,
    );
  return Number(result.lastInsertRowid);
}

export function getRecentConversationEvents(
  conversationId: string,
  limit = 10,
): ConversationEventRow[] {
  const database = requireDb();
  return database
    .prepare(`
      SELECT *
      FROM conversation_events
      WHERE conversation_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(conversationId, limit)
    .reverse() as ConversationEventRow[];
}

function requireDb(): Database {
  if (!db) initConversationDb();
  return db!;
}
