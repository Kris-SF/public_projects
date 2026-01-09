"""The Antenna - Main orchestrator for email signal extraction."""

import json
import os
import re
from datetime import datetime
from pathlib import Path

from .gmail_client import GmailClient
from .extractor import SignalExtractor, extract_source_name


class Antenna:
    """Main agent that orchestrates email reading, extraction, and output."""

    SOURCE_LABEL = "Agent-Read"
    PROCESSED_LABEL = "Agent-Processed"

    def __init__(self, output_dir: str = "signals"):
        """Initialize The Antenna."""
        self.gmail = GmailClient()
        self.extractor = SignalExtractor()
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def run(self) -> list[dict]:
        """Run the full extraction pipeline."""
        print(f"[Antenna] Starting signal extraction at {datetime.now().isoformat()}")

        emails = self.gmail.get_emails_by_label(self.SOURCE_LABEL)
        print(f"[Antenna] Found {len(emails)} emails with label '{self.SOURCE_LABEL}'")

        results = []
        for email in emails:
            result = self._process_email(email)
            if result:
                results.append(result)

        print(f"[Antenna] Processed {len(results)} emails with signals")
        return results

    def _process_email(self, email: dict) -> dict | None:
        """Process a single email: extract signals, save, and swap labels."""
        message_id = email["id"]
        subject = email["subject"]
        body = email["body"]
        received_at = email["received_at"]
        from_header = email["from"]

        print(f"[Antenna] Processing: {subject[:50]}...")

        extractions = self.extractor.extract_signals(subject, body)

        if not extractions:
            print(f"[Antenna] No signals found in: {subject[:50]}")
            self._swap_label(message_id)
            return None

        source_name = extract_source_name(from_header)
        processed_at = datetime.now().isoformat()

        result = {
            "source": source_name,
            "received_at": received_at,
            "processed_at": processed_at,
            "subject": subject,
            "extractions": extractions,
        }

        self._save_result(result, source_name)
        self._swap_label(message_id)

        print(
            f"[Antenna] Extracted {len(extractions)} signals from: {source_name}"
        )
        return result

    def _save_result(self, result: dict, source_name: str) -> Path:
        """Save extraction result to JSON file."""
        date_str = datetime.now().strftime("%Y-%m-%d")
        safe_source = re.sub(r"[^\w\-]", "_", source_name)[:50]

        base_filename = f"{date_str}_{safe_source}.json"
        filepath = self.output_dir / base_filename

        counter = 1
        while filepath.exists():
            base_filename = f"{date_str}_{safe_source}_{counter}.json"
            filepath = self.output_dir / base_filename
            counter += 1

        with open(filepath, "w") as f:
            json.dump(result, f, indent=2)

        print(f"[Antenna] Saved to {filepath}")
        return filepath

    def _swap_label(self, message_id: str) -> None:
        """Swap email label from Agent-Read to Agent-Processed."""
        success = self.gmail.swap_label(
            message_id, self.SOURCE_LABEL, self.PROCESSED_LABEL
        )
        if success:
            print(f"[Antenna] Label swapped for message {message_id[:8]}...")
        else:
            print(f"[Antenna] WARNING: Failed to swap label for {message_id[:8]}...")


def main():
    """CLI entrypoint."""
    output_dir = os.environ.get("SIGNALS_OUTPUT_DIR", "signals")
    antenna = Antenna(output_dir=output_dir)
    results = antenna.run()

    print(f"\n[Antenna] Complete. Processed {len(results)} emails with signals.")

    total_signals = sum(len(r["extractions"]) for r in results)
    print(f"[Antenna] Total signals extracted: {total_signals}")

    if results:
        print("\n[Antenna] Summary:")
        for r in results:
            tickers = ", ".join(e["ticker"] for e in r["extractions"])
            print(f"  - {r['source']}: {tickers}")


if __name__ == "__main__":
    main()
