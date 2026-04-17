/**
 * Deep regression tests for the ledger system.
 *
 * Covers: LedgerConsensus edge cases, proposeRemote clock-skew bug,
 * SharedLedger concurrency/validation, LocalLedger chain integrity,
 * LedgerSync protocol edge cases, and resource management.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { generateKeypair, sign, publicKeyToHex } from '../src/identity/keypair.js';
import { LedgerConsensus, type ConsensusConfig, type EntryProposal } from '../src/ledger/consensus.js';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { LocalLedger } from '../src/ledger/local-log.js';
import { LedgerSync } from '../src/ledger/ledger-sync.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function makeData(label: string): Uint8Array {
  return enc.encode(`data:${label}`);
}
function makePubkey(label: string): Uint8Array {
  return enc.encode(`pubkey:${label}`);
}
function makeSig(label: string): Uint8Array {
  return enc.encode(`sig:${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function createTestNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

// =========================================================================
// LedgerConsensus — proposeRemote & clock skew
// =========================================================================

describe('LedgerConsensus — proposeRemote', () => {
  let consensus: LedgerConsensus;

  beforeEach(() => {
    consensus = new LedgerConsensus({ maxClockSkewMs: 60_000 });
  });

  it('rejects proposal with timestamp too far in the future', () => {
    const futureTs = Date.now() + 120_000; // 2 minutes in future, beyond 60s skew
    const result = consensus.proposeRemote(
      makeData('future'),
      makePubkey('future'),
      makeSig('future'),
      futureTs,
    );
    expect(result).toBeUndefined();
  });

  it('accepts proposal within clock skew tolerance', () => {
    const withinSkew = Date.now() + 30_000; // 30s in future, within 60s tolerance
    const result = consensus.proposeRemote(
      makeData('within-skew'),
      makePubkey('within-skew'),
      makeSig('within-skew'),
      withinSkew,
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe('pending');
  });

  it('accepts proposal with past timestamp', () => {
    const pastTs = Date.now() - 30_000;
    const result = consensus.proposeRemote(
      makeData('past'),
      makePubkey('past'),
      makeSig('past'),
      pastTs,
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe('pending');
  });

  it('proposeRemote uses clamped timestamp (min of remote, local)', () => {
    const pastTs = Date.now() - 10_000; // 10 seconds ago
    const result = consensus.proposeRemote(
      makeData('clock-fix'),
      makePubkey('clock-fix'),
      makeSig('clock-fix'),
      pastTs,
    );

    expect(result).toBeDefined();
    // Fixed: timestamp should be clamped to Math.min(remoteTimestamp, now).
    // Since pastTs < now, the proposal should use pastTs.
    expect(result!.timestamp).toBe(pastTs);
  });

  it('proposeRemote clamps future timestamp to local time', () => {
    const before = Date.now();
    const futureWithinSkew = before + 30_000; // within 60s tolerance
    const result = consensus.proposeRemote(
      makeData('clamp-future'),
      makePubkey('clamp-future'),
      makeSig('clamp-future'),
      futureWithinSkew,
    );
    const after = Date.now();

    expect(result).toBeDefined();
    // Future timestamp within skew is accepted but clamped to local time
    expect(result!.timestamp).toBeGreaterThanOrEqual(before);
    expect(result!.timestamp).toBeLessThanOrEqual(after);
  });

  it('proposeRemote deduplicates by content (same data+submitter)', () => {
    const result1 = consensus.proposeRemote(
      makeData('dedup'),
      makePubkey('dedup'),
      makeSig('dedup'),
      Date.now(),
    );
    const result2 = consensus.proposeRemote(
      makeData('dedup'),
      makePubkey('dedup'),
      makeSig('dedup-2'),
      Date.now() + 1000,
    );
    // Should return the same proposal (content dedup via propose())
    expect(result1!.hash).toBe(result2!.hash);
  });

  it('rejects exactly at clock skew boundary (exclusive)', () => {
    // Exactly at boundary: now + maxClockSkewMs
    // The check is `> now + maxClockSkewMs`, so exactly at boundary should pass
    const now = Date.now();
    const exactBoundary = now + 60_000;
    const result = consensus.proposeRemote(
      makeData('boundary'),
      makePubkey('boundary'),
      makeSig('boundary'),
      exactBoundary,
    );
    // At boundary (not beyond), should be accepted
    expect(result).toBeDefined();
  });

  it('rejects 1ms beyond clock skew boundary', () => {
    const fixedNow = 1_700_000_000_000;
    const originalNow = Date.now;
    Date.now = () => fixedNow;

    try {
      const beyondBoundary = fixedNow + 60_001;
      const result = consensus.proposeRemote(
        makeData('beyond'),
        makePubkey('beyond'),
        makeSig('beyond'),
        beyondBoundary,
      );
      expect(result).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });

  it('proposeRemote with zero timestamp is accepted', () => {
    const result = consensus.proposeRemote(
      makeData('zero-ts'),
      makePubkey('zero-ts'),
      makeSig('zero-ts'),
      0,
    );
    expect(result).toBeDefined();
  });

  it('proposeRemote with negative timestamp is clamped to 0', () => {
    const result = consensus.proposeRemote(
      makeData('neg-ts'),
      makePubkey('neg-ts'),
      makeSig('neg-ts'),
      -1000,
    );
    expect(result).toBeDefined();
    expect(result!.timestamp).toBe(0);
  });
});

// =========================================================================
// LedgerConsensus — additional edge cases
// =========================================================================

describe('LedgerConsensus — edge cases', () => {
  it('quorumSize=1 finalizes on first confirmation', () => {
    const consensus = new LedgerConsensus({ quorumSize: 1 });
    const p = consensus.propose(makeData('q1'), makePubkey('q1'), makeSig('q1'));
    const reached = consensus.addConfirmation(p.hash, 'single-confirmer');
    expect(reached).toBe(true);
    expect(p.status).toBe('confirmed');
    expect(consensus.isFinalized(p.hash)).toBe(true);
  });

  it('quorumSize=1 with self-confirmation', () => {
    const consensus = new LedgerConsensus({ quorumSize: 1 });
    const p = consensus.propose(makeData('self'), makePubkey('self'), makeSig('self'));
    const reached = consensus.addConfirmation(p.hash, 'submitter-self');
    expect(reached).toBe(true);
    expect(consensus.getOrderedEntries()).toHaveLength(1);
  });

  it('empty data produces valid proposal', () => {
    const consensus = new LedgerConsensus();
    const p = consensus.propose(new Uint8Array(0), makePubkey('empty'), makeSig('empty'));
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.data.length).toBe(0);
  });

  it('empty pubkey produces valid proposal', () => {
    const consensus = new LedgerConsensus();
    const p = consensus.propose(makeData('empty-pk'), new Uint8Array(0), makeSig('empty-pk'));
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('empty signature produces valid proposal', () => {
    const consensus = new LedgerConsensus();
    const p = consensus.propose(makeData('empty-sig'), makePubkey('empty-sig'), new Uint8Array(0));
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('large data produces valid proposal', () => {
    const consensus = new LedgerConsensus();
    const bigData = new Uint8Array(1024 * 1024); // 1MB
    bigData.fill(0xAB);
    const p = consensus.propose(bigData, makePubkey('big'), makeSig('big'));
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('findByContent returns existing proposal', () => {
    const consensus = new LedgerConsensus();
    const data = makeData('find-me');
    const pubkey = makePubkey('find-me');
    const p = consensus.propose(data, pubkey, makeSig('find-me'));
    const found = consensus.findByContent(data, pubkey);
    expect(found).toBeDefined();
    expect(found!.hash).toBe(p.hash);
  });

  it('findByContent returns undefined for unknown content', () => {
    const consensus = new LedgerConsensus();
    const found = consensus.findByContent(makeData('nope'), makePubkey('nope'));
    expect(found).toBeUndefined();
  });

  it('propose with identical data but different pubkey creates separate proposals', () => {
    const consensus = new LedgerConsensus();
    const data = makeData('shared');
    const p1 = consensus.propose(data, makePubkey('alice'), makeSig('alice'));
    const p2 = consensus.propose(data, makePubkey('bob'), makeSig('bob'));
    expect(p1.hash).not.toBe(p2.hash);
  });

  it('getProposal returns undefined for unknown hash', () => {
    const consensus = new LedgerConsensus();
    expect(consensus.getProposal('deadbeef')).toBeUndefined();
  });

  it('maxPendingEntries allows exact count before throwing', () => {
    const consensus = new LedgerConsensus({ maxPendingEntries: 3 });
    consensus.propose(makeData('1'), makePubkey('1'), makeSig('1'));
    consensus.propose(makeData('2'), makePubkey('2'), makeSig('2'));
    consensus.propose(makeData('3'), makePubkey('3'), makeSig('3'));
    expect(() => consensus.propose(makeData('4'), makePubkey('4'), makeSig('4')))
      .toThrow(/maxPendingEntries/);
  });

  it('confirmed proposals do not count toward pending limit', () => {
    const consensus = new LedgerConsensus({ maxPendingEntries: 2, quorumSize: 1 });
    const p1 = consensus.propose(makeData('a'), makePubkey('a'), makeSig('a'));
    consensus.addConfirmation(p1.hash, 'peer');
    // p1 is now confirmed, so only 0 pending
    consensus.propose(makeData('b'), makePubkey('b'), makeSig('b'));
    consensus.propose(makeData('c'), makePubkey('c'), makeSig('c'));
    // Should succeed — only 2 pending (b and c), p1 is confirmed
    expect(consensus.getPendingProposals()).toHaveLength(2);
  });

  it('rejected proposals do not count toward pending limit', () => {
    const consensus = new LedgerConsensus({ maxPendingEntries: 1 });
    const p = consensus.propose(makeData('rej'), makePubkey('rej'), makeSig('rej'));
    consensus.reject(p.hash);
    // Rejected, so 0 pending — next propose should succeed
    const p2 = consensus.propose(makeData('next'), makePubkey('next'), makeSig('next'));
    expect(p2.status).toBe('pending');
  });

  it('pruneExpired cleans up contentIndex', async () => {
    const consensus = new LedgerConsensus({ proposalTimeoutMs: 1 });
    const data = makeData('prune-ci');
    const pubkey = makePubkey('prune-ci');
    consensus.propose(data, pubkey, makeSig('prune-ci'));

    await sleep(10);
    consensus.pruneExpired();

    // Content index should be cleaned — findByContent returns undefined
    expect(consensus.findByContent(data, pubkey)).toBeUndefined();
  });

  it('re-proposing after prune creates new proposal with new hash', async () => {
    const consensus = new LedgerConsensus({ proposalTimeoutMs: 1 });
    const data = makeData('repropose');
    const pubkey = makePubkey('repropose');
    const sig = makeSig('repropose');

    const p1 = consensus.propose(data, pubkey, sig);
    const hash1 = p1.hash;

    await sleep(10);
    consensus.pruneExpired();

    // Timestamp will differ, so hash changes
    const p2 = consensus.propose(data, pubkey, sig);
    expect(p2.hash).not.toBe(hash1);
    expect(p2.status).toBe('pending');
  });
});

// =========================================================================
// LedgerConsensus — config validation
// =========================================================================

describe('LedgerConsensus — config validation gaps', () => {
  it('accepts proposalTimeoutMs=0 (no validation)', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const consensus = new LedgerConsensus({ proposalTimeoutMs: 0 });
      consensus.propose(makeData('t0'), makePubkey('t0'), makeSig('t0'));
      expect(consensus.pruneExpired()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(consensus.pruneExpired()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects negative proposalTimeoutMs', () => {
    expect(() => new LedgerConsensus({ proposalTimeoutMs: -1000 }))
      .toThrow(/proposalTimeoutMs/);
  });

  it('accepts maxClockSkewMs=0 (extremely strict)', () => {
    // 0 is a valid edge case — rejects any future timestamp
    const consensus = new LedgerConsensus({ maxClockSkewMs: 0 });
    const result = consensus.proposeRemote(
      makeData('strict'),
      makePubkey('strict'),
      makeSig('strict'),
      Date.now() + 1, // 1ms in future, beyond 0ms tolerance
    );
    expect(result).toBeUndefined();
  });

  it('rejects negative maxClockSkewMs', () => {
    expect(() => new LedgerConsensus({ maxClockSkewMs: -1 }))
      .toThrow(/maxClockSkewMs/);
  });

  it('large quorumSize is accepted', () => {
    const consensus = new LedgerConsensus({ quorumSize: 1000 });
    const p = consensus.propose(makeData('big-q'), makePubkey('big-q'), makeSig('big-q'));
    // Will never reach quorum with reasonable peers
    for (let i = 0; i < 999; i++) {
      consensus.addConfirmation(p.hash, `peer-${i}`);
    }
    expect(p.status).toBe('pending');
    consensus.addConfirmation(p.hash, 'peer-999');
    expect(p.status).toBe('confirmed');
  });
});

// =========================================================================
// LedgerConsensus — ordering
// =========================================================================

describe('LedgerConsensus — ordering edge cases', () => {
  it('getOrderedEntries returns empty when all proposals are pending', () => {
    const c = new LedgerConsensus();
    c.propose(makeData('a'), makePubkey('a'), makeSig('a'));
    c.propose(makeData('b'), makePubkey('b'), makeSig('b'));
    expect(c.getOrderedEntries()).toHaveLength(0);
  });

  it('getOrderedEntries excludes rejected proposals', () => {
    const c = new LedgerConsensus({ quorumSize: 1 });
    const p1 = c.propose(makeData('ok'), makePubkey('ok'), makeSig('ok'));
    const p2 = c.propose(makeData('bad'), makePubkey('bad'), makeSig('bad'));
    c.addConfirmation(p1.hash, 'peer');
    c.reject(p2.hash);
    const ordered = c.getOrderedEntries();
    expect(ordered).toHaveLength(1);
    expect(ordered[0].hash).toBe(p1.hash);
  });

  it('getFinalizedProposals stable sort across calls', () => {
    const c = new LedgerConsensus({ quorumSize: 1 });
    const proposals: EntryProposal[] = [];
    for (let i = 0; i < 10; i++) {
      const p = c.propose(makeData(`sort-${i}`), makePubkey(`sort-${i}`), makeSig(`sort-${i}`));
      c.addConfirmation(p.hash, 'peer');
      proposals.push(p);
    }
    const first = c.getFinalizedProposals().map(p => p.hash);
    const second = c.getFinalizedProposals().map(p => p.hash);
    expect(first).toEqual(second);
  });
});

// =========================================================================
// SharedLedger — edge cases
// =========================================================================

describe('SharedLedger — edge cases', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-shared-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('first entry has index 1', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'idx1'));
    await ledger.open();
    const entry = await ledger.submit(makeData('first'), makePubkey('a'), makeSig('a'));
    expect(entry.index).toBe(1);
    await ledger.close();
  });

  it('genesis entry has empty prevHash', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'genesis'));
    await ledger.open();
    const entry = await ledger.submit(makeData('gen'), makePubkey('a'), makeSig('a'));
    expect(entry.prevHash.length).toBe(0);
    await ledger.close();
  });

  it('second entry prevHash equals first entry hash', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'chain-link'));
    await ledger.open();
    const e1 = await ledger.submit(makeData('e1'), makePubkey('a'), makeSig('a'));
    const e2 = await ledger.submit(makeData('e2'), makePubkey('b'), makeSig('b'));
    expect(Buffer.from(e2.prevHash).toString('hex')).toBe(
      Buffer.from(e1.hash).toString('hex'),
    );
    await ledger.close();
  });

  it('empty data submission succeeds', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'empty-data'));
    await ledger.open();
    const entry = await ledger.submit(new Uint8Array(0), makePubkey('a'), makeSig('a'));
    expect(entry.data.length).toBe(0);
    expect(await ledger.verify()).toBe(true);
    await ledger.close();
  });

  it('empty pubkey submission succeeds', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'empty-pk'));
    await ledger.open();
    const entry = await ledger.submit(makeData('a'), new Uint8Array(0), makeSig('a'));
    expect(entry.submitterPubkey.length).toBe(0);
    expect(await ledger.verify()).toBe(true);
    await ledger.close();
  });

  it('concurrent submit calls are serialized correctly', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'concurrent'));
    await ledger.open();

    // Fire 10 concurrent submits
    const promises = Array.from({ length: 10 }, (_, i) =>
      ledger.submit(makeData(`c-${i}`), makePubkey(`c-${i}`), makeSig(`c-${i}`)),
    );
    const entries = await Promise.all(promises);

    // All entries should have unique sequential indices
    const indices = entries.map(e => e.index).sort((a, b) => a - b);
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Chain integrity should hold
    expect(await ledger.verify()).toBe(true);
    await ledger.close();
  });

  it('getEntry returns null for non-existent index', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'null-get'));
    await ledger.open();
    expect(await ledger.getEntry(999)).toBeNull();
    expect(await ledger.getEntry(0)).toBeNull();
    expect(await ledger.getEntry(-1)).toBeNull();
    await ledger.close();
  });

  it('getLatest returns null on empty ledger', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'empty-latest'));
    await ledger.open();
    expect(await ledger.getLatest()).toBeNull();
    await ledger.close();
  });

  it('getEntryCount returns 0 on empty ledger', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'empty-count'));
    await ledger.open();
    expect(await ledger.getEntryCount()).toBe(0);
    await ledger.close();
  });

  it('addConfirmation returns null for non-existent entry', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'no-confirm'));
    await ledger.open();
    expect(await ledger.addConfirmation(999, makePubkey('a'))).toBeNull();
    await ledger.close();
  });

  it('addConfirmation deduplicates by pubkey', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'dedup-confirm'));
    await ledger.open();
    await ledger.submit(makeData('a'), makePubkey('a'), makeSig('a'));

    const pubkey = makePubkey('confirmer');
    await ledger.addConfirmation(1, pubkey);
    await ledger.addConfirmation(1, pubkey); // duplicate

    const entry = await ledger.getEntry(1);
    expect(entry!.confirmations).toBe(1);
    expect(entry!.confirmerPubkeys).toHaveLength(1);
    await ledger.close();
  });

  it('multiple distinct confirmations increment count', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'multi-confirm'));
    await ledger.open();
    await ledger.submit(makeData('a'), makePubkey('a'), makeSig('a'));

    await ledger.addConfirmation(1, makePubkey('c1'));
    await ledger.addConfirmation(1, makePubkey('c2'));
    await ledger.addConfirmation(1, makePubkey('c3'));

    const entry = await ledger.getEntry(1);
    expect(entry!.confirmations).toBe(3);
    expect(entry!.confirmerPubkeys).toHaveLength(3);
    await ledger.close();
  });

  it('verify returns true for empty ledger', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'empty-verify'));
    await ledger.open();
    expect(await ledger.verify()).toBe(true);
    await ledger.close();
  });

  it('getRange returns empty for out-of-bounds indices', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'range-oob'));
    await ledger.open();
    await ledger.submit(makeData('a'), makePubkey('a'), makeSig('a'));
    expect(await ledger.getRange(100, 200)).toHaveLength(0);
    await ledger.close();
  });

  it('getRange with startIndex > endIndex returns empty', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'range-rev'));
    await ledger.open();
    await ledger.submit(makeData('a'), makePubkey('a'), makeSig('a'));
    expect(await ledger.getRange(5, 1)).toHaveLength(0);
    await ledger.close();
  });

  it('getRange returns correct subset', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'range-sub'));
    await ledger.open();
    for (let i = 0; i < 5; i++) {
      await ledger.submit(makeData(`r-${i}`), makePubkey(`r-${i}`), makeSig(`r-${i}`));
    }
    const range = await ledger.getRange(2, 4);
    expect(range).toHaveLength(3);
    expect(range[0].index).toBe(2);
    expect(range[2].index).toBe(4);
    await ledger.close();
  });

  it('persists entries across close/open cycle', async () => {
    const dir = join(tmpDir, 'persist');
    const ledger1 = new SharedLedger(dir);
    await ledger1.open();
    await ledger1.submit(makeData('persist-a'), makePubkey('a'), makeSig('a'));
    await ledger1.submit(makeData('persist-b'), makePubkey('b'), makeSig('b'));
    await ledger1.close();

    const ledger2 = new SharedLedger(dir);
    await ledger2.open();
    expect(await ledger2.getEntryCount()).toBe(2);
    const entry = await ledger2.getEntry(1);
    expect(new TextDecoder().decode(entry!.data)).toBe('data:persist-a');
    expect(await ledger2.verify()).toBe(true);
    await ledger2.close();
  });
});

// =========================================================================
// LocalLedger — edge cases
// =========================================================================

describe('LocalLedger — edge cases', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-local-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('first entry has index 0 (not 1)', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'idx0'));
    await ledger.open();
    const entry = await ledger.append(makeData('first'), 'create');
    expect(entry.index).toBe(0);
    await ledger.close();
  });

  it('genesis entry has empty prevHash', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'local-genesis'));
    await ledger.open();
    const entry = await ledger.append(makeData('gen'), 'create');
    expect(entry.prevHash.length).toBe(0);
    await ledger.close();
  });

  it('chain links correctly across multiple appends', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'local-chain'));
    await ledger.open();
    const e0 = await ledger.append(makeData('0'), 'a');
    const e1 = await ledger.append(makeData('1'), 'b');
    const e2 = await ledger.append(makeData('2'), 'c');

    expect(Buffer.from(e1.prevHash).equals(Buffer.from(e0.hash))).toBe(true);
    expect(Buffer.from(e2.prevHash).equals(Buffer.from(e1.hash))).toBe(true);
    expect(await ledger.verify()).toBe(true);
    await ledger.close();
  });

  it('empty message appends successfully', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'local-empty'));
    await ledger.open();
    const entry = await ledger.append(new Uint8Array(0), 'empty');
    expect(entry.message.length).toBe(0);
    expect(await ledger.verify()).toBe(true);
    await ledger.close();
  });

  it('empty action string appends successfully', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'local-empty-action'));
    await ledger.open();
    const entry = await ledger.append(makeData('a'), '');
    expect(entry.action).toBe('');
    expect(await ledger.verify()).toBe(true);
    await ledger.close();
  });

  it('getEntry returns null for negative index', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'local-neg'));
    await ledger.open();
    await ledger.append(makeData('a'), 'x');
    expect(await ledger.getEntry(-1)).toBeNull();
    await ledger.close();
  });

  it('getEntry returns null for out-of-bounds index', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'local-oob'));
    await ledger.open();
    await ledger.append(makeData('a'), 'x');
    expect(await ledger.getEntry(999)).toBeNull();
    await ledger.close();
  });

  it('getLatest returns null on empty ledger', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'local-empty-latest'));
    await ledger.open();
    expect(await ledger.getLatest()).toBeNull();
    await ledger.close();
  });

  it('getEntryCount returns 0 on empty ledger', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'local-empty-count'));
    await ledger.open();
    expect(await ledger.getEntryCount()).toBe(0);
    await ledger.close();
  });

  it('verify returns true for empty ledger', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'local-empty-verify'));
    await ledger.open();
    expect(await ledger.verify()).toBe(true);
    await ledger.close();
  });

  it('persists entries across close/open cycle', async () => {
    const dir = join(tmpDir, 'local-persist');
    const ledger1 = new LocalLedger(dir);
    await ledger1.open();
    await ledger1.append(makeData('a'), 'sent');
    await ledger1.append(makeData('b'), 'received');
    await ledger1.close();

    const ledger2 = new LocalLedger(dir);
    await ledger2.open();
    expect(await ledger2.getEntryCount()).toBe(2);
    const entry = await ledger2.getEntry(0);
    expect(new TextDecoder().decode(entry!.message)).toBe('data:a');
    expect(await ledger2.verify()).toBe(true);
    await ledger2.close();
  });

  it('appends after reopen continue the chain', async () => {
    const dir = join(tmpDir, 'local-reopen-chain');
    const ledger1 = new LocalLedger(dir);
    await ledger1.open();
    const e0 = await ledger1.append(makeData('before'), 'x');
    await ledger1.close();

    const ledger2 = new LocalLedger(dir);
    await ledger2.open();
    const e1 = await ledger2.append(makeData('after'), 'y');
    expect(e1.index).toBe(1);
    expect(Buffer.from(e1.prevHash).equals(Buffer.from(e0.hash))).toBe(true);
    expect(await ledger2.verify()).toBe(true);
    await ledger2.close();
  });

  it('special characters in action are preserved', async () => {
    const ledger = new LocalLedger(join(tmpDir, 'local-special'));
    await ledger.open();
    const entry = await ledger.append(
      makeData('a'),
      'test "action" with <html> & \n\t unicode: \u00e9\u2603',
    );
    const retrieved = await ledger.getEntry(0);
    expect(retrieved!.action).toBe(entry.action);
    expect(await ledger.verify()).toBe(true);
    await ledger.close();
  });
});

// =========================================================================
// SharedLedger — index consistency (Local starts at 0, Shared at 1)
// =========================================================================

describe('SharedLedger vs LocalLedger — index consistency', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-idx-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('SharedLedger starts at index 1, LocalLedger at index 0', async () => {
    const shared = new SharedLedger(join(tmpDir, 'shared-idx'));
    const local = new LocalLedger(join(tmpDir, 'local-idx'));
    await shared.open();
    await local.open();

    const se = await shared.submit(makeData('s'), makePubkey('s'), makeSig('s'));
    const le = await local.append(makeData('l'), 'test');

    expect(se.index).toBe(1); // 1-based
    expect(le.index).toBe(0); // 0-based

    await shared.close();
    await local.close();
  });
});

// =========================================================================
// LedgerSync — protocol edge cases
// =========================================================================

describe('LedgerSync — edge cases', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let tmpDir: string;
  let kpA: Awaited<ReturnType<typeof generateKeypair>>;
  let kpB: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    kpA = await generateKeypair();
    kpB = await generateKeypair();
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-sync-regr-'));
    nodeA = await createTestNode();
    nodeB = await createTestNode();
    await nodeB.dial(nodeA.getMultiaddrs()[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('requestRange to non-existent peer returns empty', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'sync-noexist'));
    await ledger.open();
    const consensus = new LedgerConsensus({ quorumSize: 1 });
    const sync = new LedgerSync(nodeA, ledger, consensus, kpA.publicKey, kpA.privateKey, {
      syncIntervalMs: 600_000,
    });
    await sync.start();

    const entries = await sync.requestRange('12D3KooWFakeIDnotReal', 1, 10);
    expect(entries).toHaveLength(0);

    await sync.stop();
    await ledger.close();
  }, 10000);

  it('requestRange with startIndex > endIndex returns empty', async () => {
    const ledgerA = new SharedLedger(join(tmpDir, 'sync-rev-a'));
    const ledgerB = new SharedLedger(join(tmpDir, 'sync-rev-b'));
    await ledgerA.open();
    await ledgerB.open();

    const cA = new LedgerConsensus({ quorumSize: 1 });
    const cB = new LedgerConsensus({ quorumSize: 1 });

    const syncA = new LedgerSync(nodeA, ledgerA, cA, kpA.publicKey, kpA.privateKey, {
      syncIntervalMs: 600_000,
    });
    const syncB = new LedgerSync(nodeB, ledgerB, cB, kpB.publicKey, kpB.privateKey, {
      syncIntervalMs: 600_000,
    });
    await syncA.start();
    await syncB.start();

    // Add some entries to A
    const data = makeData('rev');
    const sig = await sign(kpA.privateKey, data);
    await syncA.proposeAndMaybeCommit(data, kpA.publicKey, sig, [publicKeyToHex(kpA.publicKey)]);

    // Request reversed range
    const entries = await syncB.requestRange(nodeA.peerId.toString(), 10, 1);
    expect(entries).toHaveLength(0);

    await syncA.stop();
    await syncB.stop();
    await ledgerA.close();
    await ledgerB.close();
  }, 10000);

  it('proposeAndMaybeCommit returns false at maxPendingEntries', async () => {
    const ledger = new SharedLedger(join(tmpDir, 'sync-maxpend'));
    await ledger.open();
    const consensus = new LedgerConsensus({ quorumSize: 100, maxPendingEntries: 2 });
    const sync = new LedgerSync(nodeA, ledger, consensus, kpA.publicKey, kpA.privateKey, {
      syncIntervalMs: 600_000,
    });
    await sync.start();

    const sig = await sign(kpA.privateKey, makeData('p1'));
    await sync.proposeAndMaybeCommit(makeData('p1'), kpA.publicKey, sig, []);
    const sig2 = await sign(kpA.privateKey, makeData('p2'));
    await sync.proposeAndMaybeCommit(makeData('p2'), kpA.publicKey, sig2, []);

    // Third should fail gracefully (maxPendingEntries=2 reached)
    const sig3 = await sign(kpA.privateKey, makeData('p3'));
    const result = await sync.proposeAndMaybeCommit(makeData('p3'), kpA.publicKey, sig3, []);
    expect(result).toBe(false);

    await sync.stop();
    await ledger.close();
  }, 10000);

  it('pushEntry + confirmation round trip works', async () => {
    const ledgerA = new SharedLedger(join(tmpDir, 'sync-rt-a'));
    const ledgerB = new SharedLedger(join(tmpDir, 'sync-rt-b'));
    await ledgerA.open();
    await ledgerB.open();

    const cA = new LedgerConsensus({ quorumSize: 1 });
    const cB = new LedgerConsensus({ quorumSize: 1 });

    const syncA = new LedgerSync(nodeA, ledgerA, cA, kpA.publicKey, kpA.privateKey, {
      syncIntervalMs: 600_000,
    });
    const syncB = new LedgerSync(nodeB, ledgerB, cB, kpB.publicKey, kpB.privateKey, {
      syncIntervalMs: 600_000,
    });
    await syncA.start();
    await syncB.start();

    // Submit entry on A
    const data = enc.encode('round-trip-entry');
    const sig = await sign(kpA.privateKey, data);
    await syncA.proposeAndMaybeCommit(data, kpA.publicKey, sig, [publicKeyToHex(kpA.publicKey)]);

    // Push to B
    const entry = await ledgerA.getEntry(1);
    expect(entry).not.toBeNull();
    await syncA.pushEntry(nodeB.peerId.toString(), entry!);
    await sleep(1000);

    // B should have received it
    const countB = await ledgerB.getEntryCount();
    expect(countB).toBeGreaterThanOrEqual(1);

    // Verify B's chain integrity
    expect(await ledgerB.verify()).toBe(true);

    await syncA.stop();
    await syncB.stop();
    await ledgerA.close();
    await ledgerB.close();
  }, 15000);

  it('broadcastEntry sends to all connected peers', async () => {
    const ledgerA = new SharedLedger(join(tmpDir, 'sync-bcast-a'));
    const ledgerB = new SharedLedger(join(tmpDir, 'sync-bcast-b'));
    await ledgerA.open();
    await ledgerB.open();

    const cA = new LedgerConsensus({ quorumSize: 1 });
    const cB = new LedgerConsensus({ quorumSize: 1 });

    const syncA = new LedgerSync(nodeA, ledgerA, cA, kpA.publicKey, kpA.privateKey, {
      syncIntervalMs: 600_000,
    });
    const syncB = new LedgerSync(nodeB, ledgerB, cB, kpB.publicKey, kpB.privateKey, {
      syncIntervalMs: 600_000,
    });
    await syncA.start();
    await syncB.start();

    const data = enc.encode('broadcast-test');
    const sig = await sign(kpA.privateKey, data);
    await syncA.proposeAndMaybeCommit(data, kpA.publicKey, sig, [publicKeyToHex(kpA.publicKey)]);

    const entry = await ledgerA.getEntry(1);
    await syncA.broadcastEntry(entry!);
    await sleep(1000);

    expect(await ledgerB.getEntryCount()).toBeGreaterThanOrEqual(1);

    await syncA.stop();
    await syncB.stop();
    await ledgerA.close();
    await ledgerB.close();
  }, 15000);

  it('validateReceivedEntry rejects invalid signatures', async () => {
    const ledgerA = new SharedLedger(join(tmpDir, 'sync-badsig-a'));
    const ledgerB = new SharedLedger(join(tmpDir, 'sync-badsig-b'));
    await ledgerA.open();
    await ledgerB.open();

    const cA = new LedgerConsensus({ quorumSize: 1 });
    const cB = new LedgerConsensus({ quorumSize: 1 });

    const syncA = new LedgerSync(nodeA, ledgerA, cA, kpA.publicKey, kpA.privateKey, {
      syncIntervalMs: 600_000,
    });
    const syncB = new LedgerSync(nodeB, ledgerB, cB, kpB.publicKey, kpB.privateKey, {
      syncIntervalMs: 600_000,
    });
    await syncA.start();
    await syncB.start();

    // Submit a valid entry to A so it has something in the ledger
    const data = enc.encode('valid-entry');
    const sig = await sign(kpA.privateKey, data);
    await syncA.proposeAndMaybeCommit(data, kpA.publicKey, sig, [publicKeyToHex(kpA.publicKey)]);

    // Tamper: push an entry with wrong signature
    const entry = await ledgerA.getEntry(1);
    const tampered = {
      ...entry!,
      signature: new Uint8Array(64).fill(0xFF), // garbage signature
    };
    await syncA.pushEntry(nodeB.peerId.toString(), tampered);
    await sleep(1000);

    // B should NOT have accepted the tampered entry
    expect(await ledgerB.getEntryCount()).toBe(0);

    await syncA.stop();
    await syncB.stop();
    await ledgerA.close();
    await ledgerB.close();
  }, 15000);
});
