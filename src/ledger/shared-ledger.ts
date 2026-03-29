import { createHash } from 'node:crypto';
import { Level } from 'level';

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
}

function toHex(arr: Uint8Array): string {
  return Buffer.from(arr).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
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
  };
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
        console.warn('[SharedLedger] Failed to load metadata — resetting to empty state. This may indicate data corruption:', err);
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
    };

    await this.db.put(`entry:${index}`, serializeEntry(entry));
    this.currentIndex = index;
    this.latestHash = hash;
    await this.db.put('meta:latest', JSON.stringify({ index, hash: toHex(hash) }));

    return entry;
  }

  /**
   * Add a peer confirmation to an existing entry.
   * Serialized via the same lock as submit() to prevent concurrent
   * read-modify-write races that could produce duplicate confirmers.
   */
  async addConfirmation(index: number, confirmerPubkey: Uint8Array): Promise<SharedLedgerEntry | null> {
    const prev = this.submitLock;
    let resolve!: () => void;
    this.submitLock = new Promise<void>((r) => { resolve = r; });

    try {
      await prev;
      return await this.addConfirmationInner(index, confirmerPubkey);
    } finally {
      resolve();
    }
  }

  private async addConfirmationInner(index: number, confirmerPubkey: Uint8Array): Promise<SharedLedgerEntry | null> {
    const entry = await this.getEntry(index);
    if (!entry) return null;

    const confirmerHex = toHex(confirmerPubkey);
    const alreadyConfirmed = entry.confirmerPubkeys.some((pk) => toHex(pk) === confirmerHex);
    if (alreadyConfirmed) return entry;

    entry.confirmerPubkeys.push(confirmerPubkey);
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
}
