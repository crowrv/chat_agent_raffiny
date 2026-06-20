---
title: Raffin LLM Wiki — Index
tags: [index, catalog, wiki]
updated: 2026-06-19
---

# Raffin LLM Wiki — Index

> Content catalog for the `docs/` knowledge base. Each entry is one page with a one-line summary, organized by category. Start here, then drill into the page you need. The **schema** that tells the agent how to use these pages is [`../CLAUDE.md`](../CLAUDE.md).

---

## Raffin Ordering Agent — Knowledge Base

The pages the ordering agent reads to serve customers. Cross-referenced with `[[wikilinks]]`.

| Page | Summary |
|------|---------|
| [[raffin_sop]] — [`raffin_sop.md`](./raffin_sop.md) | Internal **operating procedures**: lead times, pickup locations/hours, payment & 50% deposit rules, production workflow, packaging/labeling, allergen handling, cancellation policy, MEHKO licensing, and the escalation list. |
| [[raffin_faq]] — [`raffin_faq.md`](./raffin_faq.md) | **Pre-approved answers** to the questions customers ask most (ordering, lead time, pricing, pickup/delivery, flavors, allergens, storage, cancellations). Consult before improvising. |
| [[baker_check]] — [`baker_check.md`](./baker_check.md) | **Human-in-the-loop checkpoints** — what the agent must hand to the baker instead of deciding alone: payment confirmation (#1), out-of-window pickup, delivery, custom/large orders, rush orders, cancellations/refunds, allergies, complaints, address sharing. |
| [`agent/system_prompt.md`](./agent/system_prompt.md) | Standalone system-prompt version of the persona + step-by-step ordering flow, preserved from the earlier build. The live operating contract is [`../CLAUDE.md`](../CLAUDE.md); this is kept for reference. |

**Schema & tooling (outside `docs/`):**
- [`../CLAUDE.md`](../CLAUDE.md) — the operating contract: persona, conversation flow, `gws` CLI usage, payment verification, guardrails.
- [`../scripts/check-payment.ts`](../scripts/check-payment.ts) — detects Zelle/Venmo/PayPal payments in `business@raffin.studio` Gmail (used by [[baker_check]] §1).

---

## ig-relay — Manual Instagram DM Assistant

A separate, on-demand tool (not part of the ordering agent): reads Instagram DMs via `browser-harness` and sends replies after per-message approval.

| Page | Summary |
|------|---------|
| [`functions/ig-relay/README.md`](./functions/ig-relay/README.md) | Overview of the manual IG DM assistant and the read → approve → send loop. |
| [`functions/ig-relay/CLAUDE.md`](./functions/ig-relay/CLAUDE.md) | The ig-relay contract: scope, safety rules, and the exact manual workflow. |
| [`superpowers/specs/2026-05-29-ig-relay-manual-dm-assistant-design.md`](./superpowers/specs/2026-05-29-ig-relay-manual-dm-assistant-design.md) | Design doc for the redesign from an always-on Discord worker to a manual assistant. |
| [`superpowers/plans/2026-05-29-ig-relay-manual-dm-assistant.md`](./superpowers/plans/2026-05-29-ig-relay-manual-dm-assistant.md) | Task-by-task implementation plan for the redesign. |

---

## Conventions

- Pages are plain markdown; related pages link with `[[wikilinks]]` (the file's `name` without `.md`) and/or relative paths.
- Pages with `---` YAML frontmatter carry `title`, `tags`, and `updated`.
- When a page is added, moved, or its purpose changes, update this index in the same edit.
