// SPDX-License-Identifier: Apache-2.0

/**
 * Message buffer for loop detection.
 *
 * Maintains per-agent ring buffers of recent messages with timestamps
 * to detect repetitive patterns over time.
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

  constructor(defaultMaxSize = 10, defaultMaxAgeMs = 300_000) {
    this.defaultMaxSize = defaultMaxSize;
    this.defaultMaxAgeMs = defaultMaxAgeMs;
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
}

/**
 * Get number of agents with active buffers.
 */
export function getBufferCount(): number {
  return globalRegistry.size();
}
