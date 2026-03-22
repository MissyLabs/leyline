import { Level } from 'level';
import { createHash } from 'node:crypto';
import type { GossipSub } from '@chainsafe/libp2p-gossipsub';
import { MagicNode } from './magic-node.js';
import type { MagicConfig } from '../config/config.js';
import { MessageBuffer } from './message-buffer.js';
import { InboxServer } from './inbox-protocol.js';

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
  private mirroredTopics = new Set<string>();
  private peerDb: Level<string, string> | null = null;
  /** Message buffer for store-and-forward delivery to offline peers. */
  private messageBuffer: MessageBuffer = new MessageBuffer();
  private inboxServer: InboxServer | null = null;

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

    // Start message buffer for store-and-forward
    this.messageBuffer.start();

    // Start inbox server so reconnecting peers can fetch missed messages
    this.inboxServer = new InboxServer(this.libp2p!, this.messageBuffer);
    await this.inboxServer.start();
    console.log(`[Seed] Inbox server active — buffering messages for offline peers`);

    // Buffer all incoming GossipSub messages for store-and-forward
    this.startMessageCapture();

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
    this.messageBuffer.stop();
    await this.inboxServer?.stop();
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

  /**
   * Capture all incoming GossipSub messages into the buffer for
   * store-and-forward delivery to reconnecting peers.
   */
  private startMessageCapture(): void {
    if (!this.libp2p) return;

    const gs = (this.libp2p.services as Record<string, unknown>).pubsub as GossipSub;
    const buffer = this.messageBuffer;

    gs.addEventListener('gossipsub:message', (evt: CustomEvent) => {
      const { msg } = evt.detail;
      const topic = msg.topic as string;
      const data = msg.data as Uint8Array;

      // Generate a dedup ID from the message content
      const id = createHash('sha256').update(data).digest('hex');

      const stored = buffer.push(topic, data, id);
      if (stored) {
        // Log occasionally, not every message
        const count = buffer.getCount();
        if (count === 1 || count % 100 === 0) {
          console.log(`[Seed] Message buffer: ${count} messages across ${buffer.getBufferedTopics().length} topics`);
        }
      }
    });
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
   * Topic mirroring: when a peer subscribes to a GossipSub topic, the seed
   * automatically subscribes too so it can relay messages between bots that
   * aren't directly connected.
   *
   * Uses the 'subscription-change' event which fires whenever a connected
   * peer changes their topic subscriptions, giving us real-time visibility
   * into what topics the network needs relayed.
   */
  private startTopicMirroring(): void {
    if (!this.libp2p) return;

    const gs = (this.libp2p.services as Record<string, unknown>).pubsub as GossipSub;

    // Listen for peer subscription changes in real-time
    gs.addEventListener('subscription-change', (evt: CustomEvent) => {
      const { subscriptions } = evt.detail;
      if (!Array.isArray(subscriptions)) return;

      for (const sub of subscriptions) {
        // sub has { topic: string, subscribe: boolean }
        const topic = (sub as { topic: string; subscribe: boolean }).topic;
        const subscribing = (sub as { topic: string; subscribe: boolean }).subscribe;

        if (subscribing && !this.mirroredTopics.has(topic)) {
          gs.subscribe(topic);
          this.mirroredTopics.add(topic);
          console.log(`[Seed] Mirroring topic: ${topic} (${this.mirroredTopics.size} total)`);
        }
      }
    });

    console.log('[Seed] Topic mirroring active — will relay all peer topics');
  }
}
