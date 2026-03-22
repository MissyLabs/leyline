/**
 * LevelDB-backed persistence wrappers for {@link TrustPolicy} and {@link SpamFilter}.
 *
 * Both classes follow the same lifecycle contract:
 * 1. Construct with a `dataDir` path.
 * 2. Call `open()` to initialise the database and hydrate in-memory state.
 * 3. Use the instance normally — mutating methods automatically persist.
 * 4. Call `close()` when done to flush and release the database handle.
 *
 * Persistence is intentionally minimal:
 * - Trust state is durable (agent allow/block flags and tag rules survive restarts).
 * - Spam counts are durable (cumulative report totals survive restarts).
 * - Deduplication seen-sets and rate-limit sliding windows are ephemeral
 *   (bounded in-process structures that do not warrant persistence).
 */

import { Level } from 'level';
import { TrustPolicy, SpamFilter } from './policy.js';

// ---------------------------------------------------------------------------
// Internal serialisation types
// ---------------------------------------------------------------------------

/** JSON shape stored under each `trust:{pubkeyHex}` key. */
interface AgentPolicyRecord {
  allowed: boolean;
  blocked: boolean;
  allowedTags: string[];
  blockedTags: string[];
}

// ---------------------------------------------------------------------------
// PersistentTrustPolicy
// ---------------------------------------------------------------------------

/**
 * A {@link TrustPolicy} wrapper that persists every mutation to LevelDB.
 *
 * Storage layout:
 * ```
 * trust:{pubkeyHex}  →  JSON<AgentPolicyRecord>
 * ```
 *
 * On {@link open} the database is iterated with a `trust:` prefix and every
 * stored record is replayed into a fresh {@link TrustPolicy} instance, fully
 * restoring its pre-shutdown state.
 */
export class PersistentTrustPolicy {
  readonly #dataDir: string;
  #db: Level<string, string> | undefined;
  #policy: TrustPolicy = new TrustPolicy();

  /**
   * @param dataDir - Directory path passed directly to LevelDB.  The directory
   *   is created on first open if it does not already exist.
   */
  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open the LevelDB store and hydrate the in-memory {@link TrustPolicy} from
   * all previously persisted `trust:*` entries.
   *
   * Safe to call only once per instance. Calling it a second time without an
   * intervening {@link close} will throw the underlying LevelDB error.
   */
  async open(): Promise<void> {
    this.#db = new Level<string, string>(this.#dataDir, { valueEncoding: 'utf8' });
    await this.#db.open();

    this.#policy = new TrustPolicy();

    for await (const [key, raw] of this.#db.iterator({ gt: 'trust:', lt: 'trust:~' })) {
      const pubkeyHex = key.slice('trust:'.length);
      const record: AgentPolicyRecord = JSON.parse(raw) as AgentPolicyRecord;
      this.#rehydrateAgent(pubkeyHex, record);
    }

    // Rehydrate open tags
    try {
      const openRaw = await this.#db.get('meta:openTags');
      const openTags: string[] = JSON.parse(openRaw);
      for (const tag of openTags) {
        this.#policy.allowTagOpen(tag);
      }
    } catch {
      // No open tags stored yet — that's fine
    }
  }

  /**
   * Flush pending writes and close the underlying LevelDB handle.
   *
   * After calling `close()` the instance must not be used again without a
   * subsequent `open()` call.
   */
  async close(): Promise<void> {
    await this.#assertDb().close();
    this.#db = undefined;
  }

  // -------------------------------------------------------------------------
  // Mutating methods — delegate then persist
  // -------------------------------------------------------------------------

  /**
   * Whitelist an agent and persist the updated policy entry.
   *
   * @param pubkeyHex - Hex-encoded public key of the agent to allow.
   */
  async allowAgent(pubkeyHex: string): Promise<void> {
    this.#policy.allowAgent(pubkeyHex);
    // Ensure the shadow entry exists so the record can be reconstructed even
    // when no tag operations have been performed for this agent yet.
    this.#shadowEntry(pubkeyHex);
    await this.#persistAgent(pubkeyHex);
  }

  /**
   * Blacklist an agent and persist the updated policy entry.
   *
   * @param pubkeyHex - Hex-encoded public key of the agent to block.
   */
  async blockAgent(pubkeyHex: string): Promise<void> {
    this.#policy.blockAgent(pubkeyHex);
    this.#shadowEntry(pubkeyHex);
    await this.#persistAgent(pubkeyHex);
  }

