"""Google Sheets, Calendar, and Gmail tool implementations for the Raffin Cake bot."""

import base64
import os
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from pathlib import Path

from dotenv import load_dotenv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

load_dotenv()

SHEET_ID = os.environ["SHEET_ID"]
BUSINESS_EMAIL = os.environ["BUSINESS_EMAIL"]
CREDENTIALS_FILE = os.getenv("GOOGLE_CREDENTIALS_FILE", "credentials.json")
TOKEN_FILE = os.getenv("GOOGLE_TOKEN_FILE", "token.json")

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.send",
]


def _get_creds() -> Credentials:
    token_path = Path(TOKEN_FILE)
    if not token_path.exists():
        raise RuntimeError(f"Google token not found at {TOKEN_FILE}. Run auth_google.py first.")
    creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        token_path.write_text(creds.to_json())
    return creds


# ── Google Sheets ─────────────────────────────────────────────────────────────

def get_menu_and_pricing() -> str:
    """Read current product list, sizes, and prices from the Product List tab."""
    creds = _get_creds()
    service = build("sheets", "v4", credentials=creds)
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=SHEET_ID, range="Product List!A1:Z100")
        .execute()
    )
    rows = result.get("values", [])
    if not rows:
        return "No data found in Product List tab."
    lines = ["\t".join(row) for row in rows]
    return "\n".join(lines)


PICKUP_WINDOWS = {
    "campbell": {
        0: ("09:00", "14:30"),   # Mon
        2: ("09:00", "14:30"),   # Wed
        3: ("09:00", "14:30"),   # Thu
        4: ("09:00", "14:30"),   # Fri
        5: ("09:00", "11:30"),   # Sat
        6: ("09:00", "12:30"),   # Sun
    },
    "cupertino high": {5: ("12:00", "13:00")},   # Sat only
    "cupertino de anza": {3: ("16:45", "17:15")}, # Thu only
}

BAKER_CALENDAR_ID = "crowrv@gmail.com"
BAKER_TZ = "America/Los_Angeles"


def check_pickup_availability(date: str, location: str) -> str:
    """Check available pickup slots on a given date for a pickup location.

    Queries the baker's Google Calendar freebusy to find which slots within
    the pickup window are still open.

    Args:
        date: ISO date string, e.g. '2026-10-31'
        location: 'campbell', 'cupertino high', or 'cupertino de anza'
    """
    import pytz
    from datetime import timezone as tz

    location_key = location.lower().strip()
    # Fuzzy match
    if "campbell" in location_key:
        location_key = "campbell"
    elif "high" in location_key or "skvs" in location_key:
        location_key = "cupertino high"
    elif "de anza" in location_key or "deanza" in location_key:
        location_key = "cupertino de anza"

    windows = PICKUP_WINDOWS.get(location_key)
    if not windows:
        return f"Unknown location '{location}'. Valid options: Campbell, Cupertino High, Cupertino De Anza."

    try:
        d = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return f"Invalid date format '{date}'. Use YYYY-MM-DD."

    day_of_week = d.weekday()  # 0=Mon … 6=Sun
    window = windows.get(day_of_week)
    if not window:
        day_names = {0:"Mon",1:"Tue",2:"Wed",3:"Thu",4:"Fri",5:"Sat",6:"Sun"}
        available_days = [day_names[k] for k in sorted(windows.keys())]
        return (
            f"{location} is not available on {d.strftime('%A')}s. "
            f"Available days: {', '.join(available_days)}."
        )

    la_tz = pytz.timezone(BAKER_TZ)
    start_dt = la_tz.localize(datetime.strptime(f"{date} {window[0]}", "%Y-%m-%d %H:%M"))
    end_dt   = la_tz.localize(datetime.strptime(f"{date} {window[1]}", "%Y-%m-%d %H:%M"))

    creds = _get_creds()
    service = build("calendar", "v3", credentials=creds)

    body = {
        "timeMin": start_dt.isoformat(),
        "timeMax": end_dt.isoformat(),
        "timeZone": BAKER_TZ,
        "items": [{"id": BAKER_CALENDAR_ID}],
    }
    freebusy = service.freebusy().query(body=body).execute()
    busy_periods = freebusy.get("calendars", {}).get(BAKER_CALENDAR_ID, {}).get("busy", [])

    # Build 30-min slots and mark which are free
    slot_duration = timedelta(minutes=30)
    slots = []
    current = start_dt
    while current + slot_duration <= end_dt:
        slot_end = current + slot_duration
        is_busy = any(
            datetime.fromisoformat(b["start"]) < slot_end and
            datetime.fromisoformat(b["end"]) > current
            for b in busy_periods
        )
        if not is_busy:
            slots.append(current.strftime("%-I:%M %p"))
        current += slot_duration

    window_str = f"{datetime.strptime(window[0], '%H:%M').strftime('%-I:%M %p')} – {datetime.strptime(window[1], '%H:%M').strftime('%-I:%M %p')}"
    if not slots:
        return f"No available slots on {d.strftime('%A, %B %-d')} at {location}. The {window_str} window is fully booked."

    return (
        f"Available slots on {d.strftime('%A, %B %-d')} at {location} "
        f"({window_str} window):\n" + "\n".join(f"  • {s}" for s in slots)
    )


