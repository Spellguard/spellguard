# @spellguard/policy-sdk

SDK for building Spellguard external policy servers.

## Installation

```bash
pnpm add @spellguard/policy-sdk
```

## Quick Start

```typescript
import { BasePolicyEngine, servePolicyEngine } from '@spellguard/policy-sdk';
import type { Detection, PolicyRequest } from '@spellguard/policy-sdk';

class MyPolicy extends BasePolicyEngine {
  name = 'my-policy';

  evaluate(request: PolicyRequest): Detection[] {
    const detections: Detection[] = [];

    // Your custom logic here
    if (request.content.toLowerCase().includes('secret')) {
      detections.push(
        this.detection('secret-detected', 0.9, 'Found secret keyword')
      );
    }

    return detections;
  }
}

// Start the server on port 3100
servePolicyEngine(new MyPolicy(), { port: 3100 });
```

## API

### Types

```typescript
interface Detection {
  type: string;           // Detection label (e.g., 'pii-email')
  confidence: number;     // 0-1 confidence score
  message?: string;       // Human-readable message
  metadata?: Record<string, unknown>;
}

interface PolicyRequest {
  content: string;        // Content to evaluate
  policyId: string;       // Policy UUID
  policySlug: string;     // Policy slug
  config?: Record<string, unknown>;  // User config
}
```

### BasePolicyEngine

Abstract base class with helper methods:

- `detection(type, confidence, message?, metadata?)` - Create a detection
- `getConfig<T>(request, key, default)` - Get config value with default
- `containsAny(content, values)` - Check if content contains any string (case-insensitive)
- `matchesAny(content, patterns)` - Check if content matches any regex
- `countMatches(content, pattern)` - Count pattern occurrences

### Server Functions

- `servePolicyEngine(engine, config?)` - Create and start server immediately
- `createPolicyServer(engine, config?)` - Create server with manual start
- `createPolicyApp(engine, config?)` - Get Hono app for custom serving

### ServerConfig

```typescript
interface ServerConfig {
  port?: number;         // Default: 3000
  basePath?: string;     // Default: /
  logging?: boolean;     // Default: true
  healthPath?: string;   // Default: /health
}
```

## Testing

```typescript
import { mockRequest, hasDetection } from '@spellguard/policy-sdk/testing';

const request = mockRequest('test content', {
  config: { threshold: 0.5 }
});

const detections = await engine.evaluate(request);
expect(hasDetection(detections, 'my-type')).toBe(true);
```

## Example

See `examples/policies/competitor-mention/` for a complete example.
