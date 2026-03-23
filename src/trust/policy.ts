/**
 * Trust policy engine for a P2P network.
 *
 * Enforces a deny-first policy with per-agent and per-tag granularity.
 * All unknown senders are blocked unless explicitly allowed.
 */

/** Sliding window entry tracking message timestamps for rate limiting. */
interface SenderWindow {
  timestamps: number[];
}

/**
 * Per-agent trust configuration.
 *
 * `allowed` reflects agent-level whitelist state. `blocked` overrides it.
 * Tag maps are consulted only when an agent passes the agent-level check.
 */
interface AgentPolicy {
  allowed: boolean;
  blocked: boolean;
  allowedTags: Set<string>;
  blockedTags: Set<string>;
}

/**
 * Deny-first trust policy engine for P2P message routing.
 *
 * Evaluation order for `isAllowed`:
 * 1. Agent-level block — immediately denied.
 * 2. Agent-level allow — required to proceed.
 * 3. Tag-level block — denied if any supplied tag is blocked for this agent.
 * 4. Tag-level allow — required for every supplied tag (if any tag rules exist).
 *
 * When no tags are supplied, only the agent-level check applies.
 */
export class TrustPolicy {
  readonly #agents: Map<string, AgentPolicy> = new Map();
  /** Tags open to ANY sender (unknown agents pass if message matches an open tag). */
  readonly #openTags: Set<string> = new Set();

  #getOrCreate(pubkeyHex: string): AgentPolicy {
    let policy = this.#agents.get(pubkeyHex);
    if (policy === undefined) {
      policy = {
        allowed: false,
        blocked: false,
        allowedTags: new Set(),
        blockedTags: new Set(),
      };
      this.#agents.set(pubkeyHex, policy);
    }
    return policy;
  }

  /**
   * Whitelist an agent.
   * Has no effect if the agent is also blocked — `blockAgent` always wins.
   */
  allowAgent(pubkeyHex: string): void {
    this.#getOrCreate(pubkeyHex).allowed = true;
  }

  /**
   * Blacklist an agent.
   * Overrides any prior or future `allowAgent` call for the same key.
   */
  blockAgent(pubkeyHex: string): void {
    const policy = this.#getOrCreate(pubkeyHex);
    policy.blocked = true;
    policy.allowed = false;
  }

  /** Allow an agent to send messages carrying a specific tag. */
  allowTag(pubkeyHex: string, tag: string): void {
    const policy = this.#getOrCreate(pubkeyHex);
    policy.blockedTags.delete(tag);
    policy.allowedTags.add(tag);
  }

  /** Block an agent from sending messages carrying a specific tag. */
  blockTag(pubkeyHex: string, tag: string): void {
    const policy = this.#getOrCreate(pubkeyHex);
    policy.allowedTags.delete(tag);
    policy.blockedTags.add(tag);
  }

  /**
   * Open a tag to ALL senders. Any agent — even unknown ones — can send
   * messages carrying this tag without being individually whitelisted.
   *
   * Agent-level blocks still override: a blocked agent cannot send on open
   * tags. This enables open discovery and marketplace patterns while
   * preserving the ability to ban bad actors.
   */
  allowTagOpen(tag: string): void {
    this.#openTags.add(tag);
  }

  /**
   * Close a previously opened tag. Messages on this tag revert to
   * deny-first (require per-agent allowAgent).
   */
  closeTag(tag: string): void {
    this.#openTags.delete(tag);
  }

  /** Returns true if the given tag is open to all senders. */
  isTagOpen(tag: string): boolean {
    return this.#openTags.has(tag);
  }

  /** Return a snapshot of all open tags. */
  getOpenTags(): string[] {
    return [...this.#openTags];
  }

  /**
   * Determine whether a message from `pubkeyHex` bearing `tags` is allowed.
   *
   * Evaluation order:
   * 1. Agent-level block — immediately denied (overrides everything including open tags).
   * 2. Agent-level allow — if the agent is whitelisted, check tag rules as before.
   * 3. Open tag check — if ANY of the message's tags are open, the message is allowed
   *    even from unknown senders (unless the sender is explicitly blocked).
   * 4. Otherwise — denied (deny-first default).
   *
   * @returns `true` only when all checks pass.
   */
  isAllowed(pubkeyHex: string, tags: string[]): boolean {
    const policy = this.#agents.get(pubkeyHex);

    // Agent-level block overrides everything — even open tags.
    if (policy?.blocked) return false;

    // If agent is explicitly allowed, use the per-agent tag rules
    if (policy?.allowed) {
      // No tags to check — agent-level pass is sufficient.
      if (tags.length === 0) return true;

      const hasTagRules =
        policy.allowedTags.size > 0 || policy.blockedTags.size > 0;

      for (const tag of tags) {
        // Tag-level block denies immediately.
        if (policy.blockedTags.has(tag)) return false;

        // If tag rules exist, every tag must be explicitly allowed.
        if (hasTagRules && !policy.allowedTags.has(tag)) return false;
      }

      return true;
    }

    // Agent is not explicitly allowed — check open tags.
    // For unknown senders, EVERY tag on the message must be open.
    // This prevents abuse where an attacker tags a message with both an open tag
    // and a private tag to sneak past trust on the open tag.
    if (this.#openTags.size > 0 && tags.length > 0) {
      let allOpen = true;
      for (const tag of tags) {
        if (!this.#openTags.has(tag)) {
          allOpen = false;
          break;
        }
      }
      if (allOpen) return true;
    }

    // Deny-first default.
    return false;
  }

  /** Return a snapshot of all explicitly blocked agent public keys. */
  getBlockedAgents(): string[] {
    const result: string[] = [];
    for (const [key, policy] of this.#agents) {
      if (policy.blocked) result.push(key);
    }
    return result;
  }

  /** Return a snapshot of all explicitly allowed (and not blocked) agent public keys. */
  getAllowedAgents(): string[] {
    const result: string[] = [];
    for (const [key, policy] of this.#agents) {
      if (policy.allowed && !policy.blocked) result.push(key);
    }
    return result;
  }
}

