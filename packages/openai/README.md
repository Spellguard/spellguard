# @spellguard/openai

OpenAI SDK integration for Spellguard — wraps an OpenAI client with automatic agent discovery and Verifier-routed A2A communication.

## Installation

```bash
pnpm add @spellguard/openai
```

## Usage

```typescript
import OpenAI from 'openai';
import { wrapOpenAI } from '@spellguard/openai';

const openai = new OpenAI();
const client = wrapOpenAI(openai);

// Use exactly like a normal OpenAI client
const result = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Analyse data from Agent B' }],
});
```

## How It Works

`wrapOpenAI()` intercepts `client.chat.completions.create()`:

1. Extracts the prompt from user messages
2. Detects agent references (e.g., "Agent B", "from Agent C")
3. Discovers referenced agents via A2A protocol
4. Collects their responses through the Spellguard Verifier
5. Augments the message list with gathered context
6. Delegates the call to the real OpenAI API

Prompts with no agent references pass through with zero overhead.

**Prerequisite:** Spellguard must be initialized before the first call (e.g., via `createSpellguard` middleware). The wrapper relies on the middleware for Verifier configuration.

## License

MIT