def _next_order_id(service, pickup_date: str) -> str:
    """Generate order ID in YYMM### format matching the existing sheet (e.g. 2603001)."""
    try:
        d = datetime.strptime(pickup_date, "%Y-%m-%d")
        prefix = d.strftime("%y%m")
    except ValueError:
        prefix = datetime.today().strftime("%y%m")

    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=SHEET_ID, range="주문!D2:D2000")
        .execute()
    )
    existing = [row[0] for row in result.get("values", []) if row and str(row[0]).startswith(prefix)]
    seq = len(existing) + 1
    return f"{prefix}{seq:03d}"


def save_order_to_sheet(order: dict) -> str:
    """Append a new order row to the 주문 tab. Returns the generated Order ID.

    Columns (from sheet header row):
    Year | Month | Week number | Order # | order date | pickup date | pickup time |
    Customer name | Pickup | 지인여부 | Special code | 재방문? |
    Roll | Financier | DCC | Cake | Cake type | Size | # |
    Package | Candle # | Lettering & Others | Regular | Special | Package | Candle
    """
    creds = _get_creds()
    service = build("sheets", "v4", credentials=creds)

    pickup_date_str = order.get("pickup_date", datetime.today().strftime("%Y-%m-%d"))
    order_id = _next_order_id(service, pickup_date_str)
    today = datetime.today()

    try:
        pd = datetime.strptime(pickup_date_str, "%Y-%m-%d")
        year = pd.year
        month = pd.month
        week = pd.isocalendar()[1]
        pickup_formatted = pd.strftime("%-m/%-d/%y")
    except ValueError:
        year = today.year
        month = today.month
        week = today.isocalendar()[1]
        pickup_formatted = pickup_date_str

    order_date_formatted = today.strftime("%-m/%-d/%y")
    cake_type = order.get("cake_type", "")
    is_cake = 1 if "cake" in cake_type.lower() else 0
    is_roll = 1 if "roll" in cake_type.lower() else 0

    lettering = order.get("message_on_cake", "")
    if order.get("design_notes"):
        lettering += f" | {order.get('design_notes')}"
    if order.get("allergen_notes"):
        lettering += f" | Allergens: {order.get('allergen_notes')}"
    if order.get("special_notes"):
        lettering += f" | Notes: {order.get('special_notes')}"

    row = [
        year,                                       # Year
        month,                                      # Month
        week,                                       # Week number
        order_id,                                   # Order #
        order_date_formatted,                       # order date
        pickup_formatted,                           # pickup date
        order.get("pickup_time", ""),               # pickup time
        order.get("customer_name", ""),             # Customer name
        order.get("pickup_location", "Campbell"),   # Pickup
        "",                                         # 지인여부 (acquaintance)
        "",                                         # Special code
        "",                                         # 재방문?
        is_roll,                                    # Roll
        "",                                         # Financier
        "",                                         # DCC
        is_cake,                                    # Cake
        order.get("cake_type", ""),                 # Cake type
        order.get("size", ""),                      # Size
        1,                                          # # (quantity)
        "",                                         # Package
        "",                                         # Candle #
        lettering,                                  # Lettering & Others
        order.get("total_price", ""),               # Regular price
        "",                                         # Special price
        "",                                         # Package price
        "",                                         # Candle price
    ]

    service.spreadsheets().values().append(
        spreadsheetId=SHEET_ID,
        range="주문!A1",
        valueInputOption="USER_ENTERED",
        body={"values": [row]},
    ).execute()

    return order_id


