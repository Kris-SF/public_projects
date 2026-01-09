# The Antenna

AI-powered email signal extraction for market intelligence.

## What it does

1. Reads emails labeled `Agent-Read` from Gmail
2. Extracts: tickers, sentiment (bullish/bearish), conviction (high/medium/low), timeframe, thesis
3. Saves structured output as JSON in `signals/`
4. Swaps label from `Agent-Read` to `Agent-Processed`

## Output Schema

```json
{
  "source": "sender or publication name",
  "received_at": "email timestamp",
  "processed_at": "extraction timestamp",
  "subject": "email subject",
  "extractions": [
    {
      "ticker": "XOM",
      "sentiment": "bullish",
      "conviction": "high",
      "timeframe": "1-3 months",
      "thesis": "one-liner summary"
    }
  ]
}
```

## Setup

### 1. Gmail Labels

Create two labels in Gmail:
- `Agent-Read` - Apply to emails you want processed
- `Agent-Processed` - Signals will auto-swap to this after processing

### 2. Gmail API Credentials

1. Enable Gmail API in Google Cloud Console
2. Create OAuth 2.0 credentials
3. Generate tokens with required scopes

### 3. GitHub Secrets

Add these secrets to your repository:

| Secret | Description |
|--------|-------------|
| `GMAIL_TOKEN` | OAuth access token |
| `GMAIL_REFRESH_TOKEN` | OAuth refresh token |
| `GMAIL_CLIENT_ID` | OAuth client ID |
| `GMAIL_CLIENT_SECRET` | OAuth client secret |
| `ANTHROPIC_API_KEY` | Claude API key |

### 4. Schedule

The workflow runs automatically at:
- 8:00 AM UTC
- 6:00 PM UTC

Trigger manually via Actions tab.

## Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Set environment variables
export GMAIL_TOKEN="..."
export GMAIL_REFRESH_TOKEN="..."
export GMAIL_CLIENT_ID="..."
export GMAIL_CLIENT_SECRET="..."
export ANTHROPIC_API_KEY="..."

# Run
python -m src.antenna
```

## File Output

Signals are saved as: `signals/YYYY-MM-DD_source.json`