/**
 * Spam and duplicate-message filter for P2P message ingestion.
 *
 * Tracks:
 * - Seen message IDs for deduplication (bounded LRU-lite via bulk eviction).
 * - Per-sender message timestamps for sliding-window rate limiting.
 * - Per-sender spam report counts.
 */
export class SpamFilter {
  readonly #maxSeenSize: number;
  #seen: Set<string> = new Set();

  readonly #senderWindows: Map<string, SenderWindow> = new Map();
  readonly #spamCounts: Map<string, number> = new Map();

  /**
   * @param maxSeenSize - Maximum number of message IDs to retain before
   *   evicting. Defaults to 100 000. When the cap is reached the entire set
   *   is cleared (start-fresh eviction), keeping memory bounded while
   *   preserving dedup accuracy for the most recent traffic burst.
   */
  constructor(maxSeenSize: number = 100_000) {
    if (!Number.isInteger(maxSeenSize) || maxSeenSize < 1) {
      throw new RangeError(`maxSeenSize must be a positive integer, got ${maxSeenSize}`);
    }
    this.#maxSeenSize = maxSeenSize;
  }

  /**
   * Check whether a message ID has been seen before.
   *
   * If the ID is new it is recorded. When the seen-set reaches `maxSeenSize`
   * the oldest 25 % of entries (the first quarter inserted) are evicted before
   * the new ID is added.
   *
   * @returns `true` if the message is a duplicate, `false` if it is new.
   */
  isDuplicate(messageIdHex: string): boolean {
    if (this.#seen.has(messageIdHex)) return true;

    if (this.#seen.size >= this.#maxSeenSize) {
      this.#evictOldest();
    }

    this.#seen.add(messageIdHex);
    return false;
  }

  /**
   * Evict the oldest 25 % of entries by reconstructing the set without them.
   * Sets in V8 preserve insertion order, so the first N entries are oldest.
   */
  #evictOldest(): void {
    const evictCount = Math.ceil(this.#maxSeenSize * 0.25);
    const entries = [...this.#seen];
    this.#seen = new Set(entries.slice(evictCount));
  }

  /**
   * Check whether a sender has exceeded the allowed message rate.
   *
   * Uses a sliding one-minute window. Timestamps older than 60 seconds are
   * pruned on each call to keep memory usage proportional to actual traffic.
   *
   * @param pubkeyHex   - Sender identity.
   * @param maxPerMinute - Maximum messages allowed within the last 60 seconds.
   * @returns `true` if the sender is over the limit.
   */
  isRateLimited(pubkeyHex: string, maxPerMinute: number): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    const cutoff = now - windowMs;

    let window = this.#senderWindows.get(pubkeyHex);
    if (window === undefined) {
      window = { timestamps: [] };
      this.#senderWindows.set(pubkeyHex, window);
    }

    // Prune expired timestamps.
    const start = this.#lowerBound(window.timestamps, cutoff);
    window.timestamps = window.timestamps.slice(start);

    // Record the current message arrival.
    window.timestamps.push(now);

    // Periodically evict empty sender windows to prevent unbounded growth.
    // Run eviction every 1000 calls to amortise the cost.
    this.#rateLimitCallCount++;
    if (this.#rateLimitCallCount >= 1000) {
      this.#rateLimitCallCount = 0;
      this.#evictStaleSenderWindows(cutoff);
    }

    return window.timestamps.length > maxPerMinute;
  }

  /** Eviction counter for amortised stale window cleanup. */
  #rateLimitCallCount = 0;

  /**
   * Remove sender window entries that have no timestamps within the active
   * window. This prevents the map from growing without bound when many
   * distinct senders send a single message and then go silent.
   */
  #evictStaleSenderWindows(cutoff: number): void {
    for (const [key, window] of this.#senderWindows) {
      if (window.timestamps.length === 0 ||
          window.timestamps[window.timestamps.length - 1] < cutoff) {
        this.#senderWindows.delete(key);
      }
    }
  }

  /**
   * Binary search for the first timestamp at or after `target`.
   * Used to efficiently prune expired entries from sorted timestamp arrays.
   */
  #lowerBound(timestamps: number[], target: number): number {
    let lo = 0;
    let hi = timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((timestamps[mid] as number) < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Record a spam report against a sender.
   * Counters are cumulative and never reset automatically.
   */
  reportSpam(pubkeyHex: string): void {
    this.#spamCounts.set(
      pubkeyHex,
      (this.#spamCounts.get(pubkeyHex) ?? 0) + 1,
    );
  }

  /**
   * Retrieve the total number of spam reports filed against a sender.
   *
   * @returns Report count, or `0` if the sender has never been reported.
   */
  getSpamCount(pubkeyHex: string): number {
    return this.#spamCounts.get(pubkeyHex) ?? 0;
  }
}
