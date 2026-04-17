import { Level } from 'level';
import { createHash } from 'node:crypto';
import type { GossipSub } from '@chainsafe/libp2p-gossipsub';
import { MagicNode } from './magic-node.js';
import type { MagicConfig } from '../config/config.js';
import { MessageBuffer } from './message-buffer.js';
import { InboxServer } from './inbox-protocol.js';
import { publicKeyToHex, verify } from '../identity/keypair.js';
import { HealthCheckServer } from './health-check.js';
import { Logger } from '../utils/logger.js';

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
  /** Per-submitter rate limiting for ledger entries: pubkeyHex → timestamps */
  private ledgerSubmitTimestamps = new Map<string, number[]>();
  /** Max ledger submissions per submitter per window */
  private static readonly LEDGER_RATE_LIMIT = 10;
  private static readonly LEDGER_RATE_WINDOW_MS = 60_000;
  private static readonly MAX_LEDGER_RATE_ENTRIES = 5_000;
  private ledgerRateLimitCallCount = 0;

  private readonly seedLog: Logger;

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
    this.seedLog = new Logger('SeedNode');
    this.log = new Logger('SeedNode');
  }

  async start(): Promise<void> {
    await super.start();
    this.seedLog.info('Running as SEED NODE — peer discovery only');

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
      this.seedLog.info('Restored persisted peers', { count: this.knownPeers.size });
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
    this.seedLog.info('Inbox server active — buffering messages for offline peers');

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
    this.seedLog.info('Ledger participation active — will auto-confirm entries');

    if (this.config.healthCheckPort > 0) {
      this.healthCheck = new HealthCheckServer(this.config.healthCheckPort, {
        libp2p: this.libp2p!,
        getTopicCount: () => this.mirroredTopics.size,
        getBufferedMessageCount: () => this.messageBuffer.getCount(),
        getKnownPeerCount: () => this.knownPeers.size,
        getLedgerEntryCount: () => this.sharedLedger.getEntryCount(),
        getMetrics: () => this.metrics.allCounters(),
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
    if (this.libp2p) {
      const gs = (this.libp2p.services as Record<string, unknown>).pubsub as GossipSub;
      for (const topic of this.mirroredTopics) {
        try { gs.unsubscribe(topic); } catch { /* already torn down */ }
      }
    }
    this.mirroredTopics.clear();
    this.ledgerSubmitTimestamps.clear();
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
    this.seedLog.info('Peer connected', { peerId, total: this.knownPeers.size });
  }

  private markPeerDisconnected(peerId: string): void {
    const peer = this.knownPeers.get(peerId);
    if (peer) {
      peer.lastSeen = Date.now();
      this.persistPeer(peerId, { peerId, multiaddrs: peer.multiaddrs, lastSeen: peer.lastSeen });
    }
    this.peerSubscriptions.delete(peerId);
    this.seedLog.info('Peer disconnected', { peerId });
  }

  private persistPeer(peerId: string, data: StoredPeer): void {
    this.peerDb?.put(`peer:${peerId}`, JSON.stringify(data)).catch((err) => {
      this.seedLog.error('Failed to persist peer', { peerId, error: String(err) });
    });
  }

  private deletePeer(peerId: string): void {
    this.peerDb?.del(`peer:${peerId}`).catch((err) => {
      this.seedLog.error('Failed to delete peer', { peerId, error: String(err) });
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
      this.seedLog.info('Pruned stale peers', { count: pruned });
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
          this.seedLog.info('Message buffer status', { count, topics: buffer.getBufferedTopics().length });
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
        this.seedLog.info('Version stats', { versions: Object.fromEntries(stats), peers: this.getPeerCount() });
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
            this.seedLog.warn('Topic mirror cap reached (500)', { topic });
            continue;
          }
          gs.subscribe(topic);
          this.mirroredTopics.add(topic);
          this.seedLog.info('Mirroring topic', { topic, total: this.mirroredTopics.size });
        }
      }
    };
    gs.addEventListener('subscription-change', this.topicMirrorHandler);

    this.seedLog.info('Topic mirroring active — will relay all peer topics');
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
          // Verify submitter signature before confirming
          let sigValid = false;
          try {
            sigValid = await verify(
              proposal.submitterPubkey,
              proposal.signature,
              proposal.data,
            );
          } catch {
            // Malformed key or signature
          }
          if (!sigValid) {
            consensus.reject(proposal.hash);
            this.seedLog.warn('Rejected proposal with invalid submitter signature');
            continue;
          }

          // Per-submitter rate limiting
          const submitterHex = publicKeyToHex(proposal.submitterPubkey);
          if (!this.checkLedgerRateLimit(submitterHex)) {
            consensus.reject(proposal.hash);
            this.seedLog.warn('Rate-limited ledger submission', { submitter: submitterHex.slice(0, 16) });
            continue;
          }

          const reached = consensus.addConfirmation(proposal.hash, localPubkeyHex);

          if (reached) {
            const committed = consensus.getProposal(proposal.hash);
            if (committed) {
              await sharedLedger.submit(
                committed.data,
                committed.submitterPubkey,
                committed.signature,
              );

              const count = await sharedLedger.getEntryCount();
              this.seedLog.info('Ledger: confirmed entry', { total: count });

              if (ledgerSync) {
                const entry = await sharedLedger.getLatest();
                if (entry) {
                  await ledgerSync.broadcastEntry(entry);
                  this.seedLog.info('Ledger: broadcast confirmed entry to peers');
                }
              }
            }
          }
        }
      } catch (err) {
        this.seedLog.error('Ledger participation error', { error: (err as Error)?.message ?? String(err) });
      }
    }, 5_000);
  }

  private checkLedgerRateLimit(submitterHex: string): boolean {
    const now = Date.now();
    const cutoff = now - SeedNode.LEDGER_RATE_WINDOW_MS;
    let timestamps = this.ledgerSubmitTimestamps.get(submitterHex);
    if (!timestamps) {
      timestamps = [];
      this.ledgerSubmitTimestamps.set(submitterHex, timestamps);
    }
    // Prune old entries
    const firstValid = timestamps.findIndex(t => t > cutoff);
    if (firstValid > 0) timestamps.splice(0, firstValid);
    else if (firstValid === -1) timestamps.length = 0;

    if (timestamps.length >= SeedNode.LEDGER_RATE_LIMIT) return false;
    timestamps.push(now);

    this.ledgerRateLimitCallCount++;
    if (this.ledgerRateLimitCallCount >= 500) {
      this.ledgerRateLimitCallCount = 0;
      for (const [key, ts] of this.ledgerSubmitTimestamps) {
        if (ts.length === 0 || ts[ts.length - 1]! <= cutoff) {
          this.ledgerSubmitTimestamps.delete(key);
        }
      }
      if (this.ledgerSubmitTimestamps.size > SeedNode.MAX_LEDGER_RATE_ENTRIES) {
        const excess = this.ledgerSubmitTimestamps.size - SeedNode.MAX_LEDGER_RATE_ENTRIES;
        let removed = 0;
        for (const key of this.ledgerSubmitTimestamps.keys()) {
          if (removed >= excess) break;
          this.ledgerSubmitTimestamps.delete(key);
          removed++;
        }
      }
    }

    return true;
  }

  /** Get the topic subscriptions for a specific peer (for inbox authorization). */
  getPeerSubscriptions(peerId: string): Set<string> {
    return this.peerSubscriptions.get(peerId) ?? new Set();
  }
}
