import { Level } from 'level';
import type { GossipSub } from '@chainsafe/libp2p-gossipsub';
import { MagicNode } from './magic-node.js';
import type { MagicConfig } from '../config/config.js';

interface StoredPeer {
  peerId: string;
  multiaddrs: string[];
  lastSeen: number;
}

/**
 * Seed node specialization.
 * Seed nodes exist solely for peer discovery — they help new nodes
 * find other peers on the network. They do not process application messages.
 *
 * Like Bitcoin seed nodes, they are operator-run bootstrap points.
 */
export class SeedNode extends MagicNode {
  private knownPeers = new Map<string, { multiaddrs: string[]; lastSeen: number }>();
  private peerExchangeTimer: ReturnType<typeof setInterval> | null = null;
  private topicMirrorTimer: ReturnType<typeof setInterval> | null = null;
  private mirroredTopics = new Set<string>();
  private peerDb: Level<string, string> | null = null;

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

    // Open persistent peer store and hydrate in-memory map
    this.peerDb = new Level(`${this.config.dataDir}/seed-peers`, { valueEncoding: 'utf8' });
    await this.peerDb.open();
    for await (const [key, raw] of this.peerDb.iterator({ gt: 'peer:', lt: 'peer:~' })) {
      const peerId = key.slice('peer:'.length);
      const stored: StoredPeer = JSON.parse(raw);
      this.knownPeers.set(peerId, {
        multiaddrs: stored.multiaddrs,
        lastSeen: stored.lastSeen,
      });
    }
    if (this.knownPeers.size > 0) {
      console.log(`[Seed] Restored ${this.knownPeers.size} persisted peer(s)`);
    }

    // Periodically broadcast known peer list
    this.startPeerExchange();

    // Topic mirroring: seed nodes subscribe to any topic their peers use
    // so they can relay GossipSub messages between bots that aren't directly connected.
    // Without this, messages have no relay path through seeds.
    this.startTopicMirroring();
  }

  async stop(): Promise<void> {
    if (this.peerExchangeTimer) {
      clearInterval(this.peerExchangeTimer);
      this.peerExchangeTimer = null;
    }
    if (this.topicMirrorTimer) {
      clearInterval(this.topicMirrorTimer);
      this.topicMirrorTimer = null;
    }
    await this.peerDb?.close();
    this.peerDb = null;
    await super.stop();
  }

  private trackPeer(peerId: string): void {
    const lastSeen = Date.now();

    // Look up the connecting peer's multiaddrs from the libp2p peer store
    let addrs: string[] = [];
    if (this.libp2p) {
      const peerIdObj = this.libp2p.getPeers().find((p) => p.toString() === peerId);
      if (peerIdObj) {
        const conns = this.libp2p.getConnections(peerIdObj);
        addrs = conns.map((c) => c.remoteAddr.toString());
      }
    }

    this.knownPeers.set(peerId, { multiaddrs: addrs, lastSeen });
    this.persistPeer(peerId, { peerId, multiaddrs: addrs, lastSeen });
    console.log(`[Seed] Peer connected: ${peerId} (total: ${this.knownPeers.size})`);
  }

  private markPeerDisconnected(peerId: string): void {
    // Keep in known peers but update last seen
    const peer = this.knownPeers.get(peerId);
    if (peer) {
      peer.lastSeen = Date.now();
      this.persistPeer(peerId, { peerId, multiaddrs: peer.multiaddrs, lastSeen: peer.lastSeen });
    }
    console.log(`[Seed] Peer disconnected: ${peerId}`);
  }

  private persistPeer(peerId: string, data: StoredPeer): void {
    this.peerDb?.put(`peer:${peerId}`, JSON.stringify(data)).catch((err) => {
      console.error(`[Seed] Failed to persist peer ${peerId}:`, err);
    });
  }

  private deletePeer(peerId: string): void {
    this.peerDb?.del(`peer:${peerId}`).catch((err) => {
      console.error(`[Seed] Failed to delete peer ${peerId}:`, err);
    });
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
        this.deletePeer(peerId);
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
    this.peerExchangeTimer = setInterval(() => {
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

  /**
   * Topic mirroring: periodically check what GossipSub topics exist in the
   * mesh and subscribe to any we haven't seen yet. This ensures seed nodes
   * relay messages between bots that aren't directly connected.
   *
   * Without this, two bots both connected to seeds but not to each other
   * can't communicate — the seeds aren't subscribed to their topics, so
   * GossipSub has no relay path.
   */
  private startTopicMirroring(): void {
    if (!this.libp2p) return;

    const gs = (this.libp2p.services as Record<string, unknown>).pubsub as GossipSub;

    // Check every 2 seconds for new topics from peers
    this.topicMirrorTimer = setInterval(() => {
      // Get all topics that any of our peers are subscribed to
      const peerTopics = new Set<string>();
      for (const topic of gs.getTopics()) {
        const subscribers = gs.getSubscribers(topic);
        if (subscribers.length > 0) {
          peerTopics.add(topic);
        }
      }

      // Subscribe to any topic we haven't mirrored yet
      for (const topic of peerTopics) {
        if (!this.mirroredTopics.has(topic)) {
          gs.subscribe(topic);
          this.mirroredTopics.add(topic);
          console.log(`[Seed] Mirroring topic: ${topic} (${this.mirroredTopics.size} total)`);
        }
      }
    }, 2_000);
  }
}
