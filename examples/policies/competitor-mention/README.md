# Competitor Mention Policy

An example external policy server that detects mentions of competitor brands in content.

## Usage

```bash
# From this directory
pnpm install
pnpm dev

# Or from repo root
pnpm --filter competitor-mention-policy dev
```

The server runs on port 3100 by default (configurable via `PORT` env var).

## Testing

```bash
# Should return a detection
curl -X POST http://localhost:3100 -H "Content-Type: application/json" \
  -d '{"content": "What about using OpenAI?", "policyId": "test", "policySlug": "competitor-mention"}'

# Should return empty array
curl -X POST http://localhost:3100 -H "Content-Type: application/json" \
  -d '{"content": "Hello world", "policyId": "test", "policySlug": "competitor-mention"}'

# Health check
curl http://localhost:3100/health
```

## Configuration

The policy accepts the following config options:

- `competitors`: Array of competitor names to detect (default: openai, anthropic, google, microsoft, meta)
- `blockMentions`: Whether to block or just flag mentions (default: true)
- `minConfidence`: Confidence score for detections (default: 0.8)

Example with custom config:
```bash
curl -X POST http://localhost:3100 -H "Content-Type: application/json" \
  -d '{
    "content": "Let us use AWS instead",
    "policyId": "test",
    "policySlug": "competitor-mention",
    "config": {
      "competitors": ["aws", "azure", "gcp"],
      "blockMentions": false
    }
  }'
```
