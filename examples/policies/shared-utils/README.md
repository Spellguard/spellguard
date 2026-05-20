# Policy Shared Utilities

Shared infrastructure for building external policies that integrate with third-party APIs.

## Features

- **TTL Cache**: In-memory caching with time-to-live support
- **Rate Limiter**: Token bucket algorithm for respecting API quotas
- **API Client**: Generic HTTP client with timeout and retry support
- **Cost Tracker**: Monitor API costs across policies

## Usage

### TTL Cache

Cache API responses to reduce costs and latency:

```typescript
import { TTLCache } from 'policy-shared-utils';

const cache = new TTLCache<string>(3600000); // 1 hour TTL

// Set a value
cache.set('key', 'value');

// Get a value (returns undefined if expired)
const value = cache.get('key');

// Generate a cache key from content
const key = TTLCache.generateKey('some content', 'prefix-');
```

### Rate Limiter

Respect API rate limits:

```typescript
import { createAPIRateLimiter } from 'policy-shared-utils';

// 60 requests per minute
const limiter = createAPIRateLimiter(60);

// Try to consume a token (non-blocking)
if (limiter.tryConsume()) {
  // Make API call
}

// Wait for token (blocking with timeout)
await limiter.consume(5000); // max 5s wait
// Make API call
```

### API Client

Make HTTP requests with timeout and retry:

```typescript
import { APIClient, requireAPIKey } from 'policy-shared-utils';

const apiKey = requireAPIKey('OPENAI_API_KEY');
const client = new APIClient({
  timeout: 3000,
  retries: 2,
  headers: {
    'Authorization': `Bearer ${apiKey}`,
  },
});

const response = await client.post('https://api.example.com/endpoint', {
  data: 'value',
});

if (response.success) {
  console.log(response.data);
} else {
  console.error(response.error);
  if (response.timedOut) {
    // Handle timeout
  }
}
```

### Cost Tracker

Monitor API costs:

```typescript
import { globalCostTracker } from 'policy-shared-utils';

// Log a cost
globalCostTracker.logCost('toxicity-filter', 0.0001, 'openai', 'moderation');

// Get summary
const summary = globalCostTracker.getSummary();
console.log(`Total cost: $${summary.totalCost}`);
console.log(`By policy:`, summary.byPolicy);
console.log(`By provider:`, summary.byProvider);
```

## Complete Example

```typescript
import {
  APIClient,
  TTLCache,
  createAPIRateLimiter,
  globalCostTracker,
  requireAPIKey,
} from 'policy-shared-utils';

// Setup
const apiKey = requireAPIKey('OPENAI_API_KEY');
const client = new APIClient({ timeout: 3000 });
const cache = new TTLCache<ModerationType>(3600000);
const rateLimiter = createAPIRateLimiter(60);

async function checkContent(content: string) {
  // Check cache first
  const cacheKey = TTLCache.generateKey(content);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Rate limit
  await rateLimiter.consume();

  // Make API call
  const response = await client.post<ModerationType>(
    'https://api.openai.com/v1/moderations',
    { input: content },
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );

  if (response.success && response.data) {
    // Track cost (OpenAI moderation is free, but example)
    globalCostTracker.logCost('my-policy', 0, 'openai', 'moderation');

    // Cache result
    cache.set(cacheKey, response.data);

    return response.data;
  }

  throw new Error(response.error ?? 'API call failed');
}
```

## Best Practices

1. **Always use caching** for identical content to reduce API calls
2. **Set appropriate timeouts** (3s recommended) to avoid blocking
3. **Handle failures gracefully** with fallback behavior
4. **Track costs** to understand policy economics
5. **Respect rate limits** to avoid service disruptions
6. **Clean up caches periodically** in long-running processes

## Environment Variables

Store API keys in environment variables, not in policy configuration:

```bash
OPENAI_API_KEY=sk-...
PERSPECTIVE_API_KEY=...
AWS_ACCESS_KEY_ID=...
```

Use `requireAPIKey()` to ensure keys are present:

```typescript
const apiKey = requireAPIKey('OPENAI_API_KEY'); // Throws if missing
```
