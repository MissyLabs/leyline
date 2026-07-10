/**
 * @module inbound-budget
 *
 * Unified inbound cost governor for the Leyline network.
 *
 * Centralizes the two token-burn defenses that were previously inline in
 * `MagicNode.handleIncomingMessage`:
 *
 *  1. A **global** sliding-window cap on how many messages may be delivered to
 *     application handlers per minute (across ALL senders and ALL delivery
 *     paths — GossipSub broadcast, direct messages, and inbox store-and-forward).
 *  2. A **per-sender** payload-byte budget per minute.
 *
 * Injecting a single `InboundBudget` into every delivery path guarantees that
 * an attacker cannot bypass the cost cap by choosing a different transport
 * (e.g. flooding direct messages instead of broadcasts).
 *
 * The governor is deliberately side-effect free apart from the optional
 * `onShed` callback — callers decide how to react (drop, report spam, log).
 */

/** Reason a message was shed (rejected) by the budget. */
export type BudgetShedReason = 'global_rate' | 'payload_bytes';

export interface InboundBudgetConfig {
  /**
   * Global inbound message delivery cap per minute across all senders/paths.
   * Set to 0 to disable the global cap.
   */
  maxInboundPerMinute: number;
  /**
   * Maximum total payload bytes accepted per sender per minute.
   * Set to 0 to disable the per-sender byte budget.
   */
  maxPayloadBytesPerMinute: number;
}

export interface AdmitResult {
  /** True if the message may be delivered to handlers. */
  admitted: boolean;
  /** Populated when `admitted` is false. */
  reason?: BudgetShedReason;
}

const WINDOW_MS = 60_000;

/**
 * Governs inbound message admission using a global per-minute rate window and a
 * per-sender payload-byte budget.
 */
export class InboundBudget {
  private readonly config: InboundBudgetConfig;
  /** Ascending timestamps of admitted messages in the current global window. */
  private inboundTimestamps: number[] = [];
  /** Per-sender payload byte counters: senderHex -> { bytes, windowStart }. */
  private payloadBudgets = new Map<string, { bytes: number; windowStart: number }>();
  /** Optional observer invoked whenever a message is shed. */
  private readonly onShed?: (reason: BudgetShedReason, senderHex: string) => void;

  constructor(config: InboundBudgetConfig, onShed?: (reason: BudgetShedReason, senderHex: string) => void) {
    this.config = config;
    this.onShed = onShed;
  }

  /**
   * Returns true if the global rate window currently has room for at least one
   * more message, WITHOUT recording anything. Used by the inbox ingest path to
   * stop fetching/processing early once the window is full (RL-2).
   */
  hasGlobalCapacity(now: number = Date.now()): boolean {
    if (this.config.maxInboundPerMinute <= 0) return true;
    this.pruneGlobal(now);
    return this.inboundTimestamps.length < this.config.maxInboundPerMinute;
  }

  /**
   * Attempt to admit a message from `senderHex` carrying `payloadBytes` bytes.
   *
   * Applies the global rate cap first (matching the historical ordering in
   * `handleIncomingMessage`): when the global window is full nothing is
   * recorded and the message is shed as backpressure. Otherwise the message is
   * counted globally and the per-sender byte budget is charged; exceeding the
   * byte budget sheds the message (the bytes still count for the window, as
   * before).
   */
  admit(senderHex: string, payloadBytes: number, now: number = Date.now()): AdmitResult {
    // 1. Global inbound rate cap (token-burn backpressure).
    if (this.config.maxInboundPerMinute > 0) {
      this.pruneGlobal(now);
      if (this.inboundTimestamps.length >= this.config.maxInboundPerMinute) {
        this.onShed?.('global_rate', senderHex);
        return { admitted: false, reason: 'global_rate' };
      }
      this.inboundTimestamps.push(now);
    }

    // 2. Per-sender payload byte budget.
    if (this.config.maxPayloadBytesPerMinute > 0) {
      let budget = this.payloadBudgets.get(senderHex);
      if (!budget || now - budget.windowStart > WINDOW_MS) {
        budget = { bytes: 0, windowStart: now };
        this.payloadBudgets.set(senderHex, budget);
      }
      budget.bytes += Math.max(0, payloadBytes);
      if (budget.bytes > this.config.maxPayloadBytesPerMinute) {
        this.onShed?.('payload_bytes', senderHex);
        this.evictStale(now);
        return { admitted: false, reason: 'payload_bytes' };
      }
      this.evictStale(now);
    }

    return { admitted: true };
  }

  /** Prune global-window timestamps older than the window using binary search. */
  private pruneGlobal(now: number): void {
    const cutoff = now - WINDOW_MS;
    let lo = 0;
    let hi = this.inboundTimestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.inboundTimestamps[mid] < cutoff) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) this.inboundTimestamps = this.inboundTimestamps.slice(lo);
  }

  /** Periodically evict stale per-sender budget entries to bound memory. */
  private evictStale(now: number): void {
    if (this.payloadBudgets.size <= 1000) return;
    for (const [key, b] of this.payloadBudgets) {
      if (now - b.windowStart > 2 * WINDOW_MS) this.payloadBudgets.delete(key);
    }
  }

  /** Number of messages currently counted in the global window. */
  getInboundCount(now: number = Date.now()): number {
    this.pruneGlobal(now);
    return this.inboundTimestamps.length;
  }

  /** Clear all state (used on shutdown). */
  clear(): void {
    this.inboundTimestamps = [];
    this.payloadBudgets.clear();
  }
}
