"""Telegram ↔ Claude Managed Agent bridge for Raffin Cake.

Start:
    uvicorn server:app --host 0.0.0.0 --port 8080

Then register your webhook:
    curl "https://api.telegram.org/bot{TOKEN}/setWebhook?url={WEBHOOK_URL}/webhook"
"""

import asyncio
import json
import logging
import os
from typing import Any, Optional

import anthropic
import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Request

import google_tools
import session_store

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
BAKER_CHAT_ID = int(os.environ["BAKER_CHAT_ID"])
AGENT_ID = os.environ["AGENT_ID"]
AGENT_VERSION = os.environ["AGENT_VERSION"]
ENVIRONMENT_ID = os.environ["ENVIRONMENT_ID"]

TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"
MAX_MSG_LEN = 4096  # Telegram hard limit

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

# baker_chat_id → {tool_use_id, session_id, customer_chat_id}
pending_escalations: dict[int, dict] = {}

app = FastAPI()


# ── Telegram helpers ──────────────────────────────────────────────────────────

def _send(chat_id: int, text: str) -> None:
    """Send a text message to a Telegram chat, splitting at 4096 chars if needed."""
    if not text.strip():
        return
    chunks = [text[i : i + MAX_MSG_LEN] for i in range(0, len(text), MAX_MSG_LEN)]
    with httpx.Client(timeout=15) as http:
        for chunk in chunks:
            http.post(f"{TELEGRAM_API}/sendMessage", json={"chat_id": chat_id, "text": chunk})


# ── Session management ────────────────────────────────────────────────────────

def _get_or_create_session(chat_id: int) -> str:
    session_id = session_store.get_session(chat_id)
    if session_id:
        return session_id

    log.info("Creating new session for chat %d", chat_id)
    session = client.beta.sessions.create(
        agent={"type": "agent", "id": AGENT_ID, "version": AGENT_VERSION},
        environment_id=ENVIRONMENT_ID,
    )
    session_store.save_session(chat_id, session.id)
    return session.id


# ── Custom tool execution ─────────────────────────────────────────────────────

def _execute_tool(name: str, tool_input: dict, customer_chat_id: int, session_id: str) -> Optional[str]:
    """Execute a custom tool. Returns the result string, or None if escalation was triggered."""
    try:
        if name == "get_menu_and_pricing":
            return google_tools.get_menu_and_pricing()

        if name == "check_pickup_availability":
            return google_tools.check_pickup_availability(
                date=tool_input.get("date", ""),
                location=tool_input.get("location", ""),
            )

        if name == "save_order":
            order_id = google_tools.save_order_to_sheet(tool_input)
            return f"Order saved successfully. Order ID: {order_id}"

        if name == "create_calendar_event":
            event_id = google_tools.create_pickup_calendar_event(
                customer_name=tool_input["customer_name"],
                customer_email=tool_input["customer_email"],
                pickup_datetime=tool_input["pickup_datetime"],
                order_summary=tool_input["order_summary"],
            )
            # Extract order_id from session store context isn't straightforward here;
            # the agent will handle the sheet update via a follow-up save_order call if needed.
            return f"Calendar event created. Event ID: {event_id}"

        if name == "send_email":
            msg_id = google_tools.send_confirmation_email(
                to_email=tool_input["to_email"],
                subject=tool_input["subject"],
                body=tool_input["body"],
            )
            return f"Confirmation email sent. Message ID: {msg_id}"

        if name == "escalate_to_baker":
            return None  # Handled separately in the agent loop

        return f"Unknown tool: {name}"

    except Exception as exc:
        log.error("Tool %s failed: %s", name, exc, exc_info=True)
        return f"Tool execution failed: {exc}"


# ── Agent turn loop ───────────────────────────────────────────────────────────