def mark_calendar_invite_sent(order_id: str) -> None:
    """Update the Calendar Invite column to 'Sent' for the given order."""
    creds = _get_creds()
    service = build("sheets", "v4", credentials=creds)
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=SHEET_ID, range="주문!D2:D2000")
        .execute()
    )
    rows = result.get("values", [])
    for i, row in enumerate(rows):
        if row and row[0] == order_id:
            row_num = i + 2  # 1-indexed, +1 for header
            # Column U = calendar invite (col index 20, letter U)
            service.spreadsheets().values().update(
                spreadsheetId=SHEET_ID,
                range=f"Orders!U{row_num}",
                valueInputOption="USER_ENTERED",
                body={"values": [["Sent"]]},
            ).execute()
            return


def mark_confirmation_email_sent(order_id: str) -> None:
    """Update the Confirmation Email column to 'Sent' for the given order."""
    creds = _get_creds()
    service = build("sheets", "v4", credentials=creds)
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=SHEET_ID, range="주문!D2:D2000")
        .execute()
    )
    rows = result.get("values", [])
    for i, row in enumerate(rows):
        if row and row[0] == order_id:
            row_num = i + 2
            service.spreadsheets().values().update(
                spreadsheetId=SHEET_ID,
                range=f"Orders!V{row_num}",
                valueInputOption="USER_ENTERED",
                body={"values": [["Sent"]]},
            ).execute()
            return


# ── Google Calendar ───────────────────────────────────────────────────────────

def create_pickup_calendar_event(
    customer_name: str,
    customer_email: str,
    pickup_datetime: str,    # ISO 8601, e.g. "2026-06-20T10:00:00"
    order_summary: str,
    duration_minutes: int = 15,
) -> str:
    """Create a Google Calendar pickup event and invite the customer. Returns event ID."""
    creds = _get_creds()
    service = build("calendar", "v3", credentials=creds)

    start = datetime.fromisoformat(pickup_datetime)
    end = start + timedelta(minutes=duration_minutes)

    event = {
        "summary": f"🎂 Raffin Cake Pickup — {customer_name}",
        "description": order_summary,
        "start": {"dateTime": start.isoformat(), "timeZone": "America/Los_Angeles"},
        "end": {"dateTime": end.isoformat(), "timeZone": "America/Los_Angeles"},
        "attendees": [
            {"email": customer_email},
            {"email": BUSINESS_EMAIL},
        ],
        "reminders": {
            "useDefault": False,
            "overrides": [{"method": "email", "minutes": 24 * 60}],
        },
    }

    created = (
        service.events()
        .insert(calendarId="primary", body=event, sendUpdates="all")
        .execute()
    )
    return created["id"]


# ── Gmail ─────────────────────────────────────────────────────────────────────

def send_confirmation_email(
    to_email: str,
    subject: str,
    body: str,
) -> str:
    """Send an order confirmation email from business@raffin.studio. Returns message ID."""
    creds = _get_creds()
    service = build("gmail", "v1", credentials=creds)

    msg = MIMEText(body, "plain", "utf-8")
    msg["From"] = f"Raffin Cake <{BUSINESS_EMAIL}>"
    msg["To"] = to_email
    msg["Bcc"] = BUSINESS_EMAIL
    msg["Subject"] = subject

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    result = service.users().messages().send(userId="me", body={"raw": raw}).execute()
    return result["id"]