  /**
   * Allow a specific tag for an agent and persist the updated policy entry.
   *
   * @param pubkeyHex - Hex-encoded public key of the target agent.
   * @param tag       - Tag string to whitelist for this agent.
   */
  async allowTag(pubkeyHex: string, tag: string): Promise<void> {
    this.#policy.allowTag(pubkeyHex, tag);
    const shadow = this.#shadowEntry(pubkeyHex);
    shadow.blockedTags.delete(tag);
    shadow.allowedTags.add(tag);
    await this.#persistAgent(pubkeyHex);
  }

  /**
   * Block a specific tag for an agent and persist the updated policy entry.
   *
   * @param pubkeyHex - Hex-encoded public key of the target agent.
   * @param tag       - Tag string to blacklist for this agent.
   */
  async blockTag(pubkeyHex: string, tag: string): Promise<void> {
    this.#policy.blockTag(pubkeyHex, tag);
    const shadow = this.#shadowEntry(pubkeyHex);
    shadow.allowedTags.delete(tag);
    shadow.blockedTags.add(tag);
    await this.#persistAgent(pubkeyHex);
  }

  // -------------------------------------------------------------------------
  // Open tag methods — delegate then persist
  // -------------------------------------------------------------------------

  /**
   * Open a tag to all senders. Any agent can send messages on this tag
   * without being individually whitelisted. Blocked agents are still denied.
   *
   * @param tag - Tag string to open.
   */
  async allowTagOpen(tag: string): Promise<void> {
    this.#policy.allowTagOpen(tag);
    await this.#persistOpenTags();
  }

  /**
   * Close a previously opened tag. Reverts to deny-first for this tag.
   *
   * @param tag - Tag string to close.
   */
  async closeTag(tag: string): Promise<void> {
    this.#policy.closeTag(tag);
    await this.#persistOpenTags();
  }

  /** Returns true if the given tag is open to all senders. */
  isTagOpen(tag: string): boolean {
    return this.#policy.isTagOpen(tag);
  }

  /** Return a snapshot of all open tags. */
  getOpenTags(): string[] {
    return this.#policy.getOpenTags();
  }

  // -------------------------------------------------------------------------
  // Read-only delegation — no persistence required
  // -------------------------------------------------------------------------

  /**
   * Determine whether a message from `pubkeyHex` bearing `tags` is allowed.
   * Delegates directly to the inner {@link TrustPolicy}; no I/O is performed.
   *
   * @param pubkeyHex - Sender identity.
   * @param tags      - Message tags to evaluate.
   * @returns `true` only when all agent-level and tag-level checks pass.
   */
  isAllowed(pubkeyHex: string, tags: string[]): boolean {
    return this.#policy.isAllowed(pubkeyHex, tags);
  }

  /**
   * Return a snapshot of all explicitly blocked agent public keys.
   * Delegates directly to the inner {@link TrustPolicy}; no I/O is performed.
   */
  getBlockedAgents(): string[] {
    return this.#policy.getBlockedAgents();
  }

  /**
   * Return a snapshot of all explicitly allowed (and not blocked) agent public keys.
   * Delegates directly to the inner {@link TrustPolicy}; no I/O is performed.
   */
  getAllowedAgents(): string[] {
    return this.#policy.getAllowedAgents();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Assert the database is open and return it. */
  #assertDb(): Level<string, string> {
    if (this.#db === undefined) {
      throw new Error('PersistentTrustPolicy: database is not open — call open() first');
    }
    return this.#db;
  }

