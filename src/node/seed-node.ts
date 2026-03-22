import { MagicNode } from './magic-node.js';
import type { MagicConfig } from '../config/config.js';

/**
 * Seed node specialization.
 * Seed nodes exist solely for peer discovery — they help new nodes
 * find other peers on the network. They do not process application messages.
 *
 * Like Bitcoin seed nodes, they are operator-run bootstrap points.
 */
export class SeedNode extends MagicNode {
  private knownPeers = new Map<string, { multiaddrs: string[]; lastSeen: number }>();

  constructor(config: Partial<MagicConfig>) {
    super(
      {
        ...config,
        isSeedNode: true,
        // Seed nodes subscribe to discovery only
        subscribedTags: [],
      },
      {
        onPeerConnected: (peerId) => this.trackPeer(peerId),
        onPeerDisconnected: (peerId) => this.markPeerDisconnected(peerId),
      },
    );
  }

  async start(): Promise<void> {
    await super.start();
    console.log('[Magic] Running as SEED NODE — peer discovery only');

    // Periodically broadcast known peer list
    this.startPeerExchange();
  }

  private trackPeer(peerId: string): void {
    const addrs = this.getMultiaddrs();
    this.knownPeers.set(peerId, {
      multiaddrs: addrs,
      lastSeen: Date.now(),
    });
    console.log(`[Seed] Peer connected: ${peerId} (total: ${this.knownPeers.size})`);
  }

  private markPeerDisconnected(peerId: string): void {
    // Keep in known peers but update last seen
    const peer = this.knownPeers.get(peerId);
    if (peer) {
      peer.lastSeen = Date.now();
    }
    console.log(`[Seed] Peer disconnected: ${peerId}`);
  }

  /** Get all known peers and their addresses. */
  getKnownPeers(): Array<{ peerId: string; multiaddrs: string[]; lastSeen: number }> {
    return Array.from(this.knownPeers.entries()).map(([peerId, info]) => ({
      peerId,
      ...info,
    }));
  }

  /** Get count of currently connected peers. */
  getConnectedPeerCount(): number {
    return this.getPeerCount();
  }

  /** Remove peers not seen in the given duration (ms). */
  pruneStale(maxAge: number = 30 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    let pruned = 0;
    for (const [peerId, info] of this.knownPeers) {
      if (info.lastSeen < cutoff) {
        this.knownPeers.delete(peerId);
        pruned++;
      }
    }
    if (pruned > 0) {
      console.log(`[Seed] Pruned ${pruned} stale peers`);
    }
    return pruned;
  }

  private startPeerExchange(): void {
    // Broadcast known peers every 30 seconds
    setInterval(() => {
      this.pruneStale();

      const peerList = this.getKnownPeers();
      if (peerList.length > 0) {
        const data = new TextEncoder().encode(JSON.stringify(peerList));
        this.tagPubSub?.publishDiscovery(data).catch(() => {
          // Swallow publish errors on seed node
        });
      }
    }, 30_000);
  }
}
