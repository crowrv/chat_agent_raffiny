# Raffin Cake Telegram Bot

A FastAPI server that bridges Telegram customers to a Claude Managed Agent, which runs the Raffin Cake ordering flow.

## Architecture

```
Customer (Telegram)
       │
       ▼
  Telegram Bot API
       │  webhook POST /webhook
       ▼
  server.py  (FastAPI)
  ├── session_store.py  →  SQLite (chat_id → session_id)
  ├── google_tools.py   →  Google Sheets / Calendar / Gmail
  └── Claude Managed Agent  (Anthropic API)
            │ escalate_to_baker tool
            ▼
       Baker (Telegram)
```

**One session per Telegram conversation.** The customer keeps chatting in the same thread; the agent remembers context across messages. `/neworder` resets the session.

**Baker escalation:** When the agent calls `escalate_to_baker`, the server pauses and sends you (the baker) a Telegram message with the situation. Your reply is fed back to the agent to resume the conversation.

---

## Setup

### 1 — Create the Telegram Bot

Message `@BotFather` on Telegram → `/newbot` → follow prompts → copy the **Bot Token**.

Find your own Telegram user ID by messaging `@userinfobot`.

### 2 — Set up Google APIs

1. Go to [Google Cloud Console](https://console.cloud.google.com) → create a project.
2. Enable: **Google Sheets API**, **Google Calendar API**, **Gmail API**.
3. Create an **OAuth 2.0 Client ID** (Desktop app) → Download the JSON → save as `bot/credentials.json`.
4. Run the auth flow once:
   ```bash
   cd bot
   python auth_google.py
   ```
   This opens a browser, asks you to log in to the Google account that owns the sheet/calendar/gmail, and saves `token.json`.

### 3 — Configure environment

```bash
cp .env.example .env
```

Fill in:
- `TELEGRAM_BOT_TOKEN`
- `BAKER_CHAT_ID` (your Telegram user ID)
- `ANTHROPIC_API_KEY`
- `WEBHOOK_URL` (your public HTTPS server URL, e.g. from ngrok or Fly.io)
- Leave `AGENT_ID`, `AGENT_VERSION`, `ENVIRONMENT_ID` blank for now.

### 4 — Create the Managed Agent (once)

```bash
cd bot
pip install -r requirements.txt
python setup_agent.py
```

This creates the Claude Managed Agent and cloud environment, then writes the IDs into your `.env`.

### 5 — Start the server

```bash
cd bot
uvicorn server:app --host 0.0.0.0 --port 8080
```

On startup, the server registers the Telegram webhook automatically (requires `WEBHOOK_URL` to be set and reachable from the internet).

**For local development**, use [ngrok](https://ngrok.com):
```bash
ngrok http 8080
# copy the https:// URL into WEBHOOK_URL in .env, then restart the server
```

---

## Customer Commands

| Command | Effect |
|---|---|
| Any text | Continues the ordering conversation |
| `/neworder` | Resets the session and starts fresh |

## Baker Commands

When an escalation comes in, you'll receive a Telegram message with the situation. **Just reply with your decision** — that text goes directly back to the agent.

---

## Files

| File | Purpose |
|---|---|
| `setup_agent.py` | One-time agent + environment creation |
| `server.py` | FastAPI webhook server (main entry point) |
| `session_store.py` | SQLite: Telegram chat_id → Managed Agent session_id |
| `google_tools.py` | Google Sheets, Calendar, Gmail implementations |
| `auth_google.py` | One-time OAuth2 flow to generate `token.json` |
| `system_prompt.md` | Agent system prompt (edit to update agent behavior) |
| `requirements.txt` | Python dependencies |
| `.env.example` | Environment variable template |

> **Updating the agent's behavior:** Edit `system_prompt.md`, then re-run `setup_agent.py` with the old `AGENT_ID` removed from `.env`. A new agent version will be created.
