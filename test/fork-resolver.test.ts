import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedLedger, type SharedLedgerEntry } from '../src/ledger/shared-ledger.js';
import { ForkResolver, type PeerChainQuerier } from '../src/ledger/fork-resolver.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function toHex(arr: Uint8Array): string {
  return Buffer.from(arr).toString('hex');
}

function makeDummyData(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

const dummyPubkey = new Uint8Array(32).fill(1);
const dummySig = new Uint8Array(64).fill(2);
const altPubkey = new Uint8Array(32).fill(3);

async function buildChain(
  ledger: SharedLedger,
  count: number,
  prefix: string,
  pubkey = dummyPubkey,
  sig = dummySig,
): Promise<SharedLedgerEntry[]> {
  const entries: SharedLedgerEntry[] = [];
  for (let i = 0; i < count; i++) {
    const entry = await ledger.submit(makeDummyData(`${prefix}-${i}`), pubkey, sig);
    entries.push(entry);
  }
  return entries;
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

function makeFakeEntry(index: number, hashFill: number, data: string, confirmations = 0): SharedLedgerEntry {
  return {
    index,
    prevHash: new Uint8Array(32).fill(0),
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

describe('SharedLedger.rollbackTo', () => {
  let tmpDir: string;
  let ledger: SharedLedger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ledger-rollback-'));
    ledger = new SharedLedger(tmpDir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rolls back to an earlier index', async () => {
    await buildChain(ledger, 5, 'entry');
    expect(await ledger.getEntryCount()).toBe(5);

    await ledger.rollbackTo(3);

    expect(await ledger.getEntryCount()).toBe(3);
    expect(await ledger.getEntry(3)).not.toBeNull();
    expect(await ledger.getEntry(4)).toBeNull();
    expect(await ledger.getEntry(5)).toBeNull();
  });

  it('rolls back to 0 (empty ledger)', async () => {
    await buildChain(ledger, 3, 'entry');
    await ledger.rollbackTo(0);

    expect(await ledger.getEntryCount()).toBe(0);
    expect(await ledger.getLatest()).toBeNull();
  });

  it('no-ops when target is at or beyond current index', async () => {
    await buildChain(ledger, 3, 'entry');
    await ledger.rollbackTo(5);
    expect(await ledger.getEntryCount()).toBe(3);

    await ledger.rollbackTo(3);
    expect(await ledger.getEntryCount()).toBe(3);
  });

  it('allows new entries after rollback with correct hash chain', async () => {
    const entries = await buildChain(ledger, 5, 'original');
    const entry3Hash = toHex(entries[2].hash);

    await ledger.rollbackTo(3);
    const newEntry = await ledger.submit(makeDummyData('new-4'), dummyPubkey, dummySig);

    expect(newEntry.index).toBe(4);
    expect(toHex(newEntry.prevHash)).toBe(entry3Hash);
    expect(await ledger.verify()).toBe(true);
  });

  it('handles negative target index', async () => {
    await buildChain(ledger, 3, 'entry');
    await ledger.rollbackTo(-1);
    expect(await ledger.getEntryCount()).toBe(0);
  });

  it('persists rollback across reopen', async () => {
    await buildChain(ledger, 5, 'entry');
    await ledger.rollbackTo(2);
    await ledger.close();

    const ledger2 = new SharedLedger(tmpDir);
    await ledger2.open();

    expect(await ledger2.getEntryCount()).toBe(2);
    expect(await ledger2.getEntry(3)).toBeNull();
    await ledger2.close();
  });

  it('verify passes after rollback', async () => {
    await buildChain(ledger, 10, 'entry');
    await ledger.rollbackTo(5);
    expect(await ledger.verify()).toBe(true);
  });

  it('multiple rollbacks work correctly', async () => {
    await buildChain(ledger, 10, 'entry');
    await ledger.rollbackTo(7);
    expect(await ledger.getEntryCount()).toBe(7);
    await ledger.rollbackTo(3);
    expect(await ledger.getEntryCount()).toBe(3);
    await ledger.rollbackTo(0);
    expect(await ledger.getEntryCount()).toBe(0);
  });
});

describe('ForkResolver.detectFork', () => {
  let tmpDir: string;
  let ledger: SharedLedger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fork-detect-'));
    ledger = new SharedLedger(tmpDir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when chains are identical', async () => {
    const entries = await buildChain(ledger, 5, 'same');
    const peer = makeMockPeer(entries, []);

    const resolver = new ForkResolver(ledger);
    expect(await resolver.detectFork(peer)).toBeNull();
  });

  it('returns null when local ledger is empty', async () => {
    const peer = makeMockPeer([makeFakeEntry(1, 0xaa, 'peer')], []);
    const resolver = new ForkResolver(ledger);
    expect(await resolver.detectFork(peer)).toBeNull();
  });

  it('returns null when peer ledger is empty', async () => {
    await buildChain(ledger, 3, 'local');
    const peer: PeerChainQuerier = {
      async getEntryHash() { return null; },
      async getRange() { return []; },
      async getEntryCount() { return 0; },
    };
    const resolver = new ForkResolver(ledger);
    expect(await resolver.detectFork(peer)).toBeNull();
  });

  it('detects fork at the correct divergence point', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 2, 'local-diverge');

    const peer = makeMockPeer(common, [
      makeFakeEntry(4, 0xaa, 'peer-4'),
      makeFakeEntry(5, 0xbb, 'peer-5'),
    ]);

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.detectFork(peer);

    expect(fork).not.toBeNull();
    expect(fork!.divergenceIndex).toBe(4);
    expect(fork!.localLength).toBe(5);
    expect(fork!.peerLength).toBe(5);
  });

  it('detects fork at index 1 (genesis differs)', async () => {
    await buildChain(ledger, 1, 'local');
    const peer = makeMockPeer([], [makeFakeEntry(1, 0xff, 'peer-genesis')]);

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.detectFork(peer);

    expect(fork).not.toBeNull();
    expect(fork!.divergenceIndex).toBe(1);
  });

  it('handles peer with fewer entries than local', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 5, 'local-extra');

    const peer = makeMockPeer(common, [
      makeFakeEntry(4, 0xcc, 'peer-4'),
      makeFakeEntry(5, 0xdd, 'peer-5'),
    ]);

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.detectFork(peer);

    expect(fork).not.toBeNull();
    expect(fork!.divergenceIndex).toBe(4);
    expect(fork!.localLength).toBe(8);
    expect(fork!.peerLength).toBe(5);
  });
});

