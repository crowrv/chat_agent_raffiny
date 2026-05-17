# Candid Space — Social Content Automation Design

**Date:** 2026-05-17  
**Status:** Approved

---

## Overview

An automated pipeline that generates social media content promoting the Candid Space iOS app, routes it through a human approval step, and publishes it to Instagram, TikTok, Facebook, and LinkedIn via Buffer. Content is tailored by user-selected persona and emotional theme combinations, with AI-generated copy, background imagery, and video assembly.

---

## Target Channels & Posting Frequency

| Channel   | Format              | Frequency      |
|-----------|---------------------|----------------|
| TikTok    | Short video (Reel)  | Daily          |
| Instagram | Alternates: Reel (Mon/Wed/Fri), Image (Tue/Thu/Sat/Sun) | Daily |
| Facebook  | Static image + caption | Weekly      |
| LinkedIn  | Static image + caption | Bi-weekly   |

---

## Architecture

The system has four layers:

### 1. Scheduler
Cron jobs — one per channel — fire according to each channel's posting frequency. Each trigger initiates the persona/theme selection step.

### 2. Content Generation Engine

**Pre-generation input (via email):**
- Scheduler fires → system sends a selection email: "Time to create content for [channel]. Pick a persona and emotional theme."
- Email contains clickable links for each available persona and each available emotional theme. User clicks one from each group.
- If no response within 2 hours, the system auto-picks a persona + theme combination (avoiding recent repeats) and proceeds.

**Persona and emotional theme configuration:**
- Managed via the web dashboard (add/edit/delete)
- Each persona has a short description (e.g., "busy professional — overwhelmed, short on time, wants quick wins")
- Each emotional theme has example phrases (e.g., "stress relief — feeling overwhelmed, need to decompress, anxious thoughts")
- Stored in PostgreSQL

**Generation flow:**
1. Selected persona + emotional theme passed to Claude API with a channel-specific prompt template (Instagram tone differs from LinkedIn tone)
2. Claude generates: caption copy, text overlay hook line, CTA ("Download Candid Space — 3 minutes a day")
3. DALL-E 3 generates a background image matching the emotional theme
4. **For video formats (TikTok, Instagram Reels):** FFmpeg composites text overlay onto image with a simple fade-in animation, exported as MP4
5. **For static formats (Facebook, LinkedIn):** Text rendered onto image, exported as JPEG/PNG

Rotation logic ensures no persona + theme combination repeats within the last 5 posts per channel.

### 3. Approval Layer

**Email approval:**
- After generation, an approval email is sent containing:
  - Preview image or video thumbnail
  - Caption copy
  - Three action links: **Approve**, **Reject** (discard and skip), **Regenerate** (generate a new version with the same persona + theme)
- If no response within 24 hours, the post is auto-rejected and skipped

**Web dashboard:**
- Lists all pending drafts with the same Approve / Reject / Regenerate actions
- Shows content calendar: scheduled, pending approval, and posted history
- Basic engagement stats pulled from Buffer API (likes, shares, reach)

### 4. Publishing Layer

On approval, the system calls the Buffer API to schedule the post to the appropriate channel. Posting times are configured once per channel in the dashboard (e.g., Instagram at 9am, LinkedIn at 8am on posting days). Buffer handles delivery, format validation, and platform-specific requirements.

---

## Tech Stack

| Concern           | Technology                          |
|-------------------|-------------------------------------|
| Backend           | Node.js                             |
| Database          | PostgreSQL                          |
| Frontend          | React (web dashboard)               |
| Email             | SendGrid (tokenized action links)   |
| Copy generation   | Claude API                          |
| Image generation  | DALL-E 3                            |
| Video assembly    | FFmpeg                              |
| Social scheduling | Buffer API                          |
| Job scheduling    | Node-cron                           |

---

## Data Model (key tables)

- **personas** — id, name, description, created_at
- **emotional_themes** — id, name, example_phrases, created_at
- **selection_requests** — id, channel, token, persona_id (nullable), theme_id (nullable), status (pending | completed | timed_out), expires_at, created_at
- **content_drafts** — id, channel, persona_id, theme_id, caption, image_url, video_url, status (pending_approval | approved | rejected), created_at, approved_at
- **post_history** — id, draft_id, channel, buffer_post_id, posted_at, engagement_stats (JSONB)
- **channel_config** — channel, posting_time, auto_pick_timeout_minutes, active

---

## Email Flow Summary

| Email | Trigger | Content | Actions |
|-------|---------|---------|---------|
| Selection prompt | Cron fires | List of personas + themes | Click to select |
| Auto-pick notice | 2hr timeout | "Auto-selected: [persona] + [theme], generating now…" | None |
| Approval request | Generation complete | Preview + caption | Approve / Reject / Regenerate |
| Auto-reject notice | 24hr timeout | "Post skipped — no approval received" | None |

---

## Excluded from Scope

- Multi-user support (single operator)
- A/B testing content variants
- Paid ad creation or boosting
- Custom video footage (AI-generated imagery only)
- Analytics beyond what Buffer provides
