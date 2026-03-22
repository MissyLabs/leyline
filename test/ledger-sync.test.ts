import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { generateKeypair, sign } from '../src/identity/keypair.js';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { LedgerConsensus } from '../src/ledger/consensus.js';
import { LedgerSync } from '../src/ledger/ledger-sync.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function createTestNode() {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('LedgerSync', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let tmpDir: string;
  let ledgerA: SharedLedger;
  let ledgerB: SharedLedger;
  let consensusA: LedgerConsensus;
  let consensusB: LedgerConsensus;
  let syncA: LedgerSync;
  let syncB: LedgerSync;
  let kpA: Awaited<ReturnType<typeof generateKeypair>>;
  let kpB: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    kpA = await generateKeypair();
    kpB = await generateKeypair();
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-sync-'));
    nodeA = await createTestNode();
    nodeB = await createTestNode();

    await nodeB.dial(nodeA.getMultiaddrs()[0]);
    await sleep(500);

    ledgerA = new SharedLedger(join(tmpDir, 'ledger-a'));
    ledgerB = new SharedLedger(join(tmpDir, 'ledger-b'));
    await ledgerA.open();
    await ledgerB.open();

    // Use quorumSize=1 so single-node proposals finalize immediately
    consensusA = new LedgerConsensus({ quorumSize: 1 });
    consensusB = new LedgerConsensus({ quorumSize: 1 });

    syncA = new LedgerSync(nodeA, ledgerA, consensusA, kpA.publicKey, kpA.privateKey, {
      syncIntervalMs: 600_000, // disable auto-sync
    });
    syncB = new LedgerSync(nodeB, ledgerB, consensusB, kpB.publicKey, kpB.privateKey, {
      syncIntervalMs: 600_000,
    });

    await syncA.start();
    await syncB.start();
  }, 15000);

  afterAll(async () => {
    await syncA?.stop();
    await syncB?.stop();
    await ledgerA?.close();
    await ledgerB?.close();
    await nodeA?.stop();
    await nodeB?.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('proposeAndMaybeCommit submits an entry through consensus', async () => {
    const data = new TextEncoder().encode('test entry');
    const sig = await sign(kpA.privateKey, data);

    const committed = await syncA.proposeAndMaybeCommit(
      data,
      kpA.publicKey,
      sig,
      ['self-confirmer'],
    );
    expect(committed).toBe(true);

    const count = await ledgerA.getEntryCount();
    expect(count).toBe(1);

    const entry = await ledgerA.getEntry(1);
    expect(entry).not.toBeNull();
    expect(new TextDecoder().decode(entry!.data)).toBe('test entry');
  }, 10000);

  it('pushEntry sends an entry from A to B', async () => {
    const entry = await ledgerA.getEntry(1);
    expect(entry).not.toBeNull();

    await syncA.pushEntry(nodeB.peerId.toString(), entry!);
    await sleep(1000);

    // B should have received and committed the entry through consensus
    const countB = await ledgerB.getEntryCount();
    expect(countB).toBeGreaterThanOrEqual(1);
  }, 10000);

  it('requestRange fetches entries from a peer', async () => {
    // Add another entry to A
    const data2 = new TextEncoder().encode('second entry');
    const sig2 = await sign(kpA.privateKey, data2);
    await syncA.proposeAndMaybeCommit(data2, kpA.publicKey, sig2, ['self']);

    const entries = await syncB.requestRange(
      nodeA.peerId.toString(),
      1,
      10,
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
  }, 10000);
});