def _run_agent_turn(
    customer_chat_id: int,
    session_id: str,
    user_text: Optional[str] = None,
) -> None:
    """Stream one agent turn, handle tool calls, and recurse if tools were executed.

    If escalate_to_baker is called, the loop pauses and stores the pending escalation.
    The baker's reply (received via webhook) will call this function again with no user_text.
    """
    with client.beta.sessions.events.stream(session_id=session_id) as stream:
        if user_text is not None:
            client.beta.sessions.events.send(
                session_id=session_id,
                events=[{
                    "type": "user.message",
                    "content": [{"type": "text", "text": user_text}],
                }],
            )

        tool_calls: list[Any] = []

        for event in stream:
            if event.type == "agent.message":
                text_blocks = [b.text for b in event.content if b.type == "text"]
                response = "\n".join(t for t in text_blocks if t)
                if response:
                    _send(customer_chat_id, response)

            elif event.type == "agent.custom_tool_use":
                log.info("Tool call: %s | input: %s", event.name, json.dumps(event.input)[:200])
                tool_calls.append(event)

            elif event.type == "session.status_idle":
                usage = getattr(event, "usage", None)
                if usage:
                    log.info(
                        "Turn complete | chat=%d | in=%s out=%s cache_read=%s cache_write=%s",
                        customer_chat_id,
                        getattr(usage, "input_tokens", "?"),
                        getattr(usage, "output_tokens", "?"),
                        getattr(usage, "cache_read_input_tokens", "?"),
                        getattr(usage, "cache_creation_input_tokens", "?"),
                    )
                break

            elif event.type == "session.status_terminated":
                break

    if not tool_calls:
        return

    # Check for escalation first (only one can be pending at a time)
    escalation_call = next((c for c in tool_calls if c.name == "escalate_to_baker"), None)
    if escalation_call:
        situation = escalation_call.input.get("situation", "(no details provided)")
        pending_escalations[BAKER_CHAT_ID] = {
            "tool_use_id": escalation_call.id,
            "session_id": session_id,
            "customer_chat_id": customer_chat_id,
        }
        _send(
            BAKER_CHAT_ID,
            f"⚠️ *Escalation needed*\n\nCustomer chat ID: {customer_chat_id}\n\n{situation}\n\n"
            f"Reply here with your decision — your message will be sent directly back to the agent.",
        )
        _send(customer_chat_id, "I need to check with the Raffin team on this — I'll get back to you shortly! 🎂")
        return

    # Execute all non-escalation tool calls
    results = []
    for call in tool_calls:
        result = _execute_tool(call.name, call.input, customer_chat_id, session_id)
        if result is not None:
            results.append({
                "type": "user.custom_tool_result",
                "custom_tool_use_id": call.id,
                "content": [{"type": "text", "text": result}],
            })

    if results:
        client.beta.sessions.events.send(session_id=session_id, events=results)
        _run_agent_turn(customer_chat_id, session_id)  # Continue after tool results


def _resolve_escalation(baker_decision: str) -> None:
    """Send the baker's decision back to the agent and resume the paused session."""
    escalation = pending_escalations.pop(BAKER_CHAT_ID, None)
    if not escalation:
        _send(BAKER_CHAT_ID, "No pending escalation found.")
        return

    session_id = escalation["session_id"]
    tool_use_id = escalation["tool_use_id"]
    customer_chat_id = escalation["customer_chat_id"]

    client.beta.sessions.events.send(
        session_id=session_id,
        events=[{
            "type": "user.custom_tool_result",
            "custom_tool_use_id": tool_use_id,
            "content": [{"type": "text", "text": baker_decision}],
        }],
    )

    _send(BAKER_CHAT_ID, f"✅ Decision sent. Resuming conversation with customer {customer_chat_id}.")
    _run_agent_turn(customer_chat_id, session_id)  # Resume the session, no new user message


# ── Background task entry point ───────────────────────────────────────────────

def _handle_message(chat_id: int, text: str) -> None:
    # Commands
    if text == "/neworder":
        session_store.delete_session(chat_id)
        _send(chat_id, "Starting a fresh order! 🎂\n\nHi there! Welcome to Raffin Cake! What's the occasion, and when do you need the cake by?")
        return

    # Baker responding to escalation
    if chat_id == BAKER_CHAT_ID and BAKER_CHAT_ID in pending_escalations:
        _resolve_escalation(text)
        return

    # Normal customer (or baker messaging without a pending escalation)
    try:
        session_id = _get_or_create_session(chat_id)
        _run_agent_turn(chat_id, session_id, text)
    except Exception as exc:
        log.error("Error handling message for chat %d: %s", chat_id, exc, exc_info=True)
        _send(chat_id, "Sorry, something went wrong on our end. Please try again in a moment! 🙏")


# ── FastAPI routes ────────────────────────────────────────────────────────────

@app.post("/webhook")
async def telegram_webhook(request: Request, background_tasks: BackgroundTasks):
    body = await request.json()
    message = body.get("message") or body.get("edited_message")
    if not message:
        return {"ok": True}

    chat_id: Optional[int] = message.get("chat", {}).get("id")
    text: str = message.get("text", "").strip()

    if not chat_id or not text:
        return {"ok": True}

    # Run in background so Telegram gets a fast 200 OK
    background_tasks.add_task(asyncio.to_thread, _handle_message, chat_id, text)
    return {"ok": True}


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.on_event("startup")
async def startup():
    """Register the Telegram webhook on server start."""
    webhook_url = os.getenv("WEBHOOK_URL", "").rstrip("/")
    if not webhook_url:
        log.warning("WEBHOOK_URL not set — skipping webhook registration")
        return
    async with httpx.AsyncClient() as http:
        r = await http.get(f"{TELEGRAM_API}/setWebhook", params={"url": f"{webhook_url}/webhook"})
        log.info("Webhook registration: %s", r.json())
