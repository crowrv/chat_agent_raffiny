#!/usr/bin/env bun
// ig-drafts.ts — state tracking for baker-reviewed Instagram replies.
//
// Each Instagram DM the session drafts a reply for gets a short draft id
// (IG-1, IG-2, …) stored with the IG conversation name + the suggested text.
// The baker reviews on Telegram and responds by id ("approve IG-7", "skip IG-7",
// or an edit). The session resolves the draft by id, so multiple drafts can be
// in flight at once without correlation guesswork.
//
// Store: JSON at IG_DRAFTS_FILE (default /tmp/ig-drafts.json) — kept out of the
// repo because it holds customer message text.
//
//   IG_DRAFT_NAME="Sara kim" IG_DRAFT_MESSAGE="…" IG_DRAFT_REPLY="…" \
//     bun run scripts/ig-drafts.ts add          # -> { "id": "IG-7", ... }
//   bun run scripts/ig-drafts.ts get IG-7
//   bun run scripts/ig-drafts.ts list [--pending]
//   IG_DRAFT_FINAL="…" bun run scripts/ig-drafts.ts resolve IG-7 sent
//   bun run scripts/ig-drafts.ts resolve IG-7 skipped
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FILE = process.env.IG_DRAFTS_FILE || "/tmp/ig-drafts.json";

type Draft = {
  id: string;
  name: string;
  thread_id: string | null;
  message: string;
  reply: string;
  status: "pending" | "sent" | "skipped";
  created_at: string;
  resolved_at: string | null;
  final: string | null;
};
type Store = { nextId: number; drafts: Record<string, Draft> };

function load(): Store {
  if (!existsSync(FILE)) return { nextId: 1, drafts: {} };
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Store;
  } catch {
    return { nextId: 1, drafts: {} };
  }
}
function save(s: Store) {
  writeFileSync(FILE, JSON.stringify(s, null, 2));
}
function out(v: unknown) {
  console.log(JSON.stringify(v, null, 2));
}
function fail(msg: string): never {
  console.error("ERROR:", msg);
  process.exit(1);
}

const store = load();

function requireDraft(id: string | undefined): Draft {
  if (!id) fail("draft id is required");
  const d = store.drafts[id];
  if (!d) fail(`no such draft: ${id}`);
  return d;
}

const [cmd, ...rest] = Bun.argv.slice(2);

switch (cmd) {
  case "add": {
    const name = process.env.IG_DRAFT_NAME?.trim();
    const reply = process.env.IG_DRAFT_REPLY;
    if (!name) fail("IG_DRAFT_NAME is required");
    if (!reply) fail("IG_DRAFT_REPLY is required");
    const id = `IG-${store.nextId++}`;
    const draft: Draft = {
      id,
      name,
      thread_id: process.env.IG_DRAFT_THREAD?.trim() || null,
      message: process.env.IG_DRAFT_MESSAGE ?? "",
      reply,
      status: "pending",
      created_at: new Date().toISOString(),
      resolved_at: null,
      final: null,
    };
    store.drafts[id] = draft;
    save(store);
    out(draft);
    break;
  }
  case "get": {
    out(requireDraft(rest[0]));
    break;
  }
  case "list": {
    const all = Object.values(store.drafts);
    out(rest.includes("--pending") ? all.filter((d) => d.status === "pending") : all);
    break;
  }
  case "resolve": {
    const d = requireDraft(rest[0]);
    const status = rest[1];
    if (status !== "sent" && status !== "skipped") fail("status must be 'sent' or 'skipped'");
    d.status = status;
    d.resolved_at = new Date().toISOString();
    if (process.env.IG_DRAFT_FINAL != null) d.final = process.env.IG_DRAFT_FINAL;
    save(store);
    out(d);
    break;
  }
  default:
    fail("usage: ig-drafts.ts <add | get <id> | list [--pending] | resolve <id> <sent|skipped>>");
}
