"""Gmail API client for reading and managing emails."""

import base64
import os
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Optional

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build


class GmailClient:
    """Client for interacting with Gmail API."""

    SCOPES = [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
    ]

    def __init__(self):
        """Initialize Gmail client with credentials from environment."""
        self.creds = self._get_credentials()
        self.service = build("gmail", "v1", credentials=self.creds)
        self._label_cache: dict[str, str] = {}

    def _get_credentials(self) -> Credentials:
        """Get credentials from environment variables."""
        token = os.environ.get("GMAIL_TOKEN")
        refresh_token = os.environ.get("GMAIL_REFRESH_TOKEN")
        client_id = os.environ.get("GMAIL_CLIENT_ID")
        client_secret = os.environ.get("GMAIL_CLIENT_SECRET")

        if not all([token, refresh_token, client_id, client_secret]):
            raise ValueError(
                "Missing Gmail credentials. Required: GMAIL_TOKEN, GMAIL_REFRESH_TOKEN, "
                "GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET"
            )

        creds = Credentials(
            token=token,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=client_id,
            client_secret=client_secret,
            scopes=self.SCOPES,
        )

        if creds.expired and creds.refresh_token:
            creds.refresh(Request())

        return creds

    def _get_label_id(self, label_name: str) -> Optional[str]:
        """Get label ID by name, with caching."""
        if label_name in self._label_cache:
            return self._label_cache[label_name]

        results = self.service.users().labels().list(userId="me").execute()
        labels = results.get("labels", [])

        for label in labels:
            self._label_cache[label["name"]] = label["id"]

        return self._label_cache.get(label_name)

    def get_emails_by_label(self, label_name: str) -> list[dict]:
        """Fetch all emails with the specified label."""
        label_id = self._get_label_id(label_name)
        if not label_id:
            print(f"Label '{label_name}' not found")
            return []

        messages = []
        page_token = None

        while True:
            results = (
                self.service.users()
                .messages()
                .list(userId="me", labelIds=[label_id], pageToken=page_token)
                .execute()
            )

            if "messages" in results:
                messages.extend(results["messages"])

            page_token = results.get("nextPageToken")
            if not page_token:
                break

        return [self._get_full_message(msg["id"]) for msg in messages]

    def _get_full_message(self, message_id: str) -> dict:
        """Fetch full message content by ID."""
        message = (
            self.service.users()
            .messages()
            .get(userId="me", id=message_id, format="full")
            .execute()
        )

        headers = {h["name"]: h["value"] for h in message["payload"]["headers"]}

        body = self._extract_body(message["payload"])

        received_at = None
        if "Date" in headers:
            try:
                received_at = parsedate_to_datetime(headers["Date"]).isoformat()
            except Exception:
                received_at = datetime.now().isoformat()

        return {
            "id": message_id,
            "subject": headers.get("Subject", ""),
            "from": headers.get("From", ""),
            "received_at": received_at,
            "body": body,
        }

    def _extract_body(self, payload: dict) -> str:
        """Extract email body from payload, handling multipart messages."""
        if "body" in payload and payload["body"].get("data"):
            return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8")

        if "parts" in payload:
            for part in payload["parts"]:
                if part["mimeType"] == "text/plain" and part["body"].get("data"):
                    return base64.urlsafe_b64decode(part["body"]["data"]).decode(
                        "utf-8"
                    )

            for part in payload["parts"]:
                if part["mimeType"] == "text/html" and part["body"].get("data"):
                    return base64.urlsafe_b64decode(part["body"]["data"]).decode(
                        "utf-8"
                    )

            for part in payload["parts"]:
                if "parts" in part:
                    body = self._extract_body(part)
                    if body:
                        return body

        return ""

    def swap_label(self, message_id: str, remove_label: str, add_label: str) -> bool:
        """Remove one label and add another to a message."""
        remove_id = self._get_label_id(remove_label)
        add_id = self._get_label_id(add_label)

        if not remove_id:
            print(f"Label '{remove_label}' not found")
            return False
        if not add_id:
            print(f"Label '{add_label}' not found")
            return False

        try:
            self.service.users().messages().modify(
                userId="me",
                id=message_id,
                body={"addLabelIds": [add_id], "removeLabelIds": [remove_id]},
            ).execute()
            return True
        except Exception as e:
            print(f"Failed to swap labels for message {message_id}: {e}")
            return False
