import { createHash } from "node:crypto";
import { Level } from "level";
import { Logger } from "../utils/logger.js";

export interface LedgerEntry {
  index: number;
  prevHash: Uint8Array;
  hash: Uint8Array;
  message: Uint8Array;
  action: string;
  recordedAt: number;
}

interface StoredEntry {
  index: number;
  prevHash: string;
  hash: string;
  message: string;
  action: string;
  recordedAt: number;
}

function entryToStored(entry: LedgerEntry): StoredEntry {
  return {
    index: entry.index,
    prevHash: Buffer.from(entry.prevHash).toString("hex"),
    hash: Buffer.from(entry.hash).toString("hex"),
    message: Buffer.from(entry.message).toString("hex"),
    action: entry.action,
    recordedAt: entry.recordedAt,
  };
}

function storedToEntry(stored: StoredEntry): LedgerEntry {
  return {
    index: stored.index,
    prevHash: Buffer.from(stored.prevHash, "hex"),
    hash: Buffer.from(stored.hash, "hex"),
    message: Buffer.from(stored.message, "hex"),
    action: stored.action,
    recordedAt: stored.recordedAt,
  };
}

function computeHash(
  index: number,
  prevHash: Uint8Array,
  message: Uint8Array,
  timestamp: number,
  action: string,
): Uint8Array {
  const hash = createHash("sha256");

  const indexBuf = Buffer.allocUnsafe(8);
  indexBuf.writeBigUInt64BE(BigInt(index));
  hash.update(indexBuf);

  hash.update(prevHash);
  hash.update(message);

  const tsBuf = Buffer.allocUnsafe(8);
  tsBuf.writeBigUInt64BE(BigInt(timestamp));
  hash.update(tsBuf);

  hash.update(action, "utf8");

  return hash.digest();
}

function indexKey(index: number): string {
  return index.toString().padStart(20, "0");
}

/**
 * An append-only Merkle hash chain ledger backed by LevelDB.
 *
 * Each entry records a message and action alongside a SHA-256 hash that
 * commits to the full chain history up to that point, enabling tamper
 * detection via {@link verify}.
 */
export class LocalLedger {
  private db: Level<string, string>;
  private latestEntry: LedgerEntry | null = null;
  private entryCount: number = 0;
  private appendLock: Promise<void> = Promise.resolve();
  private readonly log = new Logger('LocalLedger');

  /**
   * @param dataDir - Filesystem path used by LevelDB for persistent storage.
   */
  constructor(dataDir: string) {
    this.db = new Level<string, string>(dataDir, { valueEncoding: "utf8" });
  }

  /**
   * Opens the underlying database and loads the current chain tip so that
   * subsequent {@link append} calls are immediately consistent.
   */
  async open(): Promise<void> {
    await this.db.open();

    // Determine how many entries exist by scanning keys in reverse order.
    // We store a dedicated count key so this is O(1) after the first open.
    try {
      const rawCount = await this.db.get("__count__");
      const parsed = parseInt(rawCount, 10);
      this.entryCount = Number.isNaN(parsed) ? 0 : parsed;
    } catch (err: unknown) {
      const isNotFound = err instanceof Error && (
        err.message.includes('LEVEL_NOT_FOUND') ||
        err.message.includes('NotFound') ||
        (err as { code?: string }).code === 'LEVEL_NOT_FOUND'
      );
      if (!isNotFound) {
        this.log.warn('Failed to load entry count — resetting to empty state. This may indicate data corruption', { error: String(err) });
      }
      this.entryCount = 0;
    }

    if (this.entryCount > 0) {
      const latestIndex = this.entryCount - 1;
      try {
        const raw = await this.db.get(indexKey(latestIndex));
        const stored: StoredEntry = JSON.parse(raw) as StoredEntry;
        this.latestEntry = storedToEntry(stored);
      } catch (err) {
        this.log.warn('Failed to load latest entry — starting from empty. This may indicate data corruption', { error: String(err) });
        this.entryCount = 0;
        this.latestEntry = null;
      }
    }
  }

  /**
   * Closes the underlying database. No further operations should be performed
   * after this call.
   */
  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Appends a new entry to the chain.
   *
   * @param message - Arbitrary binary payload to record.
   * @param action  - Human-readable action label describing the event.
   * @returns The newly created {@link LedgerEntry}.
   */
  async append(message: Uint8Array, action: string): Promise<LedgerEntry> {
    const prev = this.appendLock;
    let resolve!: () => void;
    this.appendLock = new Promise<void>((r) => { resolve = r; });

    try {
      await prev;
      return await this.appendInner(message, action);
    } finally {
      resolve();
    }
  }

  private async appendInner(message: Uint8Array, action: string): Promise<LedgerEntry> {
    const index = this.entryCount;
    const prevHash =
      this.latestEntry !== null ? this.latestEntry.hash : new Uint8Array(0);
    const recordedAt = Date.now();

    const hash = computeHash(index, prevHash, message, recordedAt, action);

    const entry: LedgerEntry = {
      index,
      prevHash,
      hash,
      message,
      action,
      recordedAt,
    };

    const stored = entryToStored(entry);

    await this.db.batch([
      { type: "put", key: indexKey(index), value: JSON.stringify(stored) },
      { type: "put", key: "__count__", value: String(index + 1) },
    ]);

    this.latestEntry = entry;
    this.entryCount = index + 1;

    return entry;
  }

  /**
   * Retrieves a single entry by its zero-based index.
   *
   * @param index - The position in the chain to retrieve.
   * @returns The entry, or `null` if no entry exists at that index.
   */
  async getEntry(index: number): Promise<LedgerEntry | null> {
    if (index < 0 || index >= this.entryCount) {
      return null;
    }

    try {
      const raw = await this.db.get(indexKey(index));
      const stored: StoredEntry = JSON.parse(raw) as StoredEntry;
      return storedToEntry(stored);
    } catch {
      return null;
    }
  }

  /**
   * Returns the most recently appended entry, or `null` if the ledger is
   * empty.
   */
  async getLatest(): Promise<LedgerEntry | null> {
    return this.latestEntry;
  }

  /**
   * Walks the entire chain from genesis to the latest entry, recomputing each
   * hash and confirming it matches the stored value and that each entry's
   * `prevHash` matches the hash of its predecessor.
   *
   * @returns `true` if the chain is intact, `false` if any inconsistency is
   *   detected.
   */
  async verify(): Promise<boolean> {
    if (this.entryCount === 0) {
      return true;
    }

    let expectedPrevHash = new Uint8Array(0);

    for (let i = 0; i < this.entryCount; i++) {
      const entry = await this.getEntry(i);

      if (entry === null) {
        return false;
      }

      // Verify prevHash linkage.
      if (!buffersEqual(entry.prevHash, expectedPrevHash)) {
        return false;
      }

      // Recompute and verify hash.
      const recomputed = computeHash(
        entry.index,
        entry.prevHash,
        entry.message,
        entry.recordedAt,
        entry.action,
      );

      if (!buffersEqual(recomputed, entry.hash)) {
        return false;
      }

      expectedPrevHash = new Uint8Array(entry.hash);
    }

    return true;
  }

  /**
   * Returns the total number of entries currently stored in the ledger.
   */
  async getEntryCount(): Promise<number> {
    return this.entryCount;
  }
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return Buffer.from(a).equals(Buffer.from(b));
}
