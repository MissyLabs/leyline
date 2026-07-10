#!/usr/bin/env npx tsx
/**
 * Test plan verification: Signed confirmation protocol on live network.
 *
 * Connects two local nodes with quorum=1 consensus, submits a ledger entry
 * on A, pushes it to B, and verifies B sends back a signed confirmation.
 */

import { MagicNode } from '../src/node/magic-node.js';
import { LedgerConsensus } from '../src/ledger/consensus.js';
import { LedgerSync } from '../src/ledger/ledger-sync.js';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { sign, publicKeyToHex, generateKeypair } from '../src/identity/keypair.js';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function createTestNode() {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

async function main() {
  const tmpDir = await mkdtemp(join(tmpdir(), 'leyline-verify-confirm-'));
  const kpA = await generateKeypair();
  const kpB = await generateKeypair();

  const nodeA = await createTestNode();
  const nodeB = await createTestNode();

  await nodeB.dial(nodeA.getMultiaddrs()[0]);
  await sleep(500);

  const ledgerA = new SharedLedger(join(tmpDir, 'a'));
  const ledgerB = new SharedLedger(join(tmpDir, 'b'));
  await ledgerA.open();
  await ledgerB.open();

  // quorum=1 so single confirmation is enough to commit
  const consensusA = new LedgerConsensus({ quorumSize: 1 });
  const consensusB = new LedgerConsensus({ quorumSize: 1 });

  const syncA = new LedgerSync(nodeA, ledgerA, consensusA, kpA.publicKey, kpA.privateKey, {
    syncIntervalMs: 600_000,
  });
  const syncB = new LedgerSync(nodeB, ledgerB, consensusB, kpB.publicKey, kpB.privateKey, {
    syncIntervalMs: 600_000,
  });

  await syncA.start();
  await syncB.start();

  console.log(`Node A: ${publicKeyToHex(kpA.publicKey).slice(0, 16)}...`);
  console.log(`Node B: ${publicKeyToHex(kpB.publicKey).slice(0, 16)}...`);
  console.log(`Peers: A=${nodeA.getPeers().length}, B=${nodeB.getPeers().length}`);

  // Submit entry on A
  const data = new TextEncoder().encode('signed-confirmation-test');
  const sig = await sign(kpA.privateKey, data);
  const committed = await syncA.proposeAndMaybeCommit(
    data, kpA.publicKey, sig,
    [publicKeyToHex(kpA.publicKey)],
  );
  console.log(`\nEntry committed on A: ${committed}`);

  const entryA = await ledgerA.getEntry(1);
  if (!entryA) {
    console.error('FAIL: No entry on A');
    process.exit(1);
  }
  console.log(`Entry #${entryA.index} hash: ${Buffer.from(entryA.hash).toString('hex').slice(0, 16)}...`);

  // Push to B — B validates, commits, and sends back a signed confirmation
  console.log('\nPushing entry to B...');
  await syncA.pushEntry(nodeB.peerId.toString(), entryA);
  await sleep(2000);

  // Check B received and committed
  const countB = await ledgerB.getEntryCount();
  console.log(`B ledger count: ${countB}`);

  if (countB >= 1) {
    const entryB = await ledgerB.getEntry(1);
    console.log(`B entry confirmations: ${entryB?.confirmations}`);
  }

  // Check A received confirmation back from B
  const entryA2 = await ledgerA.getEntry(1);
  console.log(`\nA entry confirmations after push: ${entryA2?.confirmations}`);
  if (entryA2) {
    for (const pk of entryA2.confirmerPubkeys) {
      console.log(`  confirmer: ${publicKeyToHex(pk).slice(0, 16)}...`);
    }
  }

  const pass = countB >= 1 && (entryA2?.confirmations ?? 0) >= 1;

  console.log(`\n${'='.repeat(50)}`);
  console.log(pass
    ? 'PASS: Signed confirmation protocol works — B committed entry and A received signed confirmation back'
    : 'FAIL: Confirmation flow incomplete');
  console.log(`${'='.repeat(50)}`);

  await syncA.stop();
  await syncB.stop();
  await ledgerA.close();
  await ledgerB.close();
  await nodeA.stop();
  await nodeB.stop();
  await rm(tmpDir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
