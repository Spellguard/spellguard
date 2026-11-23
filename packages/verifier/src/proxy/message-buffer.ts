// SPDX-License-Identifier: Apache-2.0

/**
 * Per-agent history for the policies that judge a sequence, not one item.
 *
 * Two ring buffers per agent, kept apart because each feeds a different leg:
 * the agent's recent outbound messages (loop detection on the message leg),
 * and its recent tool calls (sequence-gate, data-flow-taint and
 * flow-exfiltration on the tool legs, #1413).
 *
 * Both live in this process's memory: they are lost on a restart or when a
 * Durable Object is evicted, and a sequence policy then sees no history.
 */

export interface BufferedMessage {
  content: string;
  timestamp: number; // Unix timestamp in milliseconds
}

/**
 * Ring buffer for storing recent messages per agent.
 */
class AgentMessageBuffer {
  private buffer: BufferedMessage[] = [];
  private readonly maxSize: number;
  private readonly maxAgeMs: number;

  constructor(maxSize = 10, maxAgeMs = 300_000) {
    // default: 10 messages, 5 minutes
    this.maxSize = maxSize;
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * Add a message to the buffer.
   * Automatically removes old messages outside the time window.
   */
  add(content: string, timestamp = Date.now()): void {
    // Remove expired messages
    this.removeExpired(timestamp);

    // Add new message
    this.buffer.push({ content, timestamp });

    // Keep buffer size within limit (remove oldest if needed)
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  /**
   * Get recent messages within the time window.
   */
  getRecent(now = Date.now()): BufferedMessage[] {
    this.removeExpired(now);
    return [...this.buffer]; // Return copy to prevent external modification
  }

  /**
   * Remove messages older than the time window.
   */
  private removeExpired(now: number): void {
    const cutoff = now - this.maxAgeMs;
    this.buffer = this.buffer.filter((msg) => msg.timestamp >= cutoff);
  }

  /** Whether nothing in the buffer is still inside the time window. */
  isIdle(now: number): boolean {
    this.removeExpired(now);
    return this.buffer.length === 0;
  }

  /**
   * Clear all messages from buffer.
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Get current buffer size.
   */
  size(): number {
    return this.buffer.length;
  }
}

/**
 * Global message buffer registry keyed by agent ID.
 */
class MessageBufferRegistry {
  private buffers = new Map<string, AgentMessageBuffer>();
  private readonly defaultMaxSize: number;
  private readonly defaultMaxAgeMs: number;
  private lastEvictionAt = 0;

  constructor(defaultMaxSize = 10, defaultMaxAgeMs = 300_000) {
    this.defaultMaxSize = defaultMaxSize;
    this.defaultMaxAgeMs = defaultMaxAgeMs;
  }

  /**
   * Drop the buffers of agents with nothing left inside the window. A buffer
   * prunes itself only when its own agent is read or written, so without this
   * an agent that goes quiet keeps its last entries for the life of the
   * process, and memory grows with every agent ever seen. Runs on a write, at
   * most once per window.
   */
  private evictIdle(now: number): void {
    if (now - this.lastEvictionAt < this.defaultMaxAgeMs) return;
    this.lastEvictionAt = now;
    for (const [agentId, buffer] of this.buffers) {
      if (buffer.isIdle(now)) this.buffers.delete(agentId);
    }
  }

  /**
   * Get or create buffer for an agent.
   */
  getBuffer(agentId: string): AgentMessageBuffer {
    let buffer = this.buffers.get(agentId);
    if (!buffer) {
      buffer = new AgentMessageBuffer(
        this.defaultMaxSize,
        this.defaultMaxAgeMs,
      );
      this.buffers.set(agentId, buffer);
    }
    return buffer;
  }

  /**
   * Add a message for an agent.
   */
  addMessage(agentId: string, content: string, timestamp = Date.now()): void {
    this.evictIdle(timestamp);
    const buffer = this.getBuffer(agentId);
    buffer.add(content, timestamp);
  }

  /**
   * Get recent messages for an agent.
   */
  getRecentMessages(agentId: string, now = Date.now()): BufferedMessage[] {
    const buffer = this.buffers.get(agentId);
    if (!buffer) return [];
    return buffer.getRecent(now);
  }

  /**
   * Clear buffer for a specific agent.
   */
  clearAgent(agentId: string): void {
    this.buffers.delete(agentId);
  }

  /**
   * Clear all buffers (useful for testing).
   */
  clearAll(): void {
    this.buffers.clear();
    this.lastEvictionAt = 0;
  }

  /**
   * Get number of agents with active buffers.
   */
  size(): number {
    return this.buffers.size;
  }
}

// Global singleton instance
const globalRegistry = new MessageBufferRegistry();

/**
 * Add a message to the global buffer registry.
 */
export function addMessage(
  agentId: string,
  content: string,
  timestamp?: number,
): void {
  globalRegistry.addMessage(agentId, content, timestamp);
}

/**
 * Get recent messages for an agent from the global registry.
 */
export function getRecentMessages(
  agentId: string,
  now?: number,
): BufferedMessage[] {
  return globalRegistry.getRecentMessages(agentId, now);
}

/**
 * Clear buffer for a specific agent.
 */
export function clearAgentBuffer(agentId: string): void {
  globalRegistry.clearAgent(agentId);
}

/**
 * Clear all buffers (useful for testing).
 */
export function clearAllBuffers(): void {
  globalRegistry.clearAll();
  toolCallRegistry.clearAll();
}

// ── Tool-call history ────────────────────────────────────────────────

/** An agent runs many tool calls between a read and a send; keep more of them. */
const TOOL_CALL_HISTORY_SIZE = 50;
const TOOL_CALL_HISTORY_MAX_AGE_MS = 300_000;
/**
 * A tool result can be tens of kilobytes. The sequence policies match on the
 * tool's name and the head of its payload, so that is all a history entry keeps.
 */
const TOOL_CALL_HISTORY_ENTRY_MAX_CHARS = 4096;

const toolCallRegistry = new MessageBufferRegistry(
  TOOL_CALL_HISTORY_SIZE,
  TOOL_CALL_HISTORY_MAX_AGE_MS,
);

/**
 * The text a sequence policy matches a tool call on: the tool's name, then
 * its payload. The name leads so it survives truncation, and so a leg whose
 * payload does not repeat the name (`/v1/mcp/evaluate`) matches like one whose
 * payload does (`/v1/tools/check`).
 */
export function toolCallText(
  toolName: string | undefined,
  content: string,
): string {
  return toolName ? `${toolName}\n${content}` : content;
}

/**
 * The text to classify the call under evaluation by, or `null` when there is no
 * call to gate. On a tool leg the gate is on invoking the tool (the outbound
 * phase). Its result is not a send or a write whatever words it holds, so the
 * inbound phase is not classified.
 */
export function invokedCallText(ctx: {
  content: string;
  toolName?: string;
  direction?: 'inbound' | 'outbound';
}): string | null {
  if (ctx.toolName !== undefined && ctx.direction === 'inbound') return null;
  return toolCallText(ctx.toolName, ctx.content);
}

/** Record a tool call the Verifier let through, for later sequence checks. */
export function recordToolCall(
  agentId: string,
  toolName: string | undefined,
  content: string,
  timestamp?: number,
): void {
  toolCallRegistry.addMessage(
    agentId,
    toolCallText(toolName, content).slice(0, TOOL_CALL_HISTORY_ENTRY_MAX_CHARS),
    timestamp,
  );
}

/** Number of agents with a tool-call history (for tests and diagnostics). */
export function getToolCallHistoryCount(): number {
  return toolCallRegistry.size();
}

/** The agent's recent tool calls, oldest first. */
export function getRecentToolCalls(
  agentId: string,
  now?: number,
): BufferedMessage[] {
  return toolCallRegistry.getRecentMessages(agentId, now);
}

/**
 * Get number of agents with active buffers.
 */
export function getBufferCount(): number {
  return globalRegistry.size();
}
