import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub, type GossipSub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';

import { type MagicConfig, mergeConfig } from '../config/config.js';
import { TagPubSub } from '../pubsub/tag-pubsub.js';
import { TrustPolicy, SpamFilter } from '../trust/policy.js';
import { LocalLedger } from '../ledger/local-log.js';
import { SharedLedger } from '../ledger/shared-ledger.js';
import { LedgerSync } from '../ledger/ledger-sync.js';
import { PeerExchange } from './peer-exchange.js';
import { InboxClient } from './inbox-protocol.js';
import { HandshakeProtocol } from './handshake-protocol.js';
import { LEYLINE_VERSION } from '../config/compat.js';
import { DirectMessageProtocol, type DirectEnvelope, type DirectMessageTrustChecker } from './direct-message.js';
import { ServiceRegistry, type ServiceDescriptor } from '../discovery/service-registry.js';
import { DiscoveryProtocol } from '../discovery/discovery-protocol.js';
import { PersistentTrustPolicy, PersistentSpamFilter } from '../trust/persistent-policy.js';
import { PeerReputation } from '../trust/peer-reputation.js';
import { LedgerConsensus } from '../ledger/consensus.js';
import {
  type MagicMessage,
  MessageType,
  createMessage,
  serializeMessage,
  deserializeMessage,
  validateMessage,
  verifyMessageSignature,
} from '../messages/message.js';
import { initProto } from '../messages/proto.js';
import {
  publicKeyToHex,
  getFingerprint,
} from '../identity/keypair.js';
import { IdentityStore } from '../identity/store.js';
import { NodeMetrics } from '../utils/metrics.js';
import { Logger } from '../utils/logger.js';
import { PartitionDetector, type PartitionEvent } from '../utils/partition-detector.js';
import { PriorityQueue, MessagePriority } from '../utils/priority-queue.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { InboundBudget } from '../utils/inbound-budget.js';
import { jitteredPeriod } from '../utils/jitter.js';
import { isPrivateMultiaddr, extractSeedPeerId } from '../utils/addr-filter.js';

export interface MagicNodeEvents {
  onMessage?: (msg: MagicMessage, tag: string) => void;
  onDirectMessage?: (envelope: DirectEnvelope) => void;
  onPeerConnected?: (peerId: string) => void;
  onPeerDisconnected?: (peerId: string) => void;
  onSeedConnectivityChange?: (connectedSeeds: number, totalSeeds: number) => void;
  onDegraded?: (reason: string) => void;
  onRecovered?: () => void;
  onPartition?: (event: PartitionEvent) => void;
}

export interface NodeStatus {
  running: boolean;
  degraded: boolean;
  peerId: string;
  fingerprint: string;
  peerCount: number;
  connectedSeeds: number;
  totalSeeds: number;
  subscribedTags: string[];
  openTags: string[];
  localServices: number;
  remoteServices: number;
  ledgerEntries: number;
  paused: boolean;
  uptime: number;
  version: string;
  circuitBreakerOpen: number;
}

export class MagicNode {
  protected config: MagicConfig;
  protected libp2p: Libp2p | null = null;
  protected tagPubSub: TagPubSub | null = null;
  protected trustPolicy: PersistentTrustPolicy;
  protected spamFilter: PersistentSpamFilter;
  protected localLedger: LocalLedger;
  protected sharedLedger: SharedLedger;
  protected peerExchange: PeerExchange | null = null;
  protected ledgerSync: LedgerSync | null = null;
  protected directMessage: DirectMessageProtocol | null = null;
  protected serviceRegistry: ServiceRegistry;
  protected discoveryProtocol: DiscoveryProtocol | null = null;
  protected inboxClient: InboxClient | null = null;
  protected handshake: HandshakeProtocol | null = null;
  protected ledgerConsensus: LedgerConsensus;
  protected peerReputation: PeerReputation;
  protected metrics: NodeMetrics;
  protected partitionDetector: PartitionDetector;
  protected log: Logger;
  protected publicKey: Uint8Array = new Uint8Array(0);
  protected privateKey: Uint8Array = new Uint8Array(0);
  protected events: MagicNodeEvents;
  private gossipHandler: ((evt: CustomEvent) => void) | null = null;
  private subscriptionChangeHandler: ((evt: CustomEvent) => void) | null = null;
  private peerConnectHandler: ((evt: CustomEvent) => void) | null = null;
  private peerDisconnectHandler: ((evt: CustomEvent) => void) | null = null;
  /** Serialization lock for submitToSharedLedger to prevent concurrent submit races. */
  private ledgerSubmitLock: Promise<void> = Promise.resolve();
  /** Timer for periodic service re-advertisement. */
  private reAdvertiseTimer: ReturnType<typeof setInterval> | null = null;
  /** Timer for periodic inbox polling (fallback receive for NATted nodes). */
  private inboxPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracked per-peer setTimeout handles for cleanup on stop(). */
  private pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
  /** Whether the node is in the process of stopping. */
  private stopping = false;
  /** AbortController for cancelling in-flight operations on shutdown. */
  protected shutdownController = new AbortController();
  /** Timer for periodic seed connectivity monitoring. */
  private seedMonitorTimer: ReturnType<typeof setInterval> | null = null;
  /** Whether the node is currently in degraded mode (no seeds reachable). */
  private degraded = false;
  /** Parsed seed PeerIds for connectivity tracking. */
  private seedPeerIds = new Set<string>();
  /**
   * PeerIds extracted from the configured seed multiaddrs (DC-1). Matching a
   * connection's `remotePeer` against these is DNS/IP-agnostic, unlike the old
   * host-substring match which never fired for resolved `/dns4/...` seeds.
   */
  private configuredSeedPeerIds = new Set<string>();
  /** Circuit breaker for outbound peer dials — prevents hammering unreachable peers. */
  protected circuitBreaker = new CircuitBreaker();
  /** Epoch ms when start() completed, for uptime reporting (DC-2). */
  private startedAt = 0;
  /** Recent degraded/recovered/partition events for the health dashboard (FEAT-3), newest first. */
  private recentEvents: string[] = [];

  // --- Unified inbound cost governor (token burn protection, FEAT-2) ---
  /** Shared budget applied across GossipSub, direct-message, and inbox paths. */
  protected inboundBudget!: InboundBudget;
  /** Optional queued (sequential) direct-message handler push fn. */
  private dmQueuedPush: ((envelope: DirectEnvelope) => void) | null = null;
  /** When true, all inbound message delivery is paused (messages are silently dropped). */
  private paused = false;

  // --- Per-tag rate limiting ---
  /**
   * Sliding-window timestamps keyed by tag then by sender pubkeyHex.
   * Only populated when `config.tagRateLimits` is non-empty.
   * Layout: tag → (senderHex → timestamps[])
   */
  private tagRateWindows = new Map<string, Map<string, number[]>>();

