"""SQLite-backed mapping of Telegram chat_id → Managed Agent session_id."""

import sqlite3
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).parent / "sessions.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions "
        "(chat_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL)"
    )
    conn.commit()
    return conn


def get_session(chat_id: int) -> Optional[str]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT session_id FROM sessions WHERE chat_id = ?", (chat_id,)
        ).fetchone()
        return row[0] if row else None


def save_session(chat_id: int, session_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO sessions (chat_id, session_id) VALUES (?, ?)",
            (chat_id, session_id),
        )
        conn.commit()


def delete_session(chat_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM sessions WHERE chat_id = ?", (chat_id,))
        conn.commit()
