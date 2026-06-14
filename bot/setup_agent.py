"""One-time setup: create the Managed Agent environment + agent.

Run this ONCE. It writes AGENT_ID, AGENT_VERSION, and ENVIRONMENT_ID into your .env file.

Usage:
    python setup_agent.py
"""

import os
import re
from pathlib import Path
import anthropic
from dotenv import load_dotenv

load_dotenv()

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

SYSTEM_PROMPT = (Path(__file__).parent / "system_prompt.md").read_text()

TOOLS = [
    {
        "type": "custom",
        "name": "get_menu_and_pricing",
        "description": (
            "Fetch the current product list — cake types, sizes, sponge flavors, cream flavors, "
            "toppings, and prices — from the live Google Sheet. "
            "Call this before presenting options to the customer or quoting any price."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "type": "custom",
        "name": "check_pickup_availability",
        "description": (
            "Check available pickup time slots for a given date and location by querying "
            "the baker's live Google Calendar. Call this after the customer picks a date "
            "and location, before confirming a specific pickup time."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "The requested pickup date in YYYY-MM-DD format",
                },
                "location": {
                    "type": "string",
                    "description": "One of: 'campbell', 'cupertino high', 'cupertino de anza'",
                },
            },
            "required": ["date", "location"],
        },
    },
    {
        "type": "custom",
        "name": "save_order",
        "description": (
            "Save the confirmed order to the Orders tab in Google Sheets. "
            "Call this after the customer explicitly confirms the full order summary. "
            "Returns the generated Order ID (e.g. 20260620-001)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "customer_name": {"type": "string"},
                "phone": {"type": "string"},
                "email": {"type": "string"},
                "pickup_date": {"type": "string", "description": "ISO date YYYY-MM-DD"},
                "pickup_time": {"type": "string", "description": "e.g. '10:00 AM'"},
                "pickup_location": {"type": "string", "description": "Campbell / Cupertino High / Cupertino De Anze"},
                "pickup_or_delivery": {"type": "string", "enum": ["Pickup", "Delivery"]},
                "delivery_address": {"type": "string"},
                "cake_type": {"type": "string"},
                "size": {"type": "string"},
                "sponge_flavor": {"type": "string"},
                "cream_flavor": {"type": "string"},
                "toppings": {"type": "string"},
                "design_notes": {"type": "string"},
                "message_on_cake": {"type": "string"},
                "allergen_notes": {"type": "string"},
                "reference_images": {"type": "string"},
                "total_price": {"type": "string"},
                "special_notes": {"type": "string"},
            },
            "required": ["customer_name", "email", "pickup_date", "cake_type", "size", "total_price"],
        },
    },
    {
        "type": "custom",
        "name": "create_calendar_event",
        "description": (
            "Create a Google Calendar pickup event and send a calendar invite to the customer. "
            "Skip this for delivery orders or out-of-window pickups that need baker review."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "customer_name": {"type": "string"},
                "customer_email": {"type": "string"},
                "pickup_datetime": {"type": "string", "description": "ISO 8601, e.g. '2026-06-20T10:00:00'"},
                "order_summary": {"type": "string", "description": "Brief description for the calendar event body"},
            },
            "required": ["customer_name", "customer_email", "pickup_datetime", "order_summary"],
        },
    },
    {
        "type": "custom",
        "name": "send_email",
        "description": "Send the order confirmation email from business@raffin.studio to the customer.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to_email": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to_email", "subject", "body"],
        },
    },
    {
        "type": "custom",
        "name": "escalate_to_baker",
        "description": (
            "Pause the conversation and ask the baker to weigh in. "
            "Use when the customer's request is outside the ordering guidelines, requires special approval, "
            "or you cannot find the answer in your knowledge. "
            "The customer will be told you're checking with the team."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "situation": {
                    "type": "string",
                    "description": "What the customer is asking and why it needs the baker's input",
                },
            },
            "required": ["situation"],
        },
    },
]


def main() -> None:
    env_path = Path(__file__).parent / ".env"
    if not env_path.exists():
        print("No .env file found — copy .env.example to .env and fill it in first.")
        raise SystemExit(1)

    # Check if already set up
    env_text = env_path.read_text()
    if "AGENT_ID=" in env_text and re.search(r"AGENT_ID=agnt_\w+", env_text):
        print("Agent already configured. Delete AGENT_ID from .env to recreate.")
        return

    print("Creating cloud environment...")
    environment = client.beta.environments.create(
        name="raffin-cake-bot",
        config={"type": "cloud", "networking": {"type": "unrestricted"}},
    )
    print(f"  Environment: {environment.id}")

    print("Creating agent...")
    agent = client.beta.agents.create(
        name="Raffin Cake Ordering Assistant",
        model="claude-opus-4-8",
        system=SYSTEM_PROMPT,
        tools=TOOLS,
    )
    print(f"  Agent: {agent.id}  (version {agent.version})")

    # Write IDs into .env
    lines = env_path.read_text().splitlines()
    updated = []
    for line in lines:
        if line.startswith("AGENT_ID="):
            updated.append(f"AGENT_ID={agent.id}")
        elif line.startswith("AGENT_VERSION="):
            updated.append(f"AGENT_VERSION={agent.version}")
        elif line.startswith("ENVIRONMENT_ID="):
            updated.append(f"ENVIRONMENT_ID={environment.id}")
        else:
            updated.append(line)
    env_path.write_text("\n".join(updated) + "\n")

    print("\nDone. .env updated. You can now run: uvicorn server:app --port 8080")


if __name__ == "__main__":
    main()
