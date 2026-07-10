import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedLedger, computeEntryHash, type SharedLedgerEntry } from '../src/ledger/shared-ledger.js';
import { ForkResolver, type PeerChainQuerier } from '../src/ledger/fork-resolver.js';
import { generateKeypair, sign } from '../src/identity/keypair.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGlobalLogLevel, LogLevel } from '../src/utils/logger.js';

setGlobalLogLevel(LogLevel.SILENT);

function toHex(arr: Uint8Array): string {
  return Buffer.from(arr).toString('hex');
}

const dummyPubkey = new Uint8Array(32).fill(1);
const dummySig = new Uint8Array(64).fill(2);

function makeDummyData(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

async function buildChain(
  ledger: SharedLedger,
  count: number,
  prefix: string,
): Promise<SharedLedgerEntry[]> {
  const entries: SharedLedgerEntry[] = [];
  for (let i = 0; i < count; i++) {
    const entry = await ledger.submit(makeDummyData(`${prefix}-${i}`), dummyPubkey, dummySig);
    entries.push(entry);
  }
  return entries;
}

function makeFakeEntry(index: number, hashFill: number, data: string, confirmations = 0, prevHash?: Uint8Array): SharedLedgerEntry {
  return {
    index,
    prevHash: prevHash ?? new Uint8Array(32).fill(0),
    hash: new Uint8Array(32).fill(hashFill),
    data: makeDummyData(data),
    submitterPubkey: dummyPubkey,
    signature: dummySig,
    timestamp: Date.now(),
    confirmations,
    confirmerPubkeys: confirmations > 0
      ? Array.from({ length: confirmations }, (_, i) => new Uint8Array(32).fill(10 + i))
      : [],
  };
}

function makeFakeChain(entries: Array<{ index: number; hashFill: number; data: string; confirmations?: number }>): SharedLedgerEntry[] {
  const result: SharedLedgerEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const prevHash = i === 0 ? new Uint8Array(32).fill(0) : result[i - 1].hash;
    result.push(makeFakeEntry(e.index, e.hashFill, e.data, e.confirmations ?? 0, prevHash));
  }
  return result;
}

/**
 * Cryptographically valid divergent chain: correct recomputed hashes, real
 * submitter signatures, and verifiable confirmer signatures. Required for
 * legitimate-reorg scenarios under SEC-1.
 */
async function makeSignedChain(
  specs: Array<{ index: number; data: string; confirmations?: number }>,
  prevHash: Uint8Array,
): Promise<SharedLedgerEntry[]> {
  const submitter = await generateKeypair();
  const result: SharedLedgerEntry[] = [];
  let prev = prevHash;
  for (const spec of specs) {
    const data = makeDummyData(spec.data);
    const timestamp = Date.now();
    const submitterPubkey = submitter.publicKey;
    const hash = computeEntryHash({ index: spec.index, prevHash: prev, data, submitterPubkey, timestamp });
    const signature = await sign(submitter.privateKey, data);
    const confirmerPubkeys: Uint8Array[] = [];
    const confirmerSignatures: Uint8Array[] = [];
    const confirmData = new TextEncoder().encode(`confirm:${toHex(hash)}`);
    for (let c = 0; c < (spec.confirmations ?? 0); c++) {
      const ckp = await generateKeypair();
      confirmerPubkeys.push(ckp.publicKey);
      confirmerSignatures.push(await sign(ckp.privateKey, confirmData));
    }
    result.push({
      index: spec.index, prevHash: prev, hash, data, submitterPubkey, signature,
      timestamp, confirmations: confirmerPubkeys.length, confirmerPubkeys, confirmerSignatures,
    });
    prev = hash;
  }
  return result;
}

function makeMockPeer(
  commonEntries: SharedLedgerEntry[],
  divergentEntries: SharedLedgerEntry[],
): PeerChainQuerier {
  const all = [...commonEntries, ...divergentEntries];
  return {
    async getEntryHash(index: number) {
      const e = all.find((x) => x.index === index);
      return e ? toHex(e.hash) : null;
    },
    async getRange(startIndex: number, endIndex: number) {
      return all.filter((e) => e.index >= startIndex && e.index <= endIndex);
    },
    async getEntryCount() {
      return all.length;
    },
  };
}

