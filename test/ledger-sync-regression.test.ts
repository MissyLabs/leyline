import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { generateKeypair, sign } from '../src/identity/keypair.js';
import { SharedLedger, type SharedLedgerEntry } from '../src/ledger/shared-ledger.js';
import { LedgerConsensus } from '../src/ledger/consensus.js';
import { LedgerSync, LEDGER_SYNC_PROTOCOL } from '../src/ledger/ledger-sync.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGlobalLogLevel, LogLevel } from '../src/utils/logger.js';

setGlobalLogLevel(LogLevel.SILENT);

const enc = new TextEncoder();
const toHex = (a: Uint8Array) => Buffer.from(a).toString('hex');

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

// FINDING 5: the ingest limiter must charge per DISTINCT entry, not per attempt.
// A replayed entry must consume at most one budget slot and must not starve a
// distinct new entry from the same submitter.
describe('LedgerSync — ingest limiter dedups replays (SEC-3 regression)', () => {
  it('replaying one entry costs one slot and does not block a new distinct entry', async () => {
    const kp = await generateKeypair();
    const submitter = await generateKeypair();
    const submitterHex = toHex(submitter.publicKey);

    // Minimal libp2p stub — admitSubmitter only touches local state.
    const stubLibp2p = { peerId: { toString: () => 'stub-peer' } } as unknown as Libp2p;
    const ledger = new SharedLedger(await mkdtemp(join(tmpdir(), 'sync-r5-')));
    await ledger.open();
    const sync = new LedgerSync(
      stubLibp2p,
      ledger,
      new LedgerConsensus({ quorumSize: 1 }),
      kp.publicKey,
      kp.privateKey,
      { maxIngestPerMinute: 3, syncIntervalMs: 600_000 },
    ) as unknown as {
      admitSubmitter(hex: string, id: string): boolean;
    };

    const makeEntry = (label: string): SharedLedgerEntry => ({
      index: 1,
      prevHash: new Uint8Array(0),
      hash: new Uint8Array(32).fill(1),
      data: enc.encode(label),
      submitterPubkey: submitter.publicKey,
      signature: new Uint8Array(64).fill(7),
      timestamp: 0,
      confirmations: 0,
      confirmerPubkeys: [],
      confirmerSignatures: [],
    });

    const identity = (e: SharedLedgerEntry): string =>
      (LedgerSync as unknown as { entryIdentity(e: SharedLedgerEntry): string }).entryIdentity(e);

    const e1 = makeEntry('entry-1');
    const id1 = identity(e1);

    // Replay the SAME entry far more than the budget allows.
    for (let i = 0; i < 20; i++) {
      expect(sync.admitSubmitter(submitterHex, id1)).toBe(true);
    }

    // A DISTINCT new entry from the same submitter must still be admitted:
    // replays consumed only one slot, not the whole budget.
    const e2 = makeEntry('entry-2');
    expect(sync.admitSubmitter(submitterHex, identity(e2))).toBe(true);

    // And a third distinct entry (budget now: e1, e2, e3 = 3) still fits.
    const e3 = makeEntry('entry-3');
    expect(sync.admitSubmitter(submitterHex, identity(e3))).toBe(true);

    // A fourth distinct entry exceeds the per-minute budget of 3 → rejected.
    const e4 = makeEntry('entry-4');
    expect(sync.admitSubmitter(submitterHex, identity(e4))).toBe(false);

    await ledger.close();
  });
});