  constructor(config: Partial<MagicConfig>, events: MagicNodeEvents = {}) {
    this.config = mergeConfig(config);
    this.trustPolicy = new PersistentTrustPolicy(`${this.config.dataDir}/trust`);
    this.spamFilter = new PersistentSpamFilter(`${this.config.dataDir}/spam`, this.config.maxSeenMessages);
    this.localLedger = new LocalLedger(`${this.config.dataDir}/local-ledger`);
    this.sharedLedger = new SharedLedger(`${this.config.dataDir}/shared-ledger`);
    this.serviceRegistry = new ServiceRegistry();
    this.ledgerConsensus = new LedgerConsensus();
    this.peerReputation = new PeerReputation();
    this.metrics = new NodeMetrics();
    this.partitionDetector = new PartitionDetector();
    this.log = new Logger('MagicNode');
    this.events = events;

    // Unified inbound cost governor shared across all delivery paths (FEAT-2).
    this.inboundBudget = new InboundBudget(
      {
        maxInboundPerMinute: this.config.maxInboundPerMinute,
        maxPayloadBytesPerMinute: this.config.maxPayloadBytesPerMinute,
      },
      (reason) => {
        this.metrics.increment('budget.shed', 1, { reason });
      },
    );

    // Pre-parse configured seed PeerIds for DNS-agnostic connectivity tracking (DC-1).
    for (const seed of this.config.seedNodes) {
      const pid = extractSeedPeerId(seed);
      if (pid) this.configuredSeedPeerIds.add(pid);
    }

    this.partitionDetector.on('partition', (event: PartitionEvent) => {
      this.recordEvent(`${event.type}: ${event.reason}`);
      this.events.onPartition?.(event);
    });
  }

