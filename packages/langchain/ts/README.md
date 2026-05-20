# @spellguard/langchain

LangChain.js integration for Spellguard — wraps any `BaseChatModel` with automatic agent discovery and Verifier-routed A2A communication.

## Installation

```bash
pnpm add @spellguard/langchain
```

## Usage

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { createSpellguardChatModel } from '@spellguard/langchain';

const baseModel = new ChatOpenAI({ modelName: 'gpt-4o' });
const model = createSpellguardChatModel(baseModel);

// Use like any LangChain chat model — agent references are detected automatically
const result = await model.invoke([
  { role: 'user', content: 'Ask Agent B for the latest sales data' },
]);
```

## How It Works

`createSpellguardChatModel()` wraps a LangChain `BaseChatModel`:

1. Extracts the prompt from human messages
2. Detects agent references (e.g., "Agent B", "from Agent C")
3. Discovers referenced agents via A2A protocol
4. Collects their responses through the Spellguard Verifier
5. Augments the message list with gathered context
6. Delegates the final LLM call to the wrapped model

Prompts with no agent references pass through with zero overhead.

**Prerequisite:** Spellguard must be initialized before the first call (e.g., via `createSpellguard` middleware). The wrapper relies on the middleware for Verifier configuration.

## Streaming

Streaming is supported. If the wrapped model implements `_streamResponseChunks`, the wrapper delegates to it. If not, it falls back to `_generate` and yields chunks from the result.

## License

MIT
