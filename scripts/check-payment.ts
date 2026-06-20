#!/usr/bin/env bun
// scripts/check-payment.ts — find Zelle / Venmo / PayPal payment notifications
// in the business@raffin.studio inbox and match them against an expected payment.
//
//   bun run scripts/check-payment.ts --amount 50               # any $50 payment, last 10 days
//   bun run scripts/check-payment.ts --amount 66 --name Lee    # $66 from a payer named ~Lee
//   bun run scripts/check-payment.ts --amount 125 --days 60    # widen the date window
//   bun run scripts/check-payment.ts --order 2606001           # match an order id in the memo
//
// Reads Gmail via the gws CLI (authenticated as business@raffin.studio). Zelle
// arrives natively from Chase; Venmo and PayPal arrive as forwarded messages.
// Prints a JSON array of candidate payments (with a match confidence) to stdout
// and a human-readable summary to stderr.
import { $ } from "bun";

type Method = "zelle" | "venmo" | "paypal";
type Payment = {
  method: Method;
  payer: string;
  amount: number;
  amountText: string;
  date: string;
  memo?: string;
  subject: string;
  messageId: string;
  confidence?: "high" | "medium";
};

type Opts = { amount?: number; name?: string; order?: string; days: number };

function parseArgs(argv: string[]): Opts {
  const o: Opts = { days: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--amount") o.amount = num(argv[++i]);
    else if (a === "--name") o.name = argv[++i];
    else if (a === "--order") o.order = argv[++i];
    else if (a === "--days") o.days = Number(argv[++i]) || 10;
  }
  return o;
}

const num = (s: string) => parseFloat(String(s).replace(/[,$]/g, ""));

async function gws(args: string[]): Promise<any> {
  const out = await $`gws ${args}`.text();
  const i = out.indexOf("{");
  if (i < 0) throw new Error("gws returned no JSON");
  return JSON.parse(out.slice(i));
}

function classify(subject: string, snippet: string, date: string, id: string): Payment | null {
  let m = subject.match(/^(?:Fwd:\s*)?(.+?) paid you \$([\d,]+\.\d{2})/i);
  if (m) return mk("venmo", m[1], m[2], date, subject, id);

  m = subject.match(/^(?:Fwd:\s*)?(.+?) sent you \$([\d,]+\.\d{2})\s*USD/i);
  if (m) return mk("paypal", m[1], m[2], date, subject, id);

  if (/received money with Zelle/i.test(subject)) {
    const payer = snippet.match(/Zelle\W+payment\s+(.+?)\s+sent you money/i)?.[1] ?? "";
    const amt = snippet.match(/Amount\s+\$([\d,]+\.\d{2})/i)?.[1];
    // The snippet runs the memo into Zelle boilerplate ("<name> is registered
    // with a Zelle® member bank …"); cut that trailing text off.
    let memo = snippet.match(/Memo\s+(.+?)\s*$/i)?.[1];
    if (memo) memo = memo.replace(/\s+\S.*?\bis registered with\b.*$/i, "").trim();
    if (amt) {
      const p = mk("zelle", payer, amt, date, subject, id);
      p.memo = memo;
      return p;
    }
  }
  return null;
}

function mk(method: Method, payer: string, amtText: string, date: string, subject: string, id: string): Payment {
  return { method, payer: payer.trim(), amount: num(amtText), amountText: amtText, date, subject, messageId: id };
}

function matches(p: Payment, o: Opts): boolean {
  const amountOk = o.amount == null || Math.abs(p.amount - o.amount) < 0.005;
  const orderOk = o.order != null && (p.memo ?? "").toLowerCase().includes(o.order.toLowerCase());
  if (o.amount == null && o.order == null) return true; // no filter → list all in window
  return amountOk || orderOk;
}

function scoreConfidence(p: Payment, o: Opts): "high" | "medium" {
  const amountOk = o.amount != null && Math.abs(p.amount - o.amount) < 0.005;
  const nameOk = o.name != null && p.payer.toLowerCase().includes(o.name.toLowerCase());
  const orderOk = o.order != null && (p.memo ?? "").toLowerCase().includes(o.order.toLowerCase());
  return (amountOk && (nameOk || orderOk)) || orderOk ? "high" : "medium";
}

async function main() {
  const o = parseArgs(Bun.argv.slice(2));
  const q =
    `(subject:"paid you $" OR subject:"sent you $" OR subject:"received money with Zelle") ` +
    `newer_than:${o.days}d`;

  const list = await gws([
    "gmail", "users", "messages", "list",
    "--params", JSON.stringify({ userId: "me", q, maxResults: 40 }),
  ]);
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);

  const found: Payment[] = [];
  for (const id of ids) {
    try {
      const msg = await gws([
        "gmail", "users", "messages", "get",
        "--params", JSON.stringify({
          userId: "me", id, format: "metadata",
          metadataHeaders: ["Subject", "Date"],
        }),
      ]);
      const h: Record<string, string> = {};
      for (const x of msg.payload?.headers ?? []) h[x.name] = x.value;
      const p = classify(h.Subject ?? "", msg.snippet ?? "", h.Date ?? "", id);
      if (p && matches(p, o)) {
        p.confidence = scoreConfidence(p, o);
        found.push(p);
      }
    } catch {
      // skip messages that fail to fetch/parse
    }
  }

  found.sort((a, b) => (a.confidence === "high" ? -1 : 1) - (b.confidence === "high" ? -1 : 1));

  // Human summary → stderr; machine-readable JSON → stdout.
  if (found.length === 0) {
    console.error("No matching payment found.");
  } else {
    console.error(`Found ${found.length} candidate payment(s):`);
    for (const p of found) {
      console.error(
        `  [${p.confidence}] ${p.method.toUpperCase()} $${p.amount.toFixed(2)} ` +
        `from "${p.payer}"${p.memo ? ` memo="${p.memo}"` : ""} — ${p.date}`,
      );
    }
  }
  console.log(JSON.stringify(found, null, 2));
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