describe('ForkResolver.resolve', () => {
  let tmpDir: string;
  let ledger: SharedLedger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fork-resolve-'));
    ledger = new SharedLedger(tmpDir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('adopts peer chain when peer has more confirmations', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 2, 'local-diverge');

    const peerDivergent = [
      makeFakeEntry(4, 0xaa, 'peer-4', 3),
      makeFakeEntry(5, 0xbb, 'peer-5', 3),
    ];
    const peer = makeMockPeer(common, peerDivergent);

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.winner).toBe('peer');
    expect(fork!.resolved).toBe(true);
    expect(fork!.peerConfirmations).toBe(6);
    expect(fork!.localConfirmations).toBe(0);
    expect(await ledger.getEntryCount()).toBe(5);
  });

  it('keeps local chain when local has more confirmations', async () => {
    const common = await buildChain(ledger, 3, 'common');
    const localDivergent = await buildChain(ledger, 2, 'local-diverge');

    for (const entry of localDivergent) {
      await ledger.addConfirmation(entry.index, altPubkey);
      await ledger.addConfirmation(entry.index, new Uint8Array(32).fill(5));
    }

    const peerDivergent = [
      makeFakeEntry(4, 0xaa, 'peer-4', 0),
      makeFakeEntry(5, 0xbb, 'peer-5', 0),
    ];
    const peer = makeMockPeer(common, peerDivergent);

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.winner).toBe('local');
    expect(fork!.resolved).toBe(true);

    const entry4 = await ledger.getEntry(4);
    expect(new TextDecoder().decode(entry4!.data)).toBe('local-diverge-0');
  });

  it('resolves tie by preferring longer chain', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 1, 'local-short');

    const peerDivergent = [
      makeFakeEntry(4, 0xaa, 'peer-4'),
      makeFakeEntry(5, 0xbb, 'peer-5'),
      makeFakeEntry(6, 0xcc, 'peer-6'),
    ];
    const peer = makeMockPeer(common, peerDivergent);

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.winner).toBe('peer');
    expect(fork!.resolved).toBe(true);
    expect(await ledger.getEntryCount()).toBe(6);
  });

  it('keeps local on equal confirmations and equal length (tie-break)', async () => {
    const common = await buildChain(ledger, 3, 'common');
    await buildChain(ledger, 2, 'local-fork');

    const peerDivergent = [
      makeFakeEntry(4, 0xaa, 'peer-4'),
      makeFakeEntry(5, 0xbb, 'peer-5'),
    ];
    const peer = makeMockPeer(common, peerDivergent);

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.winner).toBe('local');
    expect(fork!.resolved).toBe(true);
  });

  it('refuses reorg deeper than maxReorgDepth', async () => {
    const common = await buildChain(ledger, 1, 'common');
    await buildChain(ledger, 10, 'local');

    const peerDivergent = Array.from({ length: 10 }, (_, i) =>
      makeFakeEntry(i + 2, 0xa0 + i, `peer-${i}`, 2),
    );
    const peer = makeMockPeer(common, peerDivergent);

    const resolver = new ForkResolver(ledger, { maxReorgDepth: 5 });
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.resolved).toBe(false);
    expect(fork!.winner).toBe('none');
    expect(await ledger.getEntryCount()).toBe(11);
  });

  it('returns null when no fork exists', async () => {
    const entries = await buildChain(ledger, 5, 'same');
    const peer = makeMockPeer(entries, []);

    const resolver = new ForkResolver(ledger);
    expect(await resolver.resolve(peer)).toBeNull();
  });

  it('chain verifies after adopting peer chain', async () => {
    const common = await buildChain(ledger, 5, 'common');
    await buildChain(ledger, 3, 'local-branch');

    const peerDivergent = [
      makeFakeEntry(6, 0xaa, 'peer-6', 5),
      makeFakeEntry(7, 0xbb, 'peer-7', 5),
      makeFakeEntry(8, 0xcc, 'peer-8', 5),
    ];
    const peer = makeMockPeer(common, peerDivergent);

    const resolver = new ForkResolver(ledger);
    await resolver.resolve(peer);

    expect(await ledger.verify()).toBe(true);
  });

  it('handles fork at genesis with peer winning', async () => {
    await buildChain(ledger, 1, 'local-genesis');

    const peerDivergent = [makeFakeEntry(1, 0xff, 'peer-genesis', 3)];
    const peer = makeMockPeer([], peerDivergent);

    const resolver = new ForkResolver(ledger);
    const fork = await resolver.resolve(peer);

    expect(fork).not.toBeNull();
    expect(fork!.winner).toBe('peer');
    expect(fork!.divergenceIndex).toBe(1);
    expect(await ledger.getEntryCount()).toBe(1);
  });
});
