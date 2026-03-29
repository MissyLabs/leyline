#!/usr/bin/env npx tsx
/**
 * net-stats.ts — Connect to the leyline network, gather stats, and print a summary table.
 *
 * Usage:  npx tsx scripts/net-stats.ts
 */

import { MagicNode } from '../src/node/magic-node.js';
import type { GossipSub } from '@chainsafe/libp2p-gossipsub';

const WAIT_MS = 8_000; // time to let mesh form and peers exchange info

async function main() {
  const node = new MagicNode({
    listenPort: 0, // random port
    listenAddresses: ['/ip4/0.0.0.0/tcp/0'],
    subscribedTags: [],
    dataDir: `/tmp/leyline-stats-${Date.now()}`,
  });

  await node.start();
  console.log('Connecting to network...');

  // Wait for peers + mesh formation
  try {
    await node.waitForPeers(1, WAIT_MS);
  } catch {
    // proceed with whatever we got
  }
  // Extra settle time for gossipsub topic propagation
  await new Promise((r) => setTimeout(r, 3000));

  // --- Gather data ---
  const gs = ((node as any).libp2p!.services as Record<string, unknown>).pubsub as GossipSub;
  const topics = gs.getTopics();
  const peers = (node as any).libp2p!.getPeers();

  // Unique peers across all topics
  const allSubscribers = new Set<string>();
  const topicRows: Array<{ topic: string; tag: string; subscribers: number }> = [];

  for (const topic of topics.sort()) {
    const subs = gs.getSubscribers(topic);
    subs.forEach((p: { toString(): string }) => allSubscribers.add(p.toString()));
    const tag = topic.startsWith('magic/tag/') ? topic.slice('magic/tag/'.length) : topic;
    topicRows.push({ topic, tag, subscribers: subs.length });
  }

  // Version stats
  const versionStats = node.getVersionStats();

  // Peer exchange known peers
  const peerExchange = node.getPeerExchange();
  const knownPeers = peerExchange?.getPeers() ?? [];

  // --- Print results ---
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║              LEYLINE NETWORK STATS                  ║');
  console.log('╠══════════════════════════════════════════════════════╣');

  // Summary table
  const summary = [
    ['Connected Peers', String(peers.length)],
    ['Known Peers (via exchange)', String(knownPeers.length)],
    ['Unique Bots on Topics', String(allSubscribers.size)],
    ['Active Topics', String(topics.length)],
    ['Node Version', node.getVersion()],
    ['Node Fingerprint', node.getFingerprint()],
  ];

  for (const [label, value] of summary) {
    console.log(`║  ${label.padEnd(28)} ${value.padStart(22)}  ║`);
  }

  // Version distribution
  if (versionStats.size > 0) {
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  VERSION DISTRIBUTION                                ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    for (const [version, count] of [...versionStats.entries()].sort()) {
      const bar = '█'.repeat(Math.min(count * 2, 30));
      console.log(`║  v${version.padEnd(10)} ${String(count).padStart(4)} peers  ${bar.padEnd(28)}  ║`);
    }
  }

  // Topics table
  if (topicRows.length > 0) {
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  ACTIVE TOPICS                                       ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  ${'Tag'.padEnd(34)} ${'Subs'.padStart(16)}  ║`);
    console.log(`║  ${'─'.repeat(34)} ${'─'.repeat(16)}  ║`);
    for (const row of topicRows.sort((a, b) => b.subscribers - a.subscribers)) {
      const tag = row.tag.length > 34 ? row.tag.slice(0, 31) + '...' : row.tag;
      console.log(`║  ${tag.padEnd(34)} ${String(row.subscribers).padStart(16)}  ║`);
    }
  } else {
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  No active topics discovered                         ║');
  }

  // Known peers list
  if (knownPeers.length > 0) {
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  KNOWN PEERS                                         ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    for (const peer of knownPeers.slice(0, 20)) {
      const id = peer.peerId.slice(0, 20) + '...';
      const addr = peer.multiaddrs[0]?.slice(0, 28) ?? 'no addr';
      console.log(`║  ${id.padEnd(24)} ${addr.padEnd(28)} ║`);
    }
    if (knownPeers.length > 20) {
      console.log(`║  ... and ${knownPeers.length - 20} more peers`.padEnd(55) + '║');
    }
  }

  console.log('╚══════════════════════════════════════════════════════╝');

  await node.stop();
  // Clean up temp data dir
  const { rm } = await import('node:fs/promises');
  await rm(`/tmp/leyline-stats-${Date.now()}`, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
