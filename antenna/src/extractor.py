"""AI-powered signal extraction from email content."""

import json
import os
import re
from typing import Optional

import anthropic


EXTRACTION_PROMPT = """You are a financial analyst assistant. Analyze the following email and extract any stock/ETF trade signals mentioned.

For each ticker mentioned with a directional view, extract:
1. ticker: The stock/ETF symbol (uppercase, e.g., "XOM", "SPY")
2. sentiment: "bullish" or "bearish"
3. conviction: "high", "medium", or "low" (based on language strength, position sizing mentions, etc.)
4. timeframe: Expected holding period (e.g., "1-3 months", "6-12 months", "short-term", "long-term")
5. thesis: One-line summary of the investment thesis (max 100 chars)

Rules:
- Only extract tickers with clear directional views (bullish/bearish)
- Ignore tickers mentioned only as benchmarks or in passing
- If conviction is unclear, default to "medium"
- If timeframe is unclear, default to "medium-term"
- Be conservative - only extract high-confidence signals

Return a JSON array of extractions. If no valid signals found, return an empty array [].

EMAIL SUBJECT: {subject}

EMAIL BODY:
{body}

Respond ONLY with valid JSON array, no other text."""


class SignalExtractor:
    """Extract trading signals from email content using Claude."""

    def __init__(self):
        """Initialize with Anthropic client."""
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable required")
        self.client = anthropic.Anthropic(api_key=api_key)

    def extract_signals(self, subject: str, body: str) -> list[dict]:
        """Extract trading signals from email content."""
        if not body or len(body.strip()) < 50:
            return []

        prompt = EXTRACTION_PROMPT.format(subject=subject, body=body[:15000])

        try:
            response = self.client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=2000,
                messages=[{"role": "user", "content": prompt}],
            )

            response_text = response.content[0].text.strip()
            extractions = self._parse_response(response_text)
            return self._validate_extractions(extractions)

        except Exception as e:
            print(f"Extraction error: {e}")
            return []

    def _parse_response(self, response: str) -> list[dict]:
        """Parse JSON response from Claude."""
        response = response.strip()
        if response.startswith("```"):
            response = re.sub(r"^```(?:json)?\n?", "", response)
            response = re.sub(r"\n?```$", "", response)

        try:
            return json.loads(response)
        except json.JSONDecodeError:
            json_match = re.search(r"\[.*\]", response, re.DOTALL)
            if json_match:
                try:
                    return json.loads(json_match.group())
                except json.JSONDecodeError:
                    pass
            return []

    def _validate_extractions(self, extractions: list) -> list[dict]:
        """Validate and normalize extracted signals."""
        if not isinstance(extractions, list):
            return []

        valid = []
        for item in extractions:
            if not isinstance(item, dict):
                continue

            ticker = item.get("ticker", "").upper().strip()
            if not ticker or not re.match(r"^[A-Z]{1,5}$", ticker):
                continue

            sentiment = item.get("sentiment", "").lower()
            if sentiment not in ("bullish", "bearish"):
                continue

            conviction = item.get("conviction", "medium").lower()
            if conviction not in ("high", "medium", "low"):
                conviction = "medium"

            timeframe = item.get("timeframe", "medium-term")
            if not isinstance(timeframe, str):
                timeframe = "medium-term"

            thesis = item.get("thesis", "")
            if not isinstance(thesis, str):
                thesis = ""
            thesis = thesis[:150]

            valid.append(
                {
                    "ticker": ticker,
                    "sentiment": sentiment,
                    "conviction": conviction,
                    "timeframe": timeframe,
                    "thesis": thesis,
                }
            )

        return valid


def extract_source_name(from_header: str) -> str:
    """Extract clean source name from email From header."""
    if "<" in from_header:
        name = from_header.split("<")[0].strip().strip('"')
        if name:
            return name
        email = from_header.split("<")[1].split(">")[0]
        return email.split("@")[0]
    return from_header.split("@")[0] if "@" in from_header else from_header