// FINDING 6: the outbound pushEntry() response path must bind an incoming
// confirmation to the exact entry that was pushed (index AND hash). A peer that
// signs a valid `confirm:{otherHash}` and claims our entry's index must NOT get
// that confirmation stored against our entry.
describe('LedgerSync — pushEntry confirmation binding (regression)', () => {
  let nodeA: Libp2p;
  let nodeMal: Libp2p;
  let tmpDir: string;
  let ledgerA: SharedLedger;
  let syncA: LedgerSync;
  let kpA: Awaited<ReturnType<typeof generateKeypair>>;
  let kpMal: Awaited<ReturnType<typeof generateKeypair>>;
  // Controls what the malicious peer echoes back for the next push.
  let malMode: 'mismatch-hash' | 'mismatch-index' | 'correct' = 'mismatch-hash';

  beforeAll(async () => {
    kpA = await generateKeypair();
    kpMal = await generateKeypair();
    tmpDir = await mkdtemp(join(tmpdir(), 'sync-r6-'));

    nodeA = await createTestNode();
    nodeMal = await createTestNode();

    ledgerA = new SharedLedger(join(tmpDir, 'ledger-a'));
    await ledgerA.open();

    syncA = new LedgerSync(nodeA, ledgerA, new LedgerConsensus({ quorumSize: 1 }), kpA.publicKey, kpA.privateKey, {
      syncIntervalMs: 600_000,
    });
    await syncA.start();

    // Malicious peer: on push-entry, reply with a signature-valid confirmation
    // whose entryHash/index may not match the pushed entry.
    await nodeMal.handle(LEDGER_SYNC_PROTOCOL, async ({ stream }) => {
      await pipe(
        stream,
        (s) => lp.decode(s),
        async function* (source: AsyncIterable<{ subarray(): Uint8Array }>) {
          for await (const msg of source) {
            const push = JSON.parse(new TextDecoder().decode(msg.subarray()));
            if (push.type !== 'push-entry') continue;
            const realHash: string = push.entry.hash;
            const realIndex: number = push.entry.index;

            let entryHash = realHash;
            let entryIndex = realIndex;
            if (malMode === 'mismatch-hash') entryHash = 'ab'.repeat(32); // wrong 64-hex hash
            if (malMode === 'mismatch-index') entryIndex = realIndex + 999;

            const sig = await sign(kpMal.privateKey, enc.encode(`confirm:${entryHash}`));
            yield enc.encode(JSON.stringify({
              type: 'confirm-entry',
              senderPeerId: nodeMal.peerId.toString(),
              timestamp: Date.now(),
              entryIndex,
              entryHash,
              confirmerPubkey: toHex(kpMal.publicKey),
              confirmationSignature: toHex(sig),
            }));
          }
        },
        (s) => lp.encode(s),
        stream,
      );
    });

    await nodeA.dial(nodeMal.getMultiaddrs()[0]);
    await sleep(500);

    // Seed A with one entry to push.
    const data = enc.encode('bound-entry');
    await syncA.proposeAndMaybeCommit(data, kpA.publicKey, await sign(kpA.privateKey, data), ['self']);
  }, 20000);

  afterAll(async () => {
    await syncA?.stop();
    await ledgerA?.close();
    await nodeA?.stop();
    await nodeMal?.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects a confirmation whose entryHash does not match the pushed entry', async () => {
    malMode = 'mismatch-hash';
    const entry = await ledgerA.getEntry(1);
    await syncA.pushEntry(nodeMal.peerId.toString(), entry!);
    await sleep(600);
    const after = await ledgerA.getEntry(1);
    // The bogus confirmation must NOT have been stored.
    expect(after!.confirmerPubkeys.length).toBe(0);
  }, 10000);

  it('rejects a confirmation whose entryIndex does not match the pushed entry', async () => {
    malMode = 'mismatch-index';
    const entry = await ledgerA.getEntry(1);
    await syncA.pushEntry(nodeMal.peerId.toString(), entry!);
    await sleep(600);
    const after = await ledgerA.getEntry(1);
    expect(after!.confirmerPubkeys.length).toBe(0);
  }, 10000);

  it('accepts a correctly-bound confirmation (positive control)', async () => {
    malMode = 'correct';
    const entry = await ledgerA.getEntry(1);
    await syncA.pushEntry(nodeMal.peerId.toString(), entry!);
    await sleep(600);
    const after = await ledgerA.getEntry(1);
    expect(after!.confirmerPubkeys.map(toHex)).toContain(toHex(kpMal.publicKey));
  }, 10000);
});