  /**
   * Read back the current in-memory policy for `pubkeyHex` and write it to
   * LevelDB as a JSON-serialised {@link AgentPolicyRecord}.
   *
   * This is called after every mutating operation so the stored state always
   * reflects the live in-memory state.
   */
  async #persistAgent(pubkeyHex: string): Promise<void> {
    // Reconstruct the serialisable record by inspecting the live policy.
    // We derive the current flags by asking the policy for its agent lists
    // and rebuild the tag arrays from a temporary allow/block probe approach.
    // Because TrustPolicy uses private fields we re-query via the public API
    // and rely on a snapshot extraction helper.
    const record = this.#extractRecord(pubkeyHex);
    const key = `trust:${pubkeyHex}`;
    await this.#assertDb().put(key, JSON.stringify(record));
  }

  /**
   * Extract a serialisable {@link AgentPolicyRecord} for `pubkeyHex` from the
   * live {@link TrustPolicy}.
   *
   * `TrustPolicy` exposes only `getAllowedAgents` / `getBlockedAgents` as
   * aggregate snapshots and does not expose per-agent tag sets directly.  To
   * reconstruct a faithful record we maintain a parallel lightweight registry
   * of tag mutations alongside the delegated calls.
   *
   * Because this class is the sole writer to its wrapped `TrustPolicy` we can
   * keep the tag state in a local shadow map and the agent-level flags from the
   * policy's public snapshot methods.
   */
  #extractRecord(pubkeyHex: string): AgentPolicyRecord {
    const shadow = this.#shadow.get(pubkeyHex) ?? {
      allowedTags: new Set<string>(),
      blockedTags: new Set<string>(),
    };

    const blocked = this.#policy.getBlockedAgents().includes(pubkeyHex);
    const allowed = this.#policy.getAllowedAgents().includes(pubkeyHex);

    return {
      allowed,
      blocked,
      allowedTags: [...shadow.allowedTags],
      blockedTags: [...shadow.blockedTags],
    };
  }

  /**
   * Shadow map tracking the tag sets for each agent.
   *
   * `TrustPolicy`'s tag state is held in private `#agents` fields that are not
   * accessible from outside the class.  Rather than re-implementing the same
   * logic, `PersistentTrustPolicy` maintains a parallel lightweight shadow map
   * that mirrors every tag mutation it performs on the inner policy.  This map
   * is the authoritative source for persisted tag data.
   */
  readonly #shadow: Map<string, { allowedTags: Set<string>; blockedTags: Set<string> }> =
    new Map();

  /**
   * Get or initialise the shadow entry for `pubkeyHex`.
   */
  #shadowEntry(pubkeyHex: string): { allowedTags: Set<string>; blockedTags: Set<string> } {
    let entry = this.#shadow.get(pubkeyHex);
    if (entry === undefined) {
      entry = { allowedTags: new Set(), blockedTags: new Set() };
      this.#shadow.set(pubkeyHex, entry);
    }
    return entry;
  }

  /**
   * Replay a persisted {@link AgentPolicyRecord} into the in-memory policy and
   * shadow map on startup.
   */
  #rehydrateAgent(pubkeyHex: string, record: AgentPolicyRecord): void {
    if (record.allowed) {
      this.#policy.allowAgent(pubkeyHex);
    }
    if (record.blocked) {
      this.#policy.blockAgent(pubkeyHex);
    }

    const shadow = this.#shadowEntry(pubkeyHex);

    for (const tag of record.allowedTags) {
      this.#policy.allowTag(pubkeyHex, tag);
      shadow.blockedTags.delete(tag);
      shadow.allowedTags.add(tag);
    }

    for (const tag of record.blockedTags) {
      this.#policy.blockTag(pubkeyHex, tag);
      shadow.allowedTags.delete(tag);
      shadow.blockedTags.add(tag);
    }
  }

  /**
   * Persist the current set of open tags to LevelDB.
   */
  async #persistOpenTags(): Promise<void> {
    const tags = this.#policy.getOpenTags();
    await this.#assertDb().put('meta:openTags', JSON.stringify(tags));
  }
}

// ---------------------------------------------------------------------------
// PersistentSpamFilter
// ---------------------------------------------------------------------------

/**
 * A {@link SpamFilter} wrapper that persists spam report counts to LevelDB.
 *
 * Storage layout:
 * ```
 * spam:{pubkeyHex}  →  "<count>"   (decimal integer string)
 * ```
 *
 * Deduplication seen-sets and rate-limit sliding windows are intentionally
 * ephemeral — they are bounded, high-churn structures whose correctness does
 * not depend on surviving a process restart.  Only cumulative spam report
 * counts are durable.
 *
 * On {@link open} all `spam:*` keys are iterated and their counts are loaded
 * into the wrapped {@link SpamFilter}, restoring the pre-shutdown totals.
 */