describe('ForkResolver — adversarial peer scenarios', () => {
  let tmpDir: string;
  let ledger: SharedLedger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fork-adv-'));
    ledger = new SharedLedger(tmpDir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects peer chain with broken prevHash linkage', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 2, 'local');

    const brokenChain = [
      makeFakeEntry(4, 0xaa, 'peer-4', 5, new Uint8Array(32).fill(0)),
      makeFakeEntry(5, 0xbb, 'peer-5', 5, new Uint8Array(32).fill(0xff)),
    ];
    const peer = makeMockPeer(common, brokenChain);

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.winner).toBe('local');
    expect(fork!.resolved).toBe(true);
  });

  it('rejects peer chain with non-sequential indices in range response', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 2, 'local');

    // Peer has valid hashes for binary search but returns entries with gap in getRange
    const entry4 = makeFakeEntry(4, 0xaa, 'peer-4', 5);
    const entry5 = makeFakeEntry(5, 0xbb, 'peer-5', 5, entry4.hash);
    const allPeer = [...common, entry4, entry5];

    const peer: PeerChainQuerier = {
      async getEntryHash(index: number) {
        const e = allPeer.find((x) => x.index === index);
        return e ? toHex(e.hash) : null;
      },
      async getRange(startIndex: number, endIndex: number) {
        // Malicious: return entries with swapped/non-sequential indices
        return [
          makeFakeEntry(4, 0xaa, 'peer-4', 5),
          makeFakeEntry(6, 0xcc, 'peer-gap', 5, new Uint8Array(32).fill(0xaa)),
        ];
      },
      async getEntryCount() { return 5; },
    };

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.winner).toBe('local');
  });

  it('handles peer that throws on getEntryCount', async () => {
    await buildChain(ledger, 3, 'local');

    const errorPeer: PeerChainQuerier = {
      async getEntryHash() { return null; },
      async getRange() { return []; },
      async getEntryCount() { throw new Error('network error'); },
    };

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.detectFork(errorPeer);
    expect(fork).toBeNull();
  });

  it('handles peer that throws on getEntryHash', async () => {
    await buildChain(ledger, 3, 'local');

    const errorPeer: PeerChainQuerier = {
      async getEntryHash() { throw new Error('connection reset'); },
      async getRange() { return []; },
      async getEntryCount() { return 3; },
    };

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.detectFork(errorPeer);
    expect(fork).toBeNull();
  });

  it('handles peer that throws on getRange during resolve', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 2, 'local');

    let callCount = 0;
    const peer: PeerChainQuerier = {
      async getEntryHash(index: number) {
        const e = [...common, makeFakeEntry(4, 0xdd, 'p4'), makeFakeEntry(5, 0xee, 'p5')].find(x => x.index === index);
        return e ? toHex(e.hash) : null;
      },
      async getRange() {
        callCount++;
        throw new Error('stream timeout');
      },
      async getEntryCount() { return 5; },
    };

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.resolved).toBe(false);
    expect(fork!.winner).toBe('none');
  });

  it('handles peer returning negative entry count', async () => {
    await buildChain(ledger, 3, 'local');

    const peer: PeerChainQuerier = {
      async getEntryHash() { return 'abc'; },
      async getRange() { return []; },
      async getEntryCount() { return -1; },
    };

    const resolver = new ForkResolver(ledger);
    expect(await resolver.detectFork(peer)).toBeNull();
  });

  it('handles peer returning Infinity entry count', async () => {
    await buildChain(ledger, 3, 'local');

    const peer: PeerChainQuerier = {
      async getEntryHash() { return 'abc'; },
      async getRange() { return []; },
      async getEntryCount() { return Infinity; },
    };

    const resolver = new ForkResolver(ledger);
    expect(await resolver.detectFork(peer)).toBeNull();
  });

  it('handles peer returning NaN entry count', async () => {
    await buildChain(ledger, 3, 'local');

    const peer: PeerChainQuerier = {
      async getEntryHash() { return 'abc'; },
      async getRange() { return []; },
      async getEntryCount() { return NaN; },
    };

    const resolver = new ForkResolver(ledger);
    expect(await resolver.detectFork(peer)).toBeNull();
  });

  it('handles peer returning empty range', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 2, 'local');

    const peer: PeerChainQuerier = {
      async getEntryHash(index: number) {
        if (index <= 3) {
          const e = common.find(x => x.index === index);
          return e ? toHex(e.hash) : null;
        }
        return toHex(new Uint8Array(32).fill(0xff));
      },
      async getRange() { return []; },
      async getEntryCount() { return 5; },
    };

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.winner).toBe('local');
    expect(fork!.resolved).toBe(true);
  });

  it('handles peer returning non-array from getRange', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 2, 'local');

    const peer: PeerChainQuerier = {
      async getEntryHash(index: number) {
        if (index <= 3) {
          const e = common.find(x => x.index === index);
          return e ? toHex(e.hash) : null;
        }
        return toHex(new Uint8Array(32).fill(0xff));
      },
      async getRange() { return 'not-an-array' as unknown as SharedLedgerEntry[]; },
      async getEntryCount() { return 5; },
    };

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.resolved).toBe(false);
    expect(fork!.winner).toBe('none');
  });

  it('valid peer chain with proper linkage is accepted', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 2, 'local');

    const peerDivergent = await makeSignedChain([
      { index: 4, data: 'peer-4', confirmations: 10 },
      { index: 5, data: 'peer-5', confirmations: 10 },
    ], common[common.length - 1].hash);
    const peer = makeMockPeer(common, peerDivergent);

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.winner).toBe('peer');
    expect(fork!.resolved).toBe(true);
    expect(await ledger.getEntryCount()).toBe(5);
  });

  it('local chain is unchanged when peer continuity check fails', async () => {
    const common = await buildChain(ledger, 3, 'common');
    const local = await buildChain(ledger, 2, 'local');

    const brokenChain = [
      makeFakeEntry(4, 0xaa, 'peer-4', 5),
      makeFakeEntry(5, 0xbb, 'peer-5', 5, new Uint8Array(32).fill(0xff)),
    ];
    const peer = makeMockPeer(common, brokenChain);

    const resolver = new ForkResolver(ledger);
    await resolver.resolve(peer);

    const entry4 = await ledger.getEntry(4);
    expect(entry4).not.toBeNull();
    expect(new TextDecoder().decode(entry4!.data)).toBe('local-0');
    expect(await ledger.getEntryCount()).toBe(5);
  });

  it('handles peer that returns null for all getEntryHash', async () => {
    await buildChain(ledger, 3, 'local');

    const peer: PeerChainQuerier = {
      async getEntryHash() { return null; },
      async getRange() { return []; },
      async getEntryCount() { return 3; },
    };

    const resolver = new ForkResolver(ledger);
    expect(await resolver.detectFork(peer)).toBeNull();
  });

  it('handles binary search with peer throwing intermittently', async () => {
    const common = await buildChain(ledger, 5, 'common');
    await buildChain(ledger, 3, 'local');

    let callIndex = 0;
    const peer: PeerChainQuerier = {
      async getEntryHash(index: number) {
        callIndex++;
        if (callIndex === 2) throw new Error('intermittent');
        if (index <= 5) {
          const e = common.find(x => x.index === index);
          return e ? toHex(e.hash) : null;
        }
        return toHex(new Uint8Array(32).fill(0xff));
      },
      async getRange() { return []; },
      async getEntryCount() { return 8; },
    };

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.detectFork(peer);
    // Should not crash, may or may not detect a fork depending on which call threw
    // Main assertion: no unhandled promise rejection
  });
});
