import { Level } from 'level';
import { createHash } from 'node:crypto';
import type { GossipSub } from '@chainsafe/libp2p-gossipsub';
import { MagicNode } from './magic-node.js';
import type { MagicConfig } from '../config/config.js';
import { MessageBuffer } from './message-buffer.js';
import { InboxServer } from './inbox-protocol.js';
import { publicKeyToHex } from '../identity/keypair.js';
import { HealthCheckServer } from './health-check.js';

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
  private ledgerConfirmTimer: ReturnType<typeof setInterval> | null = null;
  private mirroredTopics = new Set<string>();
  private peerDb: Level<string, string> | null = null;
  /** Message buffer for store-and-forward delivery to offline peers. */
  private messageBuffer: MessageBuffer = new MessageBuffer();
  private inboxServer: InboxServer | null = null;
  /** Track which GossipSub topics each peer is subscribed to, for topic-addressed mailbox delivery. */
  private peerSubscriptions = new Map<string, Set<string>>();
  /** Stored event listener references for cleanup in stop(). */
  private messageCaptureHandler: ((evt: CustomEvent) => void) | null = null;
  private topicMirrorHandler: ((evt: CustomEvent) => void) | null = null;
  private subscriptionTrackHandler: ((evt: CustomEvent) => void) | null = null;
  private healthCheck: HealthCheckServer | null = null;

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
    // Provide the subscription tracker so the inbox server can serve
    // topics for peers that just reconnected (before GossipSub propagates)
    this.inboxServer.setSubscriptionTracker((peerId: string) =>
      this.peerSubscriptions.get(peerId) ?? new Set(),
    );
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

    // Track per-peer topic subscriptions for topic-addressed mailbox delivery
    this.startSubscriptionTracking();

    // Seeds actively participate in ledger consensus — confirm pending entries
    // and broadcast confirmed entries to other seeds. This ensures quorum is
    // reached even when the submitting bot disconnects immediately.
    this.startLedgerParticipation();
    console.log('[Seed] Ledger participation active — will auto-confirm entries');

    if (this.config.healthCheckPort > 0) {
      this.healthCheck = new HealthCheckServer(this.config.healthCheckPort, {
        libp2p: this.libp2p!,
        getTopicCount: () => this.mirroredTopics.size,
        getBufferedMessageCount: () => this.messageBuffer.getCount(),
        getKnownPeerCount: () => this.knownPeers.size,
        getLedgerEntryCount: () => this.sharedLedger.getEntryCount(),
      });
      await this.healthCheck.start();
    }
  }

  async stop(): Promise<void> {
    if (this.peerExchangeTimer) {
      clearInterval(this.peerExchangeTimer);
      this.peerExchangeTimer = null;
    }
    if (this.ledgerConfirmTimer) {
      clearInterval(this.ledgerConfirmTimer);
      this.ledgerConfirmTimer = null;
    }

    // Remove GossipSub event listeners to prevent leaks
    if (this.libp2p) {
      const gs = (this.libp2p.services as Record<string, unknown>).pubsub as GossipSub;
      if (this.messageCaptureHandler) {
        gs.removeEventListener('gossipsub:message', this.messageCaptureHandler);
        this.messageCaptureHandler = null;
      }
      if (this.topicMirrorHandler) {
        gs.removeEventListener('subscription-change', this.topicMirrorHandler);
        this.topicMirrorHandler = null;
      }
      if (this.subscriptionTrackHandler) {
        gs.removeEventListener('subscription-change', this.subscriptionTrackHandler);
        this.subscriptionTrackHandler = null;
      }
    }

    await this.healthCheck?.stop();
    this.healthCheck = null;
    this.messageBuffer.stop();
    await this.inboxServer?.stop();
    await this.peerDb?.close();
    this.peerDb = null;
    this.peerSubscriptions.clear();
    this.mirroredTopics.clear();
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

    // LRU eviction: cap at 10,000 known peers to prevent unbounded memory growth
    if (this.knownPeers.size > 10_000) {
      let oldestId: string | undefined;
      let oldestTime = Infinity;
      for (const [id, info] of this.knownPeers) {
        if (info.lastSeen < oldestTime) {
          oldestTime = info.lastSeen;
          oldestId = id;
        }
      }
      if (oldestId) {
        this.knownPeers.delete(oldestId);
        this.deletePeer(oldestId);
      }
    }

    this.persistPeer(peerId, { peerId, multiaddrs: addrs, lastSeen });
    console.log(`[Seed] Peer connected: ${peerId} (total: ${this.knownPeers.size})`);
  }

  private markPeerDisconnected(peerId: string): void {
    const peer = this.knownPeers.get(peerId);
    if (peer) {
      peer.lastSeen = Date.now();
      this.persistPeer(peerId, { peerId, multiaddrs: peer.multiaddrs, lastSeen: peer.lastSeen });
    }
    this.peerSubscriptions.delete(peerId);
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

    this.messageCaptureHandler = (evt: CustomEvent) => {
      const { msg } = evt.detail;
      const topic = msg.topic as string;
      const data = msg.data as Uint8Array;

      // Skip internal seed topics (peer exchange, discovery) — only buffer application messages
      if (topic === 'magic/discovery') return;

      // Generate a dedup ID from the message content
      const id = createHash('sha256').update(data).digest('hex');

      const stored = buffer.push(topic, data, id);
      if (stored) {
        const count = buffer.getCount();
        if (count === 1 || count % 100 === 0) {
          console.log(`[Seed] Message buffer: ${count} messages across ${buffer.getBufferedTopics().length} topics`);
        }
      }
    };
    gs.addEventListener('gossipsub:message', this.messageCaptureHandler);
  }

  private startPeerExchange(): void {
    // Broadcast known peers every 30 seconds + log version stats
    this.peerExchangeTimer = setInterval(() => {
      this.pruneStale();

      // Log version distribution every cycle
      const stats = this.getVersionStats();
      if (stats.size > 0) {
        const parts: string[] = [];
        for (const [version, count] of stats) {
          parts.push(`v${version}: ${count}`);
        }
        console.log(`[Seed] Version stats: ${parts.join(' | ')} (${this.getPeerCount()} peers)`);
      }

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

    this.topicMirrorHandler = (evt: CustomEvent) => {
      const { subscriptions } = evt.detail;
      if (!Array.isArray(subscriptions)) return;

      for (const sub of subscriptions) {
        const topic = (sub as { topic: string; subscribe: boolean }).topic;
        const subscribing = (sub as { topic: string; subscribe: boolean }).subscribe;

        if (subscribing && !this.mirroredTopics.has(topic)) {
          if (this.mirroredTopics.size >= 500) {
            console.warn(`[Seed] Topic mirror cap reached (500) — ignoring: ${topic}`);
            continue;
          }
          gs.subscribe(topic);
          this.mirroredTopics.add(topic);
          console.log(`[Seed] Mirroring topic: ${topic} (${this.mirroredTopics.size} total)`);
        }
      }
    };
    gs.addEventListener('subscription-change', this.topicMirrorHandler);

    console.log('[Seed] Topic mirroring active — will relay all peer topics');
  }

  /**
   * Track which GossipSub topics each peer subscribes to.
   * Used by the inbox server to deliver topic-addressed messages
   * to the right peers when they reconnect.
   */
  private startSubscriptionTracking(): void {
    if (!this.libp2p) return;

    const gs = (this.libp2p.services as Record<string, unknown>).pubsub as GossipSub;

    this.subscriptionTrackHandler = (evt: CustomEvent) => {
      const { peerId, subscriptions } = evt.detail;
      const peerIdStr = peerId?.toString();
      if (!peerIdStr || !Array.isArray(subscriptions)) return;

      let subs = this.peerSubscriptions.get(peerIdStr);
      if (!subs) {
        subs = new Set();
        this.peerSubscriptions.set(peerIdStr, subs);
      }

      for (const sub of subscriptions) {
        const topic = (sub as { topic: string; subscribe: boolean }).topic;
        const subscribing = (sub as { topic: string; subscribe: boolean }).subscribe;
        if (subscribing) {
          subs.add(topic);
        } else {
          subs.delete(topic);
        }
      }
    };
    gs.addEventListener('subscription-change', this.subscriptionTrackHandler);
  }

  /**
   * Seeds actively participate in ledger consensus:
   *
   * 1. Periodically check for pending consensus proposals and add the
   *    seed's own confirmation. Since there are 4 seeds and quorum is 2,
   *    a single seed confirmation + the submitter's confirmation = quorum.
   *
   * 2. When an entry is confirmed, immediately broadcast it to all
   *    connected peers (other seeds + any online bots) so the confirmed
   *    entry propagates quickly.
   *
   * This means a bot can submit a ledger entry, disconnect immediately,
   * and the seeds will carry the entry to quorum without the bot needing
   * to stay online.
   */
  private startLedgerParticipation(): void {
    const localPubkeyHex = publicKeyToHex(this.publicKey);
    const consensus = this.ledgerConsensus;
    const ledgerSync = this.ledgerSync;
    const sharedLedger = this.sharedLedger;

    // Every 5 seconds, check for pending proposals and confirm them
    this.ledgerConfirmTimer = setInterval(async () => {
      try {
        const pending = consensus.getPendingProposals();
        if (pending.length === 0) return;

        for (const proposal of pending) {
          // Add our own confirmation
          const reached = consensus.addConfirmation(proposal.hash, localPubkeyHex);

          if (reached) {
            // Quorum reached — commit to the shared ledger
            const committed = consensus.getProposal(proposal.hash);
            if (committed) {
              await sharedLedger.submit(
                committed.data,
                committed.submitterPubkey,
                committed.signature,
              );

              const count = await sharedLedger.getEntryCount();
              console.log(`[Seed] Ledger: confirmed entry (${count} total)`);

              // Immediately broadcast the confirmed entry to all peers
              if (ledgerSync) {
                const entry = await sharedLedger.getLatest();
                if (entry) {
                  await ledgerSync.broadcastEntry(entry);
                  console.log(`[Seed] Ledger: broadcast confirmed entry to peers`);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[Seed] Ledger participation error:', err);
      }
    }, 5_000);
  }

  /** Get the topic subscriptions for a specific peer (for inbox authorization). */
  getPeerSubscriptions(peerId: string): Set<string> {
    return this.peerSubscriptions.get(peerId) ?? new Set();
  }
}
