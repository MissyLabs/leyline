import { createHash } from 'node:crypto';
import { Level } from 'level';
import { Logger } from '../utils/logger.js';

export interface SharedLedgerEntry {
  index: number;
  prevHash: Uint8Array;
  hash: Uint8Array;
  data: Uint8Array;
  submitterPubkey: Uint8Array;
  signature: Uint8Array;
  timestamp: number;
  confirmations: number;
  confirmerPubkeys: Uint8Array[];
  /**
   * Ed25519 signatures over `confirm:{hash}`, parallel to `confirmerPubkeys`.
   * Present when a confirmation was recorded with proof (from the ledger-sync
   * confirm path). Enables downstream verification of confirmation counts so a
   * peer cannot fabricate them (SEC-1). May be shorter than `confirmerPubkeys`
   * for legacy/unproven confirmations.
   */
  confirmerSignatures: Uint8Array[];
}

interface StoredEntry {
  index: number;
  prevHash: string;
  hash: string;
  data: string;
  submitterPubkey: string;
  signature: string;
  timestamp: number;
  confirmations: number;
  confirmerPubkeys: string[];
  confirmerSignatures?: string[];
}

function toHex(arr: Uint8Array): string {
  return Buffer.from(arr).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Zero-pad a non-negative integer so keys sort lexicographically by value. */
function padIndex(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(16, '0');
}

/** Time-bucket (hourly) for the timestamp secondary index. */
function timeBucket(timestampMs: number): string {
  return padIndex(Math.floor(timestampMs / 3_600_000));
}

/**
 * Recompute the canonical hash for an entry from its preimage fields.
 * Exported so consumers (e.g. the fork resolver) can verify a serialized
 * entry's `hash` rather than trusting the value sent by a peer.
 */
export function computeEntryHash(entry: {
  index: number;
  prevHash: Uint8Array;
  data: Uint8Array;
  submitterPubkey: Uint8Array;
  timestamp: number;
}): Uint8Array {
  return computeHash(entry.index, entry.prevHash, entry.data, entry.submitterPubkey, entry.timestamp);
}

function computeHash(
  index: number,
  prevHash: Uint8Array,
  data: Uint8Array,
  submitterPubkey: Uint8Array,
  timestamp: number,
): Uint8Array {
  const hasher = createHash('sha256');
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigUInt64BE(BigInt(index));
  hasher.update(indexBuf);
  hasher.update(prevHash);
  hasher.update(data);
  hasher.update(submitterPubkey);
  const tsBuf = Buffer.alloc(8);
  tsBuf.writeBigUInt64BE(BigInt(timestamp));
  hasher.update(tsBuf);
  return new Uint8Array(hasher.digest());
}

function serializeEntry(entry: SharedLedgerEntry): string {
  const stored: StoredEntry = {
    index: entry.index,
    prevHash: toHex(entry.prevHash),
    hash: toHex(entry.hash),
    data: toHex(entry.data),
    submitterPubkey: toHex(entry.submitterPubkey),
    signature: toHex(entry.signature),
    timestamp: entry.timestamp,
    confirmations: entry.confirmations,
    confirmerPubkeys: entry.confirmerPubkeys.map(toHex),
    confirmerSignatures: entry.confirmerSignatures.map(toHex),
  };
  return JSON.stringify(stored);
}

function deserializeEntry(json: string): SharedLedgerEntry {
  const stored: StoredEntry = JSON.parse(json);
  return {
    index: stored.index,
    prevHash: fromHex(stored.prevHash),
    hash: fromHex(stored.hash),
    data: fromHex(stored.data),
    submitterPubkey: fromHex(stored.submitterPubkey),
    signature: fromHex(stored.signature),
    timestamp: stored.timestamp,
    confirmations: stored.confirmations,
    confirmerPubkeys: stored.confirmerPubkeys.map(fromHex),
    confirmerSignatures: (stored.confirmerSignatures ?? []).map(fromHex),
  };
}

/**
 * Filter criteria for {@link SharedLedger.query}.
 *
 * All specified fields are combined with AND semantics.
 */
export interface LedgerQueryFilter {
  /** Filter by submitter public key hex */
  submitterPubkeyHex?: string;
  /** Filter by timestamp range [minMs, maxMs] (both inclusive) */
  timestampRange?: [number, number];
  /** Minimum confirmation count (inclusive) */
  minConfirmations?: number;
  /** Maximum number of results to return (default: unlimited) */
  limit?: number;
  /** Cursor: only return entries with index strictly greater than this. */
  after?: number;
}

/** A page of query results with an opaque forward cursor. */
export interface LedgerQueryPage {
  entries: SharedLedgerEntry[];
  /** Pass as `after` to fetch the next page; null when exhausted. */
  nextCursor: number | null;
}

/** One step of a hash-chain inclusion proof. */
export interface LedgerProofStep {
  index: number;
  prevHash: string;
  data: string;
  submitterPubkey: string;
  timestamp: number;
  hash: string;
}

/**
 * Inclusion proof that a given entry is part of the chain ending at
 * `latestHash`. Contains the target entry plus every subsequent entry's
 * hash-preimage fields, so an external verifier can recompute the hash chain
 * from the target forward to the head without trusting any stored hash.
 */
export interface LedgerProof {
  index: number;
  latestIndex: number;
  latestHash: string;
  steps: LedgerProofStep[];
}

/**
 * Shared distributed ledger for provable records.
 * Entries are submitted with a signature and can be confirmed by peers.
 * Uses a hash chain for integrity, stored in LevelDB.
 */
export class SharedLedger {
  private db: Level<string, string>;
  private currentIndex = 0;
  private latestHash: Uint8Array = new Uint8Array(0);
  /** Serialization lock for submit() and addConfirmation() to prevent concurrent corruption. */
  private submitLock: Promise<void> = Promise.resolve();
  private readonly log = new Logger('SharedLedger');

  constructor(dataDir: string) {
    this.db = new Level(dataDir, { valueEncoding: 'utf8' });
  }

  async open(): Promise<void> {
    await this.db.open();
    // Find the latest entry
    try {
      const metaRaw = await this.db.get('meta:latest');
      const meta = JSON.parse(metaRaw);
      this.currentIndex = meta.index;
      this.latestHash = fromHex(meta.hash);
    } catch (err: unknown) {
      // Distinguish between "no entries yet" (NotFound/parse error on empty) and actual corruption
      const isExpectedEmpty = err instanceof Error && (
        err.message.includes('LEVEL_NOT_FOUND') ||
        err.message.includes('NotFound') ||
        err.message.includes('is not valid JSON') ||
        (err as { code?: string }).code === 'LEVEL_NOT_FOUND'
      );
      if (!isExpectedEmpty) {
        this.log.warn('Failed to load metadata — resetting to empty state. This may indicate data corruption', { error: String(err) });
      }
      this.currentIndex = 0;
      this.latestHash = new Uint8Array(0);
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Submit a new provable entry to the shared ledger.
   * Serialized to prevent concurrent writes from corrupting the hash chain.
   */
  async submit(
    data: Uint8Array,
    submitterPubkey: Uint8Array,
    signature: Uint8Array,
  ): Promise<SharedLedgerEntry> {
    // Chain onto the lock so concurrent calls execute sequentially
    const prev = this.submitLock;
    let resolve!: () => void;
    this.submitLock = new Promise<void>((r) => { resolve = r; });

    try {
      await prev;
      return await this.submitInner(data, submitterPubkey, signature);
    } finally {
      resolve();
    }
  }

  private async submitInner(
    data: Uint8Array,
    submitterPubkey: Uint8Array,
    signature: Uint8Array,
  ): Promise<SharedLedgerEntry> {
    const index = this.currentIndex + 1;
    const timestamp = Date.now();
    const prevHash = this.latestHash;
    const hash = computeHash(index, prevHash, data, submitterPubkey, timestamp);

    const entry: SharedLedgerEntry = {
      index,
      prevHash,
      hash,
      data,
      submitterPubkey,
      signature,
      timestamp,
      confirmations: 0,
      confirmerPubkeys: [],
      confirmerSignatures: [],
    };

    // Write the entry, its secondary indices, and the metadata pointer
    // atomically so the indices can never drift from the primary store.
    await this.db.batch([
      { type: 'put', key: `entry:${index}`, value: serializeEntry(entry) },
      { type: 'put', key: `idx:sub:${toHex(submitterPubkey)}:${padIndex(index)}`, value: '' },
      { type: 'put', key: `idx:ts:${timeBucket(timestamp)}:${padIndex(index)}`, value: '' },
      { type: 'put', key: 'meta:latest', value: JSON.stringify({ index, hash: toHex(hash) }) },
    ]);
    this.currentIndex = index;
    this.latestHash = hash;

    return entry;
  }

  /**
   * Add a peer confirmation to an existing entry.
   * Serialized via the same lock as submit() to prevent concurrent
   * read-modify-write races that could produce duplicate confirmers.
   *
   * @param signature - Optional Ed25519 signature over `confirm:{entryHash}` by
   *                    the confirmer, stored so the confirmation can later be
   *                    cryptographically verified (SEC-1).
   */
  async addConfirmation(index: number, confirmerPubkey: Uint8Array, signature?: Uint8Array): Promise<SharedLedgerEntry | null> {
    const prev = this.submitLock;
    let resolve!: () => void;
    this.submitLock = new Promise<void>((r) => { resolve = r; });

    try {
      await prev;
      return await this.addConfirmationInner(index, confirmerPubkey, signature);
    } finally {
      resolve();
    }
  }

  private async addConfirmationInner(index: number, confirmerPubkey: Uint8Array, signature?: Uint8Array): Promise<SharedLedgerEntry | null> {
    const entry = await this.getEntry(index);
    if (!entry) return null;

    const confirmerHex = toHex(confirmerPubkey);
    const alreadyConfirmed = entry.confirmerPubkeys.some((pk) => toHex(pk) === confirmerHex);
    if (alreadyConfirmed) return entry;

    entry.confirmerPubkeys.push(confirmerPubkey);
    entry.confirmerSignatures.push(signature ?? new Uint8Array(0));
    entry.confirmations = entry.confirmerPubkeys.length;

    await this.db.put(`entry:${index}`, serializeEntry(entry));
    return entry;
  }

  async getEntry(index: number): Promise<SharedLedgerEntry | null> {
    try {
      const raw = await this.db.get(`entry:${index}`);
      return deserializeEntry(raw);
    } catch {
      return null;
    }
  }

  async getLatest(): Promise<SharedLedgerEntry | null> {
    if (this.currentIndex === 0) return null;
    return this.getEntry(this.currentIndex);
  }

  async getEntryCount(): Promise<number> {
    return this.currentIndex;
  }

  /**
   * Verify the entire chain integrity.
   */
  async verify(): Promise<boolean> {
    let expectedPrevHash = new Uint8Array(0);

    for (let i = 1; i <= this.currentIndex; i++) {
      const entry = await this.getEntry(i);
      if (!entry) return false;

      if (toHex(entry.prevHash) !== toHex(expectedPrevHash)) return false;

      const expectedHash = computeHash(
        entry.index,
        entry.prevHash,
        entry.data,
        entry.submitterPubkey,
        entry.timestamp,
      );
      if (toHex(entry.hash) !== toHex(expectedHash)) return false;

      expectedPrevHash = new Uint8Array(entry.hash);
    }

    return true;
  }

  /**
   * Get entries in a range for syncing with peers.
   */
  async getRange(startIndex: number, endIndex: number): Promise<SharedLedgerEntry[]> {
    const entries: SharedLedgerEntry[] = [];
    const end = Math.min(endIndex, this.currentIndex);
    for (let i = startIndex; i <= end; i++) {
      const entry = await this.getEntry(i);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * Query ledger entries with optional filter criteria.
   *
   * When `submitterPubkeyHex` is provided the submitter secondary index is used
   * to avoid a full scan (IMP-1); otherwise entries are walked in ascending
   * index order. Results are capped by `filter.limit`.
   *
   * @param filter - One or more filter criteria; omitted fields are ignored.
   * @returns Matching {@link SharedLedgerEntry} objects in ascending index order.
   */
  async query(filter: LedgerQueryFilter): Promise<SharedLedgerEntry[]> {
    return (await this.queryPage(filter)).entries;
  }

  /**
   * Cursor-paginated variant of {@link query}. Returns a page of matching
   * entries and a `nextCursor` (the index to pass as `after` for the next
   * page), or null when the ledger is exhausted.
   */
  async queryPage(filter: LedgerQueryFilter): Promise<LedgerQueryPage> {
    const results: SharedLedgerEntry[] = [];
    const limit = filter.limit ?? Infinity;
    const after = filter.after ?? 0;
    let lastIndexSeen = after;
    let exhausted = true;

    const matches = (entry: SharedLedgerEntry): boolean => {
      if (filter.timestampRange !== undefined) {
        const [minMs, maxMs] = filter.timestampRange;
        if (entry.timestamp < minMs || entry.timestamp > maxMs) return false;
      }
      if (filter.minConfirmations !== undefined && entry.confirmations < filter.minConfirmations) {
        return false;
      }
      return true;
    };

    if (filter.submitterPubkeyHex !== undefined) {
      // Index-accelerated path: iterate only this submitter's entry indices.
      const prefix = `idx:sub:${filter.submitterPubkeyHex}:`;
      for await (const key of this.db.keys({ gt: `${prefix}${padIndex(after)}`, lt: `${prefix}~` })) {
        const idx = Number(key.slice(prefix.length));
        if (!Number.isFinite(idx)) continue;
        if (results.length >= limit) { exhausted = false; break; }
        const entry = await this.getEntry(idx);
        if (!entry) continue;
        lastIndexSeen = idx;
        if (matches(entry)) results.push(entry);
      }
    } else {
      for (let i = after + 1; i <= this.currentIndex; i++) {
        if (results.length >= limit) { exhausted = false; break; }
        const entry = await this.getEntry(i);
        lastIndexSeen = i;
        if (!entry) continue;
        if (matches(entry)) results.push(entry);
      }
    }

    return {
      entries: results,
      nextCursor: exhausted ? null : lastIndexSeen,
    };
  }

  /**
   * Build a hash-chain inclusion proof for the entry at `index`.
   *
   * The proof contains the target entry plus every subsequent entry's
   * hash-preimage fields up to the current head. A verifier can recompute the
   * chain forward (see {@link SharedLedger.verifyProof}) and confirm the entry
   * is included in the chain ending at the current `latestHash` — without
   * trusting any stored hash value. Tampering with the target entry's `data`
   * breaks the recomputed chain and invalidates the proof.
   *
   * @returns The proof, or null if the index is out of range.
   */
  async getProof(index: number): Promise<LedgerProof | null> {
    if (index < 1 || index > this.currentIndex) return null;
    const steps: LedgerProofStep[] = [];
    for (let i = index; i <= this.currentIndex; i++) {
      const entry = await this.getEntry(i);
      if (!entry) return null;
      steps.push({
        index: entry.index,
        prevHash: toHex(entry.prevHash),
        data: toHex(entry.data),
        submitterPubkey: toHex(entry.submitterPubkey),
        timestamp: entry.timestamp,
        hash: toHex(entry.hash),
      });
    }
    return {
      index,
      latestIndex: this.currentIndex,
      latestHash: toHex(this.latestHash),
      steps,
    };
  }

  /**
   * Verify a {@link LedgerProof} produced by {@link getProof}. Recomputes each
   * step's hash from its preimage fields, checks hash-chain linkage, and
   * confirms the final hash matches `latestHash`. Returns false for any
   * tampering or structural inconsistency.
   */
  static verifyProof(proof: LedgerProof): boolean {
    if (!proof || !Array.isArray(proof.steps) || proof.steps.length === 0) return false;
    if (proof.steps[0].index !== proof.index) return false;
    if (proof.steps[proof.steps.length - 1].index !== proof.latestIndex) return false;

    let expectedPrevHash: string | null = null;
    for (let i = 0; i < proof.steps.length; i++) {
      const step = proof.steps[i];
      if (step.index !== proof.index + i) return false;
      if (expectedPrevHash !== null && step.prevHash !== expectedPrevHash) return false;

      const recomputed = toHex(computeHash(
        step.index,
        fromHex(step.prevHash),
        fromHex(step.data),
        fromHex(step.submitterPubkey),
        step.timestamp,
      ));
      if (recomputed !== step.hash) return false;
      expectedPrevHash = step.hash;
    }

    return proof.steps[proof.steps.length - 1].hash === proof.latestHash;
  }

  /**
   * Roll back the ledger to a given index, deleting all entries after it.
   * Used during fork resolution to replace a divergent suffix.
   * Serialized via the submit lock to prevent concurrent corruption.
   */
  async rollbackTo(targetIndex: number): Promise<void> {
    const prev = this.submitLock;
    let resolve!: () => void;
    this.submitLock = new Promise<void>((r) => { resolve = r; });

    try {
      await prev;
      await this.rollbackToInner(targetIndex);
    } finally {
      resolve();
    }
  }

  private async rollbackToInner(targetIndex: number): Promise<void> {
    if (targetIndex < 0) targetIndex = 0;
    if (targetIndex >= this.currentIndex) return;

    for (let i = this.currentIndex; i > targetIndex; i--) {
      try {
        // Read the entry first so we can drop its secondary index keys too,
        // keeping the indices consistent with the primary store.
        const entry = await this.getEntry(i);
        const ops: Array<{ type: 'del'; key: string }> = [{ type: 'del', key: `entry:${i}` }];
        if (entry) {
          ops.push({ type: 'del', key: `idx:sub:${toHex(entry.submitterPubkey)}:${padIndex(i)}` });
          ops.push({ type: 'del', key: `idx:ts:${timeBucket(entry.timestamp)}:${padIndex(i)}` });
        }
        await this.db.batch(ops);
      } catch {
        // Entry may already be missing
      }
    }

    if (targetIndex === 0) {
      this.currentIndex = 0;
      this.latestHash = new Uint8Array(0);
    } else {
      const entry = await this.getEntry(targetIndex);
      if (entry) {
        this.currentIndex = targetIndex;
        this.latestHash = entry.hash;
      } else {
        this.currentIndex = 0;
        this.latestHash = new Uint8Array(0);
      }
    }

    await this.db.put('meta:latest', JSON.stringify({
      index: this.currentIndex,
      hash: toHex(this.latestHash),
    }));
  }
}
