---
title: Baker Check — Human-in-the-Loop Checkpoints
tags: [escalation, human-in-the-loop, payments, policy]
updated: 2026-06-19
sources: [[raffin_sop]], [[raffin_faq]]
---

# Baker Check

> One-line: the canonical list of situations the agent must **not** decide alone — it hands these to the baker (Chloe) for a human decision, and never auto-confirms them.

The agent runs the order conversation on its own, but the items below are **human-in-the-loop checkpoints**. For each: the agent gathers what it can, tells the customer the team will follow up, and surfaces the case to the baker. The baker makes the final call. When in doubt, escalate — a wrong autonomous decision here costs money, ingredients, or trust.

Related: [[raffin_sop]] §14 (Escalation), [[raffin_faq]].

---

## 1. Payment confirmation — the agent never marks an order "paid" on its own

This is the most important checkpoint. The agent can *detect* a likely payment, but **only the baker confirms it**. An order is never treated as paid — and a slot is never released — on email evidence alone.

**How detection works.** Payments land in `business@raffin.studio` Gmail:
- **Zelle** — native, from Chase (`no.reply.alerts@chase.com`).
- **Venmo** — forwarded from `crowrv@gmail.com` (auto-forward rule).
- **PayPal** — forwarded from `crowbiz10@gmail.com` (auto-forward rule).

The agent searches for a match with the helper:

```
bun run scripts/check-payment.ts --amount <total-or-deposit> --name <customer> --days 14
```

It returns candidate payments with a **confidence**:
- **high** — amount matches *and* payer name (or an order-id memo) matches.
- **medium** — amount matches only. Common when two customers pay the same amount in the same window — these are genuinely ambiguous.

**What the agent does:** report the candidate(s) to the baker — e.g. *"Likely deposit for order 2606001: Zelle $33.00 from 'JIYEON LEE' on 6/18 (high confidence). Confirm?"* — and wait. It does **not** advance the order, send a "payment received" message, or release the date.

**What the baker checks:**
- Is this the right customer (name match), not a same-amount coincidence?
- Is the amount correct (full payment upfront, or 50% upfront when the customer chose the split option for a custom order over $200, per [[raffin_sop]] §5)?
- For any **medium**-confidence or large payment, eyeball the actual Zelle/Venmo/PayPal record before confirming.

**Known limitations** (tell the baker, don't hide them):
- Customers rarely put the order id in the memo, so name+amount+date is the usual key.
- Forwarded Venmo/PayPal carry the *forward* time as the email date — automatic forwarding keeps this ≈ the payment time; manual/batched forwarding can skew it.

---

## 2. Out-of-window pickup time

**Trigger:** customer wants a pickup time outside the standing hours of their location.
**Agent:** offer in-window alternatives; if they insist, flag **Pending — out-of-window** and say the team will follow up.
**Baker decides:** whether to make an exception (manual invite) or propose another slot. See [[raffin_sop]] §4.

## 3. Delivery requests

**Trigger:** customer asks about delivery (agent never offers it first).
**Agent:** collect address + desired date/time, say the team will email a fee + confirmation. Never quote a fee.
**Baker decides:** route feasibility and fee (internal guidance: [[raffin_sop]] §7).

## 4. Custom-design feasibility

**Trigger:** a custom design, topper, color, or technique whose feasibility isn't obvious.
**Agent:** capture the request + reference images, don't promise it's possible.
**Baker decides:** whether it's doable in the lead time and at what price.

## 5. Large or high-value orders

**Trigger:** order total **over $300**, or **50+ servings**, or half-sheet/multi-cake/event/wedding.
**Agent:** collect details, flag for review.
**Baker decides:** capacity and scheduling — these need extra lead time ([[raffin_sop]] §2).

## 6. Rush orders inside the lead-time window

**Trigger:** requested pickup is inside 48h (standard) or 1 week (custom).
**Agent:** warn plainly, suggest a later date; if the customer still wants it, flag **Rushed**.
**Baker decides:** whether that production day has capacity (cap: 3 custom, or 1 custom + 4 standard per day).

## 7. Cancellations, refunds, and modifications

**Trigger:** any cancel/refund/change to an existing order.
**Agent:** look up the order, clarify the change; **never process a refund in chat**.
**Baker decides:** applies the cancellation policy ([[raffin_sop]] §10) and handles any refund.

## 8. Allergy situations

**Trigger:** an allergy that may make the order unsafe; any **severe** (epi-pen level) allergy.
**Agent:** always disclose the kitchen handles wheat, dairy, eggs, soy, and tree nuts (no nut-free guarantee). Record allergies.
**Baker decides:** for severe allergies the order is **declined** — the cottage-food kitchen can't guarantee allergen-free ([[raffin_sop]] §9, [[raffin_faq]]).

## 9. Complaints, quality issues, no-shows

**Trigger:** any complaint, "didn't look like the photo," damaged cake, or pickup no-show.
**Agent:** be warm, gather specifics + photos, do not adjudicate or promise compensation.
**Baker decides:** resolution.

## 10. Sharing the exact Campbell address

**Trigger:** customer asks for the precise home-kitchen address.
**Agent:** give city only; the exact Campbell address is shared **after the deposit is confirmed** (checkpoint 1).
**Baker / system:** the address goes out with the confirmation once payment is verified ([[raffin_sop]] §4).

## 11. Instagram DM replies

**Trigger:** an Instagram DM arrives (auto-polled by `src/ig-source.ts` into the hub).
**Agent:** read the full thread, draft a suggested reply in Raffin's voice, and forward the customer's message + the draft to the Telegram review chat (`RAFFIN_REVIEW_TELEGRAM_CHAT_ID`, with `BAKER_TELEGRAM_CHAT_ID` kept as a legacy alias) — asking to approve, edit, or skip.
**Baker decides:** approve as-is, send an edited version, or skip — responding by the draft id shown (e.g. `approve IG-7`, `edit IG-7 <text>`, `skip IG-7`). The agent posts to Instagram (`ig.sh send_reply`) **only** on approve/edit — never auto-sends. Drafts are tracked in `scripts/ig-drafts.ts` so several can be in flight at once. See [`functions/ig-relay/CLAUDE.md`](./functions/ig-relay/CLAUDE.md).

## 12. Anything not answerable from the knowledge sources

**Trigger:** any question the agent can't answer from [[raffin_sop]], [[raffin_faq]], or the live sheet.
**Agent:** *"Great question — let me check and get right back to you."* Then escalate.
**Baker decides:** provides the answer; consider adding it to [[raffin_faq]] so the agent can handle it next time.
