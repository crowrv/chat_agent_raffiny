"""Run once to generate token.json for Google API access.

Usage:
    python auth_google.py

Requires credentials.json downloaded from Google Cloud Console:
  APIs & Services → Credentials → Create OAuth 2.0 Client ID (Desktop app) → Download JSON
"""

import os
from pathlib import Path
from google_auth_oauthlib.flow import InstalledAppFlow
from dotenv import load_dotenv

load_dotenv()

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.send",
]

credentials_file = os.getenv("GOOGLE_CREDENTIALS_FILE", "credentials.json")
token_file = os.getenv("GOOGLE_TOKEN_FILE", "token.json")

if not Path(credentials_file).exists():
    print(f"ERROR: {credentials_file} not found.")
    print("Download it from Google Cloud Console → APIs & Services → Credentials")
    raise SystemExit(1)

flow = InstalledAppFlow.from_client_secrets_file(credentials_file, SCOPES)
creds = flow.run_local_server(port=0)

Path(token_file).write_text(creds.to_json())
print(f"Credentials saved to {token_file}")
