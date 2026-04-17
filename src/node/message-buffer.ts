/**
 * @module message-buffer
 *
 * Bounded, TTL-based message buffer for store-and-forward delivery.
 *
 * Seed nodes use this to hold messages for offline peers. When a peer
 * reconnects, buffered messages are delivered via the inbox protocol.
 *
 * Messages are stored per-topic (GossipSub topic string). Each topic has
 * a bounded ring buffer that drops the oldest messages when full.
 */

/** A buffered message with metadata for delivery. */
export interface BufferedMessage {
  /** The raw serialized message bytes (protobuf). */
  data: Uint8Array;
  /** The GossipSub topic this was published on. */
  topic: string;
  /** When the message was received by the buffer. */
  receivedAt: number;
  /** SHA-256 hex of the message data, for dedup. */
  id: string;
}

export interface MessageBufferConfig {
  /** Maximum messages stored per topic. Oldest dropped when exceeded. @defaultValue 500 */
  maxPerTopic: number;
  /** Maximum total messages across all topics. @defaultValue 10000 */
  maxTotal: number;
  /** Maximum size in bytes for a single buffered message. Larger messages are rejected. @defaultValue 262144 (256KB) */
  maxMessageBytes: number;
  /** TTL in milliseconds. Messages older than this are pruned. @defaultValue 300_000 (5 min) */
  ttlMs: number;
  /** How often to run the prune cycle. @defaultValue 30_000 (30s) */
  pruneIntervalMs: number;
}

const DEFAULT_BUFFER_CONFIG: MessageBufferConfig = {
  maxPerTopic: 500,
  maxTotal: 10_000,
  maxMessageBytes: 262_144,
  ttlMs: 5 * 60_000,
  pruneIntervalMs: 30_000,
};

/**
 * In-memory message buffer with per-topic ring buffers and TTL-based expiry.
 *
 * Thread-safe for single-threaded Node.js — no locking needed.
 */
export class MessageBuffer {
  private readonly config: MessageBufferConfig;
  /** topic → messages (newest at the end) */
  private readonly topics = new Map<string, BufferedMessage[]>();
  /** Set of message IDs for dedup */
  private readonly seenIds = new Set<string>();
  private totalCount = 0;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<MessageBufferConfig>) {
    this.config = { ...DEFAULT_BUFFER_CONFIG, ...config };
  }

  /** Start the periodic prune timer. */
  start(): void {
    this.pruneTimer = setInterval(() => this.prune(), this.config.pruneIntervalMs);
  }

  /** Stop the prune timer. */
  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /**
   * Buffer a message. Returns true if stored, false if dropped (duplicate or over capacity).
   */
  push(topic: string, data: Uint8Array, id: string): boolean {
    // Dedup
    if (this.seenIds.has(id)) return false;

    // Reject oversized messages
    if (data.length > this.config.maxMessageBytes) return false;

    // Global cap — drop oldest across all topics
    if (this.totalCount >= this.config.maxTotal) {
      this.evictOldestGlobal();
    }

    let topicBuf = this.topics.get(topic);
    if (!topicBuf) {
      topicBuf = [];
      this.topics.set(topic, topicBuf);
    }

    // Per-topic cap — drop oldest in this topic
    if (topicBuf.length >= this.config.maxPerTopic) {
      const evicted = topicBuf.shift();
      if (evicted) {
        this.seenIds.delete(evicted.id);
        this.totalCount--;
      }
    }

    const msg: BufferedMessage = {
      data,
      topic,
      receivedAt: Date.now(),
      id,
    };

    topicBuf.push(msg);
    this.seenIds.add(id);
    this.totalCount++;
    return true;
  }

  /**
   * Get all buffered messages for the given topics, optionally filtered
   * by a "since" timestamp (only messages received after this time).
   *
   * Messages are returned in chronological order (oldest first).
   * They are NOT removed from the buffer — multiple peers can retrieve them.
   */
  getForTopics(topics: string[], since: number = 0, limit?: number): BufferedMessage[] {
    const result: BufferedMessage[] = [];
    const cap = limit && limit > 0 ? limit : Infinity;
    for (const topic of topics) {
      const topicBuf = this.topics.get(topic);
      if (!topicBuf) continue;
      for (const msg of topicBuf) {
        if (msg.receivedAt > since) {
          result.push(msg);
        }
      }
    }
    result.sort((a, b) => a.receivedAt - b.receivedAt);
    return cap < result.length ? result.slice(0, cap) : result;
  }

  /** Get total buffered message count. */
  getCount(): number {
    return this.totalCount;
  }

  /** Get count per topic. */
  getTopicCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [topic, buf] of this.topics) {
      counts.set(topic, buf.length);
    }
    return counts;
  }

  /** Get all topics that have buffered messages. */
  getBufferedTopics(): string[] {
    return [...this.topics.keys()].filter(t => (this.topics.get(t)?.length ?? 0) > 0);
  }

  /** Remove messages older than TTL. */
  prune(): number {
    const cutoff = Date.now() - this.config.ttlMs;
    let pruned = 0;

    for (const [topic, buf] of this.topics) {
      let i = 0;
      while (i < buf.length && buf[i].receivedAt < cutoff) {
        this.seenIds.delete(buf[i].id);
        i++;
      }
      if (i > 0) {
        buf.splice(0, i);
        pruned += i;
        this.totalCount -= i;
      }
      if (buf.length === 0) {
        this.topics.delete(topic);
      }
    }

    return pruned;
  }

  /** Evict the single oldest message across all topics. */
  private evictOldestGlobal(): void {
    let oldestTopic: string | null = null;
    let oldestTime = Infinity;

    for (const [topic, buf] of this.topics) {
      if (buf.length > 0 && buf[0].receivedAt < oldestTime) {
        oldestTime = buf[0].receivedAt;
        oldestTopic = topic;
      }
    }

    if (oldestTopic) {
      const buf = this.topics.get(oldestTopic)!;
      const evicted = buf.shift()!;
      this.seenIds.delete(evicted.id);
      this.totalCount--;
      if (buf.length === 0) this.topics.delete(oldestTopic);
    }
  }
}
