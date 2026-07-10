#!/usr/bin/env npx tsx
/**
 * Test plan verification: mDNS discovery works on local network.
 *
 * Starts two nodes with mDNS enabled and NO seed nodes, verifies they
 * discover each other purely via multicast DNS on the local network.
 */

import { MagicNode } from '../src/node/magic-node.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const tmpDir = await mkdtemp(join(tmpdir(), 'leyline-verify-mdns-'));

  console.log('Starting two nodes with mDNS enabled, NO seed nodes...');

  const nodeA = new MagicNode({
    listenPort: 0,
    listenAddresses: ['/ip4/0.0.0.0/tcp/0'],
    subscribedTags: ['test:mdns'],
    dataDir: join(tmpDir, 'a'),
    seedNodes: [],        // No seeds
    enableMdns: true,     // mDNS on
  });
  const nodeB = new MagicNode({
    listenPort: 0,
    listenAddresses: ['/ip4/0.0.0.0/tcp/0'],
    subscribedTags: ['test:mdns'],
    dataDir: join(tmpDir, 'b'),
    seedNodes: [],        // No seeds
    enableMdns: true,     // mDNS on
  });

  await nodeA.start();
  await nodeB.start();

  console.log(`Node A: ${nodeA.getFingerprint()}`);
  console.log(`Node B: ${nodeB.getFingerprint()}`);

  // Wait for mDNS discovery (can take a few seconds)
  console.log('\nWaiting for mDNS peer discovery (up to 15s)...');
  const deadline = Date.now() + 15_000;
  let discovered = false;

  while (Date.now() < deadline) {
    const peersA = nodeA.getPeerCount();
    const peersB = nodeB.getPeerCount();
    if (peersA > 0 || peersB > 0) {
      discovered = true;
      console.log(`Discovered! A peers: ${peersA}, B peers: ${peersB}`);
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!discovered) {
    console.log(`A peers: ${nodeA.getPeerCount()}, B peers: ${nodeB.getPeerCount()}`);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(discovered
    ? 'PASS: mDNS discovery works — nodes found each other without seed nodes'
    : 'FAIL: mDNS discovery did not find peers within timeout (may not work in all environments — containers, VMs without multicast)');
  console.log(`${'='.repeat(50)}`);

  await nodeA.stop();
  await nodeB.stop();
  await rm(tmpDir, { recursive: true, force: true });
  process.exit(discovered ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