  async start(): Promise<void> {
    // Initialize protobuf schema
    await initProto();

    // Load persistent identity (generates and saves one on first start)
    const identityStore = new IdentityStore(this.config.dataDir);
    const keypair = await identityStore.load();
    this.publicKey = keypair.publicKey;
    this.privateKey = keypair.privateKey;

    // Derive libp2p Ed25519 key from our stored seed so PeerId is stable across restarts
    const privKey = await generateKeyPairFromSeed('Ed25519', this.privateKey);

    // Build transports conditionally based on config
    const transports: unknown[] = [tcp()];
    if (this.config.enableWebSocket) transports.push(webSockets());
    if (this.config.enableRelay) transports.push(circuitRelayTransport());

    // Build listen addresses: always include TCP, add WS address only when enabled
    const listenAddresses = this.config.enableWebSocket
      ? this.config.listenAddresses
      : this.config.listenAddresses.filter((addr) => !addr.endsWith('/ws'));

    // Build services object; seed nodes also run a circuit relay server
    const services: Record<string, unknown> = {
      identify: identify(),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        fallbackToFloodsub: true,
        // floodPublish sends messages to ALL connected peers, not just mesh peers.
        // This is critical for NATted nodes that can dial out to seeds but can't
        // receive inbound mesh connections. Without this, GossipSub only sends
        // to mesh peers, and mesh formation requires bidirectional reachability.
        floodPublish: true,
      }),
      dcutr: dcutr(),
    };
    if (this.config.isSeedNode) services.relay = circuitRelayServer();

    // Filter out non-routable addresses from announcements.
    // Nodes behind NAT advertise private IPs (10.x, 172.16-31.x, 192.168.x)
    // which other peers can't reach. This wastes dial attempts and breaks
    // GossipSub mesh formation.
    const announceFilter = (addrs: Array<{ toString(): string }>) =>
      addrs.filter((ma) => !isPrivateMultiaddr(ma.toString()));

    // Build libp2p config
    const libp2pOptions: Record<string, unknown> = {
      privateKey: privKey,
      addresses: {
        listen: listenAddresses,
        announceFilter,
      },
      transports,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services,
      ...(this.config.maxConnections > 0 ? {
        connectionManager: {
          maxConnections: this.config.maxConnections,
        },
      } : {}),
      ...(() => {
        const discoveryModules: unknown[] = [];
        if (this.config.seedNodes.length > 0) {
          discoveryModules.push(bootstrap({ list: this.config.seedNodes }));
        }
        if (this.config.enableMdns) {
          discoveryModules.push(mdns());
        }
        return discoveryModules.length > 0
          ? { peerDiscovery: discoveryModules }
          : {};
      })(),
    };

    this.libp2p = await createLibp2p(libp2pOptions as Parameters<typeof createLibp2p>[0]);

    // A seed's own multiaddr is in the default seed list; drop our own PeerId from
    // the configured-seed set so self is never counted as a reachable seed (SCH-1/DC-1).
    this.configuredSeedPeerIds.delete(this.libp2p.peerId.toString());

    // Start version handshake protocol
    this.handshake = new HandshakeProtocol(this.libp2p, {
      onPeerVersion: (peerId, version, result) => {
        if (!result.compatible) {
          this.log.warn(`Incompatible peer — messages will be rejected`, { peerId: peerId.slice(0, 16), version });
        }
      },
    }, this.shutdownController.signal);
    await this.handshake.start();

    // Set up tag-based pub/sub
    const gs = (this.libp2p.services as Record<string, unknown>).pubsub as GossipSub;
    this.tagPubSub = new TagPubSub(gs);

    // Subscribe to configured tags
    for (const tag of this.config.subscribedTags) {
      this.tagPubSub.subscribe(tag);
    }

    // Subscribe to discovery
    this.tagPubSub.subscribeDiscovery();

    // Handle incoming messages (store handler for cleanup in stop())
    this.gossipHandler = (evt: CustomEvent) => {
      const { msg } = evt.detail;
      if (this.handshake && msg.from && this.handshake.isIncompatible(msg.from.toString())) {
        return; // Drop messages from incompatible peers
      }
      this.handleIncomingMessage(msg.topic, msg.data).catch((err) => {
        this.log.warn('Error handling incoming message', { error: (err as Error)?.message ?? String(err) });
      });
    };
    gs.addEventListener('gossipsub:message', this.gossipHandler);

    // Auto-subscribe new topics matching wildcard patterns
    this.subscriptionChangeHandler = (evt: CustomEvent) => {
      const { subscriptions } = evt.detail;
      if (Array.isArray(subscriptions) && this.tagPubSub) {
        for (const sub of subscriptions) {
          if (sub.subscribe && typeof sub.topic === 'string') {
            this.tagPubSub.checkAndSubscribeNewTopic(sub.topic);
          }
        }
      }
    };
    gs.addEventListener('subscription-change', this.subscriptionChangeHandler);

    // Initialize inbox client for store-and-forward message retrieval
    this.inboxClient = new InboxClient(this.libp2p, this.shutdownController.signal);

    // Track peer connections — auto-fetch missed messages from seeds on connect
    this.peerConnectHandler = (evt: CustomEvent) => {
      const peerId = evt.detail.toString();

      // Track seed PeerIds by matching the connected peer against the configured
      // seed PeerIds (DC-1). This is DNS/IP-agnostic — the old host-substring
      // match never fired for resolved /dns4 seeds, so connectedSeeds read 0/N.
      if (this.configuredSeedPeerIds.has(peerId)) {
        this.seedPeerIds.add(peerId);
      }

      this.metrics.increment('peers.connected');
      this.metrics.gauge('peers.current', this.libp2p?.getPeers().length ?? 0);
      this.partitionDetector.updatePeerCount(this.libp2p?.getPeers().length ?? 0);
      this.events.onPeerConnected?.(peerId);

      // When we connect to a peer, try to fetch any messages we missed while offline.
      // Small delay to let the connection stabilize before making protocol requests.
      if (this.inboxClient && this.tagPubSub) {
        const topics = this.tagPubSub.getSubscribedTags().map(
          (tag) => `magic/tag/${tag}`,
        );
        if (topics.length > 0) {
          const timer = setTimeout(() => {
            this.pendingTimeouts.delete(timer);
            if (this.stopping) return; // Node is shutting down
            this.inboxClient?.fetch(peerId, topics).then((messages) => {
              if (messages.length > 0) {
                this.log.info('Inbox: fetched missed messages', { count: messages.length, peer: peerId.slice(0, 16) });
                for (const msg of messages) {
                  this.handleIncomingMessage(msg.topic, msg.data).catch((err) => {
                    this.log.warn('Error handling inbox message', { error: (err as Error)?.message ?? String(err) });
                  });
                }
              }
            }).catch(() => {
              // Peer doesn't support inbox protocol (not a seed) — that's fine
            });
          }, 2000);
          this.pendingTimeouts.add(timer);
        }
      }
    };
    this.libp2p.addEventListener('peer:connect', this.peerConnectHandler);

    this.peerDisconnectHandler = (evt: CustomEvent) => {
      const peerId = evt.detail.toString();
      this.handshake?.removePeer(peerId);
      this.metrics.increment('peers.disconnected');
      this.metrics.gauge('peers.current', this.libp2p?.getPeers().length ?? 0);
      this.partitionDetector.updatePeerCount(this.libp2p?.getPeers().length ?? 0);
      this.events.onPeerDisconnected?.(peerId);
    };
    this.libp2p.addEventListener('peer:disconnect', this.peerDisconnectHandler);

    // Open persistent stores
    await this.trustPolicy.open();
    await this.spamFilter.open();
    await this.localLedger.open();
    await this.sharedLedger.open();

    // Start peer exchange protocol (with signing keys for authenticated records)
    this.peerExchange = new PeerExchange(this.libp2p, {
      localPrivateKey: this.privateKey,
      localPubkeyHex: publicKeyToHex(this.publicKey),
      reputation: this.peerReputation,
      shutdownSignal: this.shutdownController.signal,
      circuitBreaker: this.circuitBreaker,
    });
    await this.peerExchange.start();

    // Start ledger sync protocol. SEC-3: apply the optional submitter allow-list
    // and per-submitter ingest rate limit on the sync path.
    const submitterAllowlist = this.config.ledgerSubmitterAllowlist;
    const allowlistSet = submitterAllowlist && submitterAllowlist.length > 0
      ? new Set(submitterAllowlist)
      : undefined;
    this.ledgerSync = new LedgerSync(
      this.libp2p,
      this.sharedLedger,
      this.ledgerConsensus,
      this.publicKey,
      this.privateKey,
      {
        shutdownSignal: this.shutdownController.signal,
        isSubmitterAuthorized: allowlistSet ? (hex) => allowlistSet.has(hex) : undefined,
        maxIngestPerMinute: this.config.ledgerMaxIngestPerMinute,
      },
    );
    await this.ledgerSync.start();

    // Build trust checker for direct messages
    const dmTrustChecker: DirectMessageTrustChecker = {
      isAllowed: (pubkeyHex: string) => this.trustPolicy.isAllowed(pubkeyHex, []),
      isDuplicate: (id: string) => this.spamFilter.isDuplicate(id),
      isRateLimited: (pubkeyHex: string) => this.spamFilter.isRateLimited(pubkeyHex, this.config.rateLimitPerMinute),
      reportSpam: (pubkeyHex: string) => { this.spamFilter.reportSpam(pubkeyHex); },
    };

    // Start direct message protocol with encryption keys and trust checking.
    // DM delivery is routed through the shared InboundBudget so the global
    // inbound cap and per-sender payload budget apply to direct messages too
    // (SEC-2 / RL-1) — the primary token-burn path for a targeted attacker.
    this.directMessage = new DirectMessageProtocol(this.libp2p, {
      onMessage: (envelope) => this.deliverDirectMessage(envelope),
      localPrivateKey: this.privateKey,
      localPubkeyHex: publicKeyToHex(this.publicKey),
      trustChecker: dmTrustChecker,
    }, this.shutdownController.signal);
    await this.directMessage.start();

    // Start discovery protocol.
    // For discovery trust: if the node has open tags, we're permissive with service
    // advertisements (signed descriptors from anyone are accepted). For seed nodes,
    // we skip the trust check entirely — seeds relay all signed advertisements.
    // For regular nodes with no open tags, we filter by the trust policy.
    const localPeerId = this.libp2p.peerId.toString();
    const discoveryTrust = this.config.isSeedNode
      ? undefined  // Seeds accept all signed advertisements (they're relay infrastructure)
      : { isAllowed: (pubkeyHex: string) => {
          // Allow if the agent is explicitly trusted
          if (this.trustPolicy.isAllowed(pubkeyHex, [])) return true;
          // Allow if any tags are open (permissive discovery mode)
          if (this.trustPolicy.getOpenTags().length > 0) return true;
          // Deny-first default
          return false;
        }};
    this.discoveryProtocol = new DiscoveryProtocol(
      this.libp2p,
      this.serviceRegistry,
      publicKeyToHex(this.publicKey),
      localPeerId,
      this.privateKey,
      discoveryTrust,
      undefined,
      this.shutdownController.signal,
    );
    await this.discoveryProtocol.start();

    // Auto-register a service for advertised tags so peers can discover this node
    if (this.config.advertisedTags.length > 0) {
      await this.registerService({
        name: getFingerprint(this.publicKey),
        tags: this.config.advertisedTags,
        description: '',
        ttl: 300_000,
        metadata: {},
      });
    }

    // Re-advertise local services periodically before TTL expires (every 4 minutes for 5-min TTL)
    if (this.config.advertisedTags.length > 0 && this.discoveryProtocol) {
      const dp = this.discoveryProtocol;
      this.reAdvertiseTimer = setInterval(() => {
        const locals = this.serviceRegistry.getLocal();
        for (const descriptor of locals) {
          // Refresh the advertisedAt timestamp and re-sign (signature covers advertisedAt)
          const refreshed = { ...descriptor, advertisedAt: Date.now(), signature: undefined };
          dp.signDescriptor(refreshed).then((signed) => {
            this.serviceRegistry.updateDescriptor(signed);
            dp.broadcastAdvertisement(signed).catch((err) => {
              this.log.warn('Re-advertisement broadcast failed', { error: (err as Error)?.message ?? String(err) });
            });
          }).catch((err) => {
            this.log.warn('Descriptor signing failed', { error: (err as Error)?.message ?? String(err) });
          });
        }
      }, jitteredPeriod(4 * 60_000));
    }

    // Periodic inbox polling — fallback receive path for NATted nodes.
    // GossipSub requires bidirectional mesh, which breaks for nodes behind NAT.
    // This polls seeds every 30 seconds for any messages we missed, ensuring
    // messages are eventually delivered even when GossipSub relay fails.
    if (this.inboxClient && this.tagPubSub && !this.config.isSeedNode) {
      this.inboxPollTimer = setInterval(() => {
        if (this.paused || !this.inboxClient || !this.tagPubSub) return;
        // RL-2: stop early if the global inbound window is already full — no
        // point fetching messages we'll only drop.
        if (!this.inboundBudget.hasGlobalCapacity()) return;

        const topics = this.tagPubSub.getSubscribedTags().map(
          (tag) => `magic/tag/${tag}`,
        );
        if (topics.length === 0) return;

        // SCH-2: only poll connected seed nodes (the inbox servers), not every
        // connected peer. Fall back to all peers only when no seeds are known.
        const connected = new Set((this.libp2p?.getPeers() ?? []).map((p) => p.toString()));
        const seedTargets = [...this.configuredSeedPeerIds].filter((id) => connected.has(id));
        const targets = seedTargets.length > 0 ? seedTargets : undefined;

        this.inboxClient.fetchFromPeers(topics, targets).then((messages) => {
          if (messages.length === 0) return;
          this.log.info('Inbox poll: new messages', { count: messages.length });
          // RL-2: cap total messages processed per cycle to the inbound budget.
          const cap = this.config.maxInboundPerMinute > 0 ? this.config.maxInboundPerMinute : messages.length;
          let processed = 0;
          for (const msg of messages) {
            if (processed >= cap || !this.inboundBudget.hasGlobalCapacity()) break;
            processed++;
            this.handleIncomingMessage(msg.topic, msg.data).catch((err) => {
              this.log.warn('Error handling polled inbox message', { error: (err as Error)?.message ?? String(err) });
            });
          }
        }).catch((err) => {
          this.log.warn('Inbox poll failed', { error: (err as Error)?.message ?? String(err) });
        });
      }, jitteredPeriod(30_000));
    }

    // Seed connectivity monitoring: track which seeds are reachable, emit
    // degraded/recovered events, and attempt manual re-dial when disconnected.
    // SCH-1: this now runs on seed nodes too — libp2p bootstrap only dials at
    // startup, so without this the seed mesh never re-heals after a disconnect.
    if (this.config.seedNodes.length > 0) {
      this.seedMonitorTimer = setInterval(() => {
        this.checkSeedConnectivity();
      }, jitteredPeriod(60_000));
    }

    // Record start time last so uptime reflects a fully-started node (DC-2).
    this.startedAt = Date.now();

    const fingerprint = getFingerprint(this.publicKey);
    const addrs = this.libp2p.getMultiaddrs().map((a) => a.toString());
    this.log.info('Node started', { fingerprint, version: LEYLINE_VERSION, addrs });
    this.log.info('Subscribed tags', { tags: this.config.subscribedTags });
    if (this.config.advertisedTags.length > 0) {
      this.log.info('Advertised tags', { tags: this.config.advertisedTags });
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.shutdownController.abort();

    // Clear all tracked timers
    if (this.reAdvertiseTimer) {
      clearInterval(this.reAdvertiseTimer);
      this.reAdvertiseTimer = null;
    }
    if (this.inboxPollTimer) {
      clearInterval(this.inboxPollTimer);
      this.inboxPollTimer = null;
    }
    if (this.seedMonitorTimer) {
      clearInterval(this.seedMonitorTimer);
      this.seedMonitorTimer = null;
    }
    for (const timer of this.pendingTimeouts) {
      clearTimeout(timer);
    }
    this.pendingTimeouts.clear();

    await this.handshake?.stop();
    await this.discoveryProtocol?.stop();
    await this.directMessage?.stop();
    await this.peerExchange?.stop();
    await this.ledgerSync?.stop();
    await this.localLedger.close();
    await this.sharedLedger.close();
    await this.trustPolicy.close();
    await this.spamFilter.close();
    this.peerReputation.clear();
    this.inboundBudget.clear();
    this.partitionDetector.reset();
    this.circuitBreaker.clear();

    // Remove event listeners before stopping libp2p
    if (this.libp2p && this.gossipHandler) {
      const gs = (this.libp2p.services as Record<string, unknown>).pubsub as GossipSub;
      gs.removeEventListener('gossipsub:message', this.gossipHandler);
      this.gossipHandler = null;
      if (this.subscriptionChangeHandler) {
        gs.removeEventListener('subscription-change', this.subscriptionChangeHandler);
        this.subscriptionChangeHandler = null;
      }
    }
    if (this.libp2p && this.peerConnectHandler) {
      this.libp2p.removeEventListener('peer:connect', this.peerConnectHandler);
      this.peerConnectHandler = null;
    }
    if (this.libp2p && this.peerDisconnectHandler) {
      this.libp2p.removeEventListener('peer:disconnect', this.peerDisconnectHandler);
      this.peerDisconnectHandler = null;
    }

    await this.libp2p?.stop();
    this.tagPubSub?.clear();
    this.tagPubSub = null;
    this.libp2p = null;
    this.log.info('Node stopped');
  }

  /** Broadcast a message to the given tags. */
  async broadcast(
    tags: string[],
    payload: Uint8Array,
    type: MessageType = MessageType.BROADCAST,
  ): Promise<MagicMessage> {
    const msg = await createMessage({
      tags,
      payload,
      type,
      ttl: this.config.defaultTtl,
      privateKey: this.privateKey,
      publicKey: this.publicKey,
    });

    if (!this.tagPubSub) {
      throw new Error('MagicNode: cannot broadcast before start() completes');
    }
    const data = serializeMessage(msg);
    await this.tagPubSub.publish(tags, data);
    this.metrics.increment('messages.sent');

    // Record in local ledger
    await this.localLedger.append(data, 'sent');

    return msg;
  }

  /** Advertise a service/skill on the given tags. */
  async advertise(tags: string[], payload: Uint8Array): Promise<MagicMessage> {
    return this.broadcast(tags, payload, MessageType.ADVERTISE);
  }

  /** Send a discovery query. */
  async discover(tags: string[], query: Uint8Array): Promise<MagicMessage> {
    return this.broadcast(tags, query, MessageType.DISCOVER);
  }

  /** Subscribe to additional tags at runtime. */
  subscribe(tag: string): void {
    this.tagPubSub?.subscribe(tag);
  }

  /** Unsubscribe from a tag. */
  unsubscribe(tag: string): void {
    this.tagPubSub?.unsubscribe(tag);
  }

  /** Register a handler for messages on a specific tag. */
  onTag(tag: string, handler: (msg: MagicMessage, tag: string) => void): void {
    this.tagPubSub?.onTag(tag, (data: Uint8Array, t: string) => {
      const msg = deserializeMessage(data);
      handler(msg, t);
    });
  }

  /**
   * Register a queued handler for messages on a specific tag.
   *
   * Unlike `onTag`, this processes messages sequentially — only one handler
   * invocation runs at a time. If messages arrive faster than the handler
   * processes them, excess messages are queued up to `maxQueueSize`, after
   * which the oldest are dropped.
   *
   * **This is the recommended handler for AI bots** that call LLM APIs
   * per-message, since it prevents concurrent API calls from burning tokens
   * during traffic spikes.
   *
   * @param tag          - Tag to listen on.
   * @param handler      - Async handler; next message waits until this resolves.
   * @param maxQueueSize - Max pending messages in the queue (default: 50). Oldest dropped when full.
   */
  onTagQueued(
    tag: string,
    handler: (msg: MagicMessage, tag: string) => Promise<void>,
    maxQueueSize: number = 50,
  ): void {
    const queue: Array<{ msg: MagicMessage; tag: string }> = [];
    let processing = false;

    const drain = async () => {
      if (processing) return;
      processing = true;
      while (queue.length > 0) {
        const item = queue.shift()!;
        try {
          await handler(item.msg, item.tag);
        } catch (err) {
          this.log.error(`onTagQueued handler error`, { tag, error: (err as Error)?.message ?? String(err) });
        }
      }
      processing = false;
    };

    this.tagPubSub?.onTag(tag, (data: Uint8Array, t: string) => {
      const msg = deserializeMessage(data);
      if (queue.length >= maxQueueSize) {
        queue.shift(); // Drop oldest
      }
      queue.push({ msg, tag: t });
      drain();
    });
  }

  /**
   * Like `onTagQueued`, but messages are processed in priority order.
   * The `assignPriority` callback classifies each message. Lower number = higher precedence.
   * When the queue is full, lowest-priority messages are dropped first.
   *
   * Scheduling contract: this is a *greedy online* priority queue. A message
   * begins processing immediately when the queue is idle; only messages already
   * waiting in the queue at pop time are ordered by priority. Processing is
   * never delayed to coalesce with future arrivals, and an in-flight handler is
   * never preempted — so a lower-priority message that arrives while the queue
   * is idle can start before a higher-priority message that arrives later.
   */
  onTagPriority(
    tag: string,
    handler: (msg: MagicMessage, tag: string) => Promise<void>,
    assignPriority: (msg: MagicMessage) => MessagePriority = () => MessagePriority.NORMAL,
    maxQueueSize: number = 50,
  ): void {
    const queue = new PriorityQueue<{ msg: MagicMessage; tag: string }>(maxQueueSize);
    let processing = false;

    const drain = async () => {
      if (processing) return;
      processing = true;
      let item: { msg: MagicMessage; tag: string } | undefined;
      while ((item = queue.pop()) !== undefined) {
        try {
          await handler(item.msg, item.tag);
        } catch (err) {
          this.log.error(`onTagPriority handler error`, { tag, error: (err as Error)?.message ?? String(err) });
        }
      }
      processing = false;
    };

    this.tagPubSub?.onTag(tag, (data: Uint8Array, t: string) => {
      const msg = deserializeMessage(data);
      const priority = assignPriority(msg);
      queue.push({ msg, tag: t }, priority);
      drain();
    });
  }

  /**
   * Central delivery point for inbound direct messages. Applies the shared
   * inbound budget (global cap + per-sender payload bytes) BEFORE invoking any
   * handler, then fans out to the global `onDirectMessage` event and, if
   * registered, the sequential queued handler (SEC-2 / FEAT-2).
   */
  private deliverDirectMessage(envelope: DirectEnvelope): void {
    if (this.paused) return;

    // Budget by sender identity when known; fall back to the sender peer id.
    const senderKey = envelope.senderPubkeyHex ?? `peer:${envelope.senderPeerId}`;
    const result = this.inboundBudget.admit(senderKey, envelope.payload.length);
    if (!result.admitted) {
      this.metrics.increment('messages.blocked', 1, { reason: `dm_${result.reason}` });
      if (result.reason === 'payload_bytes' && envelope.senderPubkeyHex) {
        this.spamFilter.reportSpam(envelope.senderPubkeyHex);
      }
      return;
    }

    this.metrics.increment('dm.received');
    this.events.onDirectMessage?.(envelope);
    this.dmQueuedPush?.(envelope);
  }

  /**
   * Register a queued handler for incoming direct messages.
   *
   * Mirrors {@link onTagQueued}: messages are processed sequentially — only one
   * handler invocation runs at a time. Excess messages queue up to
   * `maxQueueSize`, after which the oldest are dropped. Combined with the shared
   * inbound budget, this is the recommended DM handler for AI bots that call LLM
   * APIs per message, preventing concurrent API calls from burning tokens.
   *
   * @param handler      - Async handler; the next DM waits until it resolves.
   * @param maxQueueSize - Max pending DMs (default 50). Oldest dropped when full.
   */
  onDirectMessageQueued(
    handler: (envelope: DirectEnvelope) => Promise<void>,
    maxQueueSize: number = 50,
  ): void {
    const queue: DirectEnvelope[] = [];
    let processing = false;

    const drain = async () => {
      if (processing) return;
      processing = true;
      while (queue.length > 0) {
        const env = queue.shift()!;
        try {
          await handler(env);
        } catch (err) {
          this.log.error('onDirectMessageQueued handler error', { error: (err as Error)?.message ?? String(err) });
        }
      }
      processing = false;
    };

    this.dmQueuedPush = (envelope: DirectEnvelope) => {
      if (queue.length >= maxQueueSize) queue.shift(); // Drop oldest
      queue.push(envelope);
      drain();
    };
  }

  /** Allow a specific agent (by public key hex). */
  async allowAgent(pubkeyHex: string): Promise<void> {
    await this.trustPolicy.allowAgent(pubkeyHex);
  }

  /** Block a specific agent permanently (by public key hex). */
  async blockAgent(pubkeyHex: string): Promise<void> {
    await this.trustPolicy.blockAgent(pubkeyHex);
  }

  /** Block a specific agent until `expiresAt` (epoch ms). Auto-expires. */
  async blockAgentUntil(pubkeyHex: string, expiresAt: number): Promise<void> {
    await this.trustPolicy.blockAgentUntil(pubkeyHex, expiresAt);
  }

  /** Remove a block from a specific agent. Does not auto-allow them. */
  async unblockAgent(pubkeyHex: string): Promise<void> {
    await this.trustPolicy.unblockAgent(pubkeyHex);
  }

  /** Get the block expiry for an agent, or undefined if permanent/not blocked. */
  getBlockExpiry(pubkeyHex: string): number | undefined {
    return this.trustPolicy.getBlockExpiry(pubkeyHex);
  }

  /** Get all currently blocked agents. */
  getBlockedAgents(): string[] {
    return this.trustPolicy.getBlockedAgents();
  }

  /** Allow a specific agent on a specific tag. */
  async allowTag(pubkeyHex: string, tag: string): Promise<void> {
    await this.trustPolicy.allowTag(pubkeyHex, tag);
  }

  /** Block a specific agent from a specific tag. */
  async blockTag(pubkeyHex: string, tag: string): Promise<void> {
    await this.trustPolicy.blockTag(pubkeyHex, tag);
  }

  /**
   * Open a tag to ALL senders. Any agent on the network can send you
   * messages on this tag without being individually whitelisted.
   * Blocked agents are still denied.
   *
   * This is essential for open discovery — without it, a bot must know
   * every sender's pubkey before it can hear from them.
   *
   * @example
   * ```ts
   * await node.allowTagOpen('skill:code');    // Anyone can reach me on skill:code
   * await node.allowTagOpen('bounty:open');   // Anyone can post bounties to me
   * await node.blockAgent(badActorHex);       // ...except this guy
   * ```
   */
  async allowTagOpen(tag: string): Promise<void> {
    await this.trustPolicy.allowTagOpen(tag);
  }

  /**
   * Close a previously opened tag. Reverts to deny-first for this tag.
   */
  async closeTag(tag: string): Promise<void> {
    await this.trustPolicy.closeTag(tag);
  }

  /** Returns true if the given tag is open to all senders. */
  isTagOpen(tag: string): boolean {
    return this.trustPolicy.isTagOpen(tag);
  }

  /** Return a snapshot of all open tags. */
  getOpenTags(): string[] {
    return this.trustPolicy.getOpenTags();
  }

  /** Send a direct (encrypted) message to a specific peer. */
  async sendDirect(targetPeerId: string, payload: Uint8Array, recipientPubkeyHex?: string): Promise<boolean> {
    if (!this.directMessage) return false;
    return this.directMessage.send(targetPeerId, payload, recipientPubkeyHex);
  }

  /** Register a local service for discovery. */
  async registerService(opts: Omit<ServiceDescriptor, 'id' | 'advertisedAt' | 'providerPubkey' | 'providerPeerId' | 'multiaddrs' | 'signature'>): Promise<ServiceDescriptor> {
    const descriptor = this.serviceRegistry.register({
      ...opts,
      providerPubkey: publicKeyToHex(this.publicKey),
      providerPeerId: this.libp2p?.peerId.toString() ?? '',
      multiaddrs: this.getMultiaddrs(),
    });
    // Sign the descriptor and update it in the registry
    if (this.discoveryProtocol) {
      const signed = await this.discoveryProtocol.signDescriptor(descriptor);
      this.serviceRegistry.updateDescriptor(signed);
      return signed;
    }
    return descriptor;
  }

  /** Query all connected peers for services matching a query. */
  async discoverServices(query: { tags?: string[]; name?: string; limit?: number }): Promise<ServiceDescriptor[]> {
    if (!this.discoveryProtocol) return this.serviceRegistry.query(query);
    return this.discoveryProtocol.queryAllPeers(query);
  }

  /** Submit data to the shared (provable) ledger via consensus. Serialized to prevent races. */
  async submitToSharedLedger(data: Uint8Array): Promise<void> {
    // Chain onto the lock so concurrent calls execute sequentially
    const prev = this.ledgerSubmitLock;
    let resolve!: () => void;
    this.ledgerSubmitLock = new Promise<void>((r) => { resolve = r; });

    try {
      await prev;
      await this.submitToSharedLedgerInner(data);
    } finally {
      resolve();
    }
  }

  private async submitToSharedLedgerInner(data: Uint8Array): Promise<void> {
    const { sign } = await import('../identity/keypair.js');
    const signature = await sign(this.privateKey, data);

    if (this.ledgerSync) {
      // Route through consensus: propose, add own confirmation
      await this.ledgerSync.proposeAndMaybeCommit(
        data,
        this.publicKey,
        signature,
        [publicKeyToHex(this.publicKey)],
      );

      // Always submit directly to the local ledger AND broadcast to seeds.
      // With quorum=2, a single bot can't reach quorum alone. Seeds receive
      // the push-entry, add their confirmation, and the entry gets committed
      // on the seed side. The bot doesn't need to stay online for this.
      const submitted = await this.sharedLedger.submit(data, this.publicKey, signature);
      this.log.info('Ledger: submitted entry, broadcasting', { index: submitted.index, peers: this.libp2p?.getPeers().length ?? 0 });
      await this.ledgerSync.broadcastEntry(submitted);
      this.log.info('Ledger: broadcast complete');
    } else {
      // Fallback for nodes without ledger sync (e.g. before start())
      await this.sharedLedger.submit(data, this.publicKey, signature);
    }
  }

  /**
   * Pause all inbound message delivery. Messages are silently dropped at the
   * network layer — handlers will not fire and no tokens will be consumed.
   * The node stays connected and continues participating in peer exchange.
   * Call `resume()` to start receiving again.
   */
  pause(): void {
    this.paused = true;
    this.log.info('Inbound message delivery PAUSED');
  }

  /** Resume inbound message delivery after a `pause()`. */
  resume(): void {
    this.paused = false;
    this.log.info('Inbound message delivery RESUMED');
  }

  /** Returns true if inbound delivery is currently paused. */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Wait until the node has at least `minPeers` connected peers, or until
   * `timeoutMs` elapses. This ensures the GossipSub mesh is formed before
   * broadcasting.
   *
   * **Bots MUST call this after start() and before broadcasting.**
   * Without it, messages are sent into a mesh that doesn't exist yet
   * and are silently dropped.
   *
   * @param minPeers  - Minimum peers to wait for. Default: 1.
   * @param timeoutMs - Max wait time in ms. Default: 15000 (15s).
   * @returns The number of connected peers when the wait completed.
   *
   * @example
   * ```ts
   * await node.start();
   * await node.waitForPeers(); // Wait for at least 1 peer
   * await node.broadcast(...); // Now safe to send
   * ```
   */
  async waitForPeers(minPeers: number = 1, timeoutMs: number = 15_000): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.stopping) return this.getPeerCount();
      const count = this.getPeerCount();
      if (count >= minPeers) {
        await new Promise((r) => setTimeout(r, 2000));
        return this.getPeerCount();
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return this.getPeerCount();
  }

  /** Get this node's Leyline version. */
  getVersion(): string {
    return LEYLINE_VERSION;
  }

  /** Get version distribution of connected peers: version → count. */
  getVersionStats(): Map<string, number> {
    return this.handshake?.getVersionStats() ?? new Map();
  }

  /** Get the handshake protocol instance (for advanced version queries). */
  getHandshake(): HandshakeProtocol | null {
    return this.handshake;
  }

  /** Get this node's public key hex. */
  getPublicKeyHex(): string {
    return publicKeyToHex(this.publicKey);
  }

  /** Get this node's fingerprint. */
  getFingerprint(): string {
    return getFingerprint(this.publicKey);
  }

  /** Get connected peer count. */
  getPeerCount(): number {
    return this.libp2p?.getPeers().length ?? 0;
  }

  /** Get this node's multiaddrs. */
  getMultiaddrs(): string[] {
    return this.libp2p?.getMultiaddrs().map((a) => a.toString()) ?? [];
  }

  /** Get the local ledger instance. */
  getLocalLedger(): LocalLedger {
    return this.localLedger;
  }

  /** Get the shared ledger instance. */
  getSharedLedger(): SharedLedger {
    return this.sharedLedger;
  }

  /** Get the peer exchange instance. */
  getPeerExchange(): PeerExchange | null {
    return this.peerExchange;
  }

  /** Get the ledger sync instance. */
  getLedgerSync(): LedgerSync | null {
    return this.ledgerSync;
  }

  /** Get the direct message protocol instance. */
  getDirectMessage(): DirectMessageProtocol | null {
    return this.directMessage;
  }

  /** Get the service registry. */
  getServiceRegistry(): ServiceRegistry {
    return this.serviceRegistry;
  }

  /** Get the discovery protocol instance. */
  getDiscoveryProtocol(): DiscoveryProtocol | null {
    return this.discoveryProtocol;
  }

  /** Get the ledger consensus instance. */
  getLedgerConsensus(): LedgerConsensus {
    return this.ledgerConsensus;
  }

  /** Get the peer reputation tracker. */
  getPeerReputation(): PeerReputation {
    return this.peerReputation;
  }

  /** Get the metrics tracker for observability. */
  getMetrics(): NodeMetrics {
    return this.metrics;
  }

  /** Get the partition detector for network health monitoring. */
  getPartitionDetector(): PartitionDetector {
    return this.partitionDetector;
  }

  /** Get the shutdown signal for cooperative cancellation. */
  getShutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
  }

  /** Get the circuit breaker for outbound peer dials. */
  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  /** Whether the node is currently degraded (no seeds reachable). */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** Record a health event (degraded/recovered/partition) for the dashboard. */
  private recordEvent(message: string): void {
    const stamped = `${new Date().toISOString()} — ${message}`;
    this.recentEvents.unshift(stamped);
    if (this.recentEvents.length > 20) this.recentEvents.length = 20;
  }

  /** Recent degraded/recovered/partition events, newest first (FEAT-3). */
  getRecentEvents(): string[] {
    return [...this.recentEvents];
  }

  /** Comprehensive node status for operational monitoring. */
  getNodeStatus(): NodeStatus {
    const peers = this.libp2p?.getPeers() ?? [];
    const connectedSeeds = this.getConnectedSeedCount();
    return {
      running: this.libp2p !== null && !this.stopping,
      degraded: this.degraded,
      peerId: this.libp2p?.peerId?.toString() ?? '',
      fingerprint: this.publicKey.length > 0 ? getFingerprint(this.publicKey) : '',
      peerCount: peers.length,
      connectedSeeds,
      totalSeeds: Math.max(this.seedPeerIds.size, this.config.seedNodes.length),
      subscribedTags: this.tagPubSub?.getSubscribedTags() ?? [],
      openTags: this.trustPolicy.getOpenTags(),
      localServices: this.serviceRegistry.getLocal().length,
      remoteServices: this.serviceRegistry.getAll().length - this.serviceRegistry.getLocal().length,
      ledgerEntries: 0, // filled async
      paused: this.paused,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
      version: LEYLINE_VERSION,
      circuitBreakerOpen: this.circuitBreaker.getOpenPeers().length,
    };
  }

  /** Async variant that includes ledger entry count. */
  async getNodeStatusAsync(): Promise<NodeStatus> {
    const status = this.getNodeStatus();
    try { status.ledgerEntries = await this.sharedLedger.getEntryCount(); } catch { /* */ }
    return status;
  }

  /** Get the number of connected seed nodes. */
  getConnectedSeedCount(): number {
    if (!this.libp2p) return 0;
    const connectedPeerIds = new Set(this.libp2p.getPeers().map((p) => p.toString()));
    // Prefer the configured seed PeerIds (DC-1) so reporting works for /dns4
    // seeds; fall back to learned seedPeerIds when no configured ids exist.
    const seedIds = this.configuredSeedPeerIds.size > 0 ? this.configuredSeedPeerIds : this.seedPeerIds;
    let count = 0;
    for (const seedPeerId of seedIds) {
      if (connectedPeerIds.has(seedPeerId)) count++;
    }
    return count;
  }

  private checkSeedConnectivity(): void {
    if (!this.libp2p || this.stopping) return;

    const connectedPeerIds = new Set(this.libp2p.getPeers().map((p) => p.toString()));

    // DC-1: count seeds by matching connected peers against the configured seed
    // PeerIds (DNS/IP-agnostic). Falls back to learned seedPeerIds if none.
    const totalPeers = connectedPeerIds.size;
    const connectedSeeds = this.getConnectedSeedCount();
    const seedsConfigured = this.configuredSeedPeerIds.size > 0 || this.seedPeerIds.size > 0;

    const totalSeeds = Math.max(this.configuredSeedPeerIds.size, this.seedPeerIds.size, this.config.seedNodes.length);

    this.partitionDetector.updateSeedConnectivity(connectedSeeds, totalSeeds);
    this.events.onSeedConnectivityChange?.(connectedSeeds, totalSeeds);

    // DC-4: base degraded on seed reachability when seeds are configured. A node
    // connected only to non-seed peers has no relay/inbox/ledger path and should
    // still be flagged degraded. When no seeds are configured, fall back to the
    // total-peer signal.
    const isDegradedNow = seedsConfigured ? connectedSeeds === 0 : totalPeers === 0;

    if (isDegradedNow && !this.degraded) {
      this.degraded = true;
      const reason = seedsConfigured
        ? 'No seed nodes reachable — operating in degraded mode (no relay/inbox/ledger path)'
        : 'No peers connected — operating in degraded mode (messages will be queued locally)';
      this.log.warn(reason);
      this.recordEvent(`degraded: ${reason}`);
      this.events.onDegraded?.(reason);
    } else if (!isDegradedNow && this.degraded) {
      this.degraded = false;
      this.log.info('Seed connectivity restored — recovered from degraded mode');
      this.recordEvent('recovered: seed connectivity restored');
      this.events.onRecovered?.();
    }

    // Always re-dial disconnected seeds — not just when fully isolated.
    // libp2p's bootstrap only runs at startup; without this, seed connections
    // lost to network blips, idle timeouts, or seed restarts are never restored.
    this.redialDisconnectedSeeds(connectedPeerIds);
  }

  private redialDisconnectedSeeds(connectedPeerIds: Set<string>): void {
    if (!this.libp2p || this.stopping) return;

    import('@multiformats/multiaddr').then(({ multiaddr }) => {
      for (const seedAddr of this.config.seedNodes) {
        if (!this.libp2p || this.stopping) return;

        // Extract peer ID from the multiaddr /p2p/ suffix
        const seedPeerId = extractSeedPeerId(seedAddr);
        if (!seedPeerId) continue;

        // Never dial ourselves — a seed's own multiaddr is in its seed list (SCH-1).
        if (seedPeerId === this.libp2p.peerId.toString()) continue;

        // Skip if already connected
        if (connectedPeerIds.has(seedPeerId)) continue;

        // Skip if circuit breaker is open (avoid hammering unreachable seeds)
        if (this.circuitBreaker?.isOpen(seedPeerId)) continue;

        this.libp2p.dial(multiaddr(seedAddr)).then(() => {
          this.log.info('Reconnected to seed', { seed: seedPeerId.slice(0, 16) });
          this.circuitBreaker?.recordSuccess(seedPeerId);
        }).catch(() => {
          this.circuitBreaker?.recordFailure(seedPeerId);
        });
      }
    }).catch((err) => {
      this.log.warn('multiaddr import failed in redialDisconnectedSeeds', { error: String(err) });
    });
  }

  protected async handleIncomingMessage(topic: string, data: Uint8Array): Promise<void> {
    // If paused, drop all inbound messages silently
    if (this.paused) return;
    const startMs = performance.now();

    let msg: MagicMessage;
    try {
      msg = deserializeMessage(data);
    } catch {
      return; // Malformed message, ignore
    }

    const senderHex = publicKeyToHex(msg.senderPubkey);

    // Validate message structure
    const validation = validateMessage(msg);
    if (!validation.valid) {
      this.peerReputation.recordViolation(senderHex);
      this.metrics.increment('messages.blocked', 1, { reason: 'validation' });
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Check deduplication
    const msgIdHex = Buffer.from(msg.id).toString('hex');
    if (this.spamFilter.isDuplicate(msgIdHex)) {
      await this.localLedger.append(data, 'blocked');
      return; // Already seen — recorded as blocked for audit
    }

    // Per-tag rate limiting (checked before the global per-sender limit).
    // Only runs when tagRateLimits config is non-empty.
    if (Object.keys(this.config.tagRateLimits).length > 0 &&
        this.isTagRateLimited(senderHex, msg.tags)) {
      this.metrics.increment('ratelimit.hit');
      this.metrics.increment('messages.blocked', 1, { reason: 'tag_ratelimit' });
      this.log.debug('Per-tag rate limit exceeded', { sender: senderHex.slice(0, 16), tags: msg.tags });
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Check rate limiting (per-sender)
    if (this.spamFilter.isRateLimited(senderHex, this.config.rateLimitPerMinute)) {
      await this.spamFilter.reportSpam(senderHex);
      this.peerReputation.recordSpam(senderHex);
      this.metrics.increment('ratelimit.hit');
      this.metrics.increment('messages.blocked', 1, { reason: 'ratelimit' });
      await this.localLedger.append(data, 'blocked');
      // Auto-block agents that repeatedly hit rate limits
      if (this.config.autoBlockThreshold > 0 &&
          this.spamFilter.getSpamCount(senderHex) >= this.config.autoBlockThreshold) {
        await this.trustPolicy.blockAgent(senderHex);
        this.log.warn('Auto-blocked agent', { agent: senderHex.slice(0, 16), spamCount: this.spamFilter.getSpamCount(senderHex) });
      }
      return;
    }

    // Unified inbound cost governor: global per-minute cap + per-sender payload
    // byte budget, shared with the direct-message and inbox paths (FEAT-2).
    const admit = this.inboundBudget.admit(senderHex, msg.payload.length);
    if (!admit.admitted) {
      if (admit.reason === 'global_rate') {
        // Global cap reached — drop silently (not the sender's fault, backpressure).
        return;
      }
      // Per-sender payload budget exceeded — treat as spam.
      await this.spamFilter.reportSpam(senderHex);
      this.metrics.increment('messages.blocked', 1, { reason: 'payload_budget' });
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Check trust policy BEFORE signature verification (deny-first).
    // This prevents a DoS where a malicious peer sends millions of messages
    // from untrusted senders, forcing expensive Ed25519 verification on each.
    if (!this.trustPolicy.isAllowed(senderHex, msg.tags)) {
      this.metrics.increment('trust.denied');
      this.metrics.increment('messages.blocked', 1, { reason: 'trust' });
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Verify signature (wrapped in try/catch since ed.verifyAsync can throw on malformed keys)
    let sigValid: boolean;
    try {
      sigValid = await verifyMessageSignature(msg);
    } catch {
      sigValid = false;
    }
    if (!sigValid) {
      await this.spamFilter.reportSpam(senderHex);
      this.peerReputation.recordViolation(senderHex);
      this.metrics.increment('signature.failed');
      this.metrics.increment('messages.blocked', 1, { reason: 'signature' });
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Message passed all checks — record and deliver
    this.peerReputation.recordSuccess(senderHex);
    this.metrics.increment('messages.received');
    await this.localLedger.append(data, 'received');

    // Track last-received timestamp for inbox sync
    this.inboxClient?.markReceived(msg.timestamp);

    // Deliver to tag-specific handlers (registered via onTag()).
    // These are distinct from the global onMessage event — a consumer may
    // listen to both without receiving duplicate notifications.
    this.tagPubSub?.handleMessage(topic, data);

    // Track message processing latency
    this.metrics.observe('message.latency.ms', performance.now() - startMs);

    // Fire global event
    this.events.onMessage?.(msg, topic);
  }

  /**
   * Check whether a sender has exceeded the per-tag rate limit for any of
   * the given tags.
   *
   * Uses per-tag sliding one-minute windows (independent of the global
   * per-sender window managed by {@link SpamFilter}). A message is blocked
   * if the sender exceeds the configured limit for **any** tag it carries.
   *
   * Returns `false` immediately when `config.tagRateLimits` is empty so
   * there is zero overhead on nodes that have not configured per-tag limits.
   *
   * @param senderHex - Hex-encoded public key of the message sender.
   * @param tags      - Tags carried by the incoming message.
   * @returns `true` if the message should be blocked due to a tag rate limit.
   */
  private isTagRateLimited(senderHex: string, tags: string[]): boolean {
    const limits = this.config.tagRateLimits;
    const now = Date.now();
    const windowMs = 60_000;
    const cutoff = now - windowMs;

    // Two-pass: verify all tags pass first, then record timestamps.
    // Prevents phantom counts when tag A passes but tag B rejects.
    const pendingRecords: Array<{ timestamps: number[] }> = [];

    for (const tag of tags) {
      const limit = limits[tag];
      if (limit === undefined) continue;

      let senderMap = this.tagRateWindows.get(tag);
      if (!senderMap) {
        senderMap = new Map<string, number[]>();
        this.tagRateWindows.set(tag, senderMap);
      }

      let timestamps = senderMap.get(senderHex);
      if (!timestamps) {
        timestamps = [];
        senderMap.set(senderHex, timestamps);
      }

      // Prune expired entries
      let lo = 0;
      let hi = timestamps.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((timestamps[mid] as number) < cutoff) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) timestamps.splice(0, lo);

      // Clean up empty entries to prevent unbounded growth
      if (timestamps.length === 0) {
        senderMap.delete(senderHex);
        if (senderMap.size === 0) this.tagRateWindows.delete(tag);
        continue;
      }

      if (timestamps.length >= limit) {
        return true; // Would exceed — reject without recording
      }

      pendingRecords.push({ timestamps });
    }

    // All tags passed — now record
    for (const { timestamps } of pendingRecords) {
      timestamps.push(now);
    }

    return false;
  }
}