export class PersistentSpamFilter {
  readonly #dataDir: string;
  #db: Level<string, string> | undefined;
  #filter: SpamFilter;

  /**
   * @param dataDir     - Directory path passed directly to LevelDB.
   * @param maxSeenSize - Optional cap on the in-memory dedup seen-set,
   *   forwarded unchanged to {@link SpamFilter}.  Defaults to 100 000.
   */
  constructor(dataDir: string, maxSeenSize?: number) {
    this.#dataDir = dataDir;
    this.#filter = maxSeenSize !== undefined ? new SpamFilter(maxSeenSize) : new SpamFilter();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open the LevelDB store and hydrate the in-memory spam count map from all
   * previously persisted `spam:*` entries.
   *
   * Safe to call only once per instance. Calling it a second time without an
   * intervening {@link close} will throw the underlying LevelDB error.
   */
  async open(): Promise<void> {
    this.#db = new Level<string, string>(this.#dataDir, { valueEncoding: 'utf8' });
    await this.#db.open();

    // Rebuild the SpamFilter with a fresh instance so the seen-set and windows
    // are clean, then replay persisted spam counts via reportSpam.
    const savedCounts = new Map<string, number>();

    for await (const [key, raw] of this.#db.iterator({ gt: 'spam:', lt: 'spam:~' })) {
      const pubkeyHex = key.slice('spam:'.length);
      const count = parseInt(raw, 10);
      if (!isNaN(count) && count > 0) {
        savedCounts.set(pubkeyHex, count);
      }
    }

    // Replay: call reportSpam count-times for each sender to restore totals.
    for (const [pubkeyHex, count] of savedCounts) {
      for (let i = 0; i < count; i++) {
        this.#filter.reportSpam(pubkeyHex);
      }
    }
  }

  /**
   * Flush pending writes and close the underlying LevelDB handle.
   *
   * After calling `close()` the instance must not be used again without a
   * subsequent `open()` call.
   */
  async close(): Promise<void> {
    await this.#assertDb().close();
    this.#db = undefined;
  }

  // -------------------------------------------------------------------------
  // Ephemeral delegation — no persistence required
  // -------------------------------------------------------------------------

  /**
   * Check whether a message ID has been seen before.
   * Delegates directly to the inner {@link SpamFilter}; no I/O is performed.
   *
   * @param messageIdHex - Hex-encoded message identifier.
   * @returns `true` if the message is a duplicate.
   */
  isDuplicate(messageIdHex: string): boolean {
    return this.#filter.isDuplicate(messageIdHex);
  }

  /**
   * Check whether a sender has exceeded the allowed message rate.
   * Delegates directly to the inner {@link SpamFilter}; no I/O is performed.
   *
   * @param pubkeyHex    - Sender identity.
   * @param maxPerMinute - Maximum messages allowed within the last 60 seconds.
   * @returns `true` if the sender is over the limit.
   */
  isRateLimited(pubkeyHex: string, maxPerMinute: number): boolean {
    return this.#filter.isRateLimited(pubkeyHex, maxPerMinute);
  }

  // -------------------------------------------------------------------------
  // Durable mutation — delegate then persist
  // -------------------------------------------------------------------------

  /**
   * Record a spam report against a sender and persist the updated count.
   *
   * @param pubkeyHex - Hex-encoded public key of the reported sender.
   */
  async reportSpam(pubkeyHex: string): Promise<void> {
    this.#filter.reportSpam(pubkeyHex);
    const count = this.#filter.getSpamCount(pubkeyHex);
    const key = `spam:${pubkeyHex}`;
    await this.#assertDb().put(key, String(count));
  }

  // -------------------------------------------------------------------------
  // Read-only delegation — no persistence required
  // -------------------------------------------------------------------------

  /**
   * Retrieve the total number of spam reports filed against a sender.
   * Delegates directly to the inner {@link SpamFilter}; no I/O is performed.
   *
   * @param pubkeyHex - Sender identity.
   * @returns Report count, or `0` if the sender has never been reported.
   */
  getSpamCount(pubkeyHex: string): number {
    return this.#filter.getSpamCount(pubkeyHex);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Assert the database is open and return it. */
  #assertDb(): Level<string, string> {
    if (this.#db === undefined) {
      throw new Error('PersistentSpamFilter: database is not open — call open() first');
    }
    return this.#db;
  }
}
