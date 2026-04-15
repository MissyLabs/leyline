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

export interface MagicNodeEvents {
  onMessage?: (msg: MagicMessage, tag: string) => void;
  onDirectMessage?: (envelope: DirectEnvelope) => void;
  onPeerConnected?: (peerId: string) => void;
  onPeerDisconnected?: (peerId: string) => void;
  onSeedConnectivityChange?: (connectedSeeds: number, totalSeeds: number) => void;
  onDegraded?: (reason: string) => void;
  onRecovered?: () => void;
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
  protected publicKey: Uint8Array = new Uint8Array(0);
  protected privateKey: Uint8Array = new Uint8Array(0);
  protected events: MagicNodeEvents;
  private gossipHandler: ((evt: CustomEvent) => void) | null = null;
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

  // --- Global inbound rate limiting (token burn protection) ---
  /** Timestamps of messages delivered to handlers in the current window. */
  private inboundTimestamps: number[] = [];
  /** Per-sender payload byte counters: pubkeyHex -> { bytes, windowStart } */
  private payloadBudgets = new Map<string, { bytes: number; windowStart: number }>();
  /** When true, all inbound message delivery is paused (messages are silently dropped). */
  private paused = false;

  constructor(config: Partial<MagicConfig>, events: MagicNodeEvents = {}) {
    this.config = mergeConfig(config);
    this.trustPolicy = new PersistentTrustPolicy(`${this.config.dataDir}/trust`);
    this.spamFilter = new PersistentSpamFilter(`${this.config.dataDir}/spam`, this.config.maxSeenMessages);
    this.localLedger = new LocalLedger(`${this.config.dataDir}/local-ledger`);
    this.sharedLedger = new SharedLedger(`${this.config.dataDir}/shared-ledger`);
    this.serviceRegistry = new ServiceRegistry();
    this.ledgerConsensus = new LedgerConsensus();
    this.peerReputation = new PeerReputation();
    this.events = events;
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
      addrs.filter((ma) => {
        const str = ma.toString();
        // Keep loopback for local testing, filter private ranges for production
        if (str.includes('/ip4/10.') || str.includes('/ip4/172.') || str.includes('/ip4/192.168.')) {
          return false;
        }
        return true;
      });

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

    // Start version handshake protocol
    this.handshake = new HandshakeProtocol(this.libp2p, {
      onPeerVersion: (peerId, version, result) => {
        if (!result.compatible) {
          console.warn(`[Magic] Incompatible peer ${peerId.slice(0, 16)}... (v${version}) — messages will be rejected`);
        }
      },
    });
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
        console.warn('[Magic] Error handling incoming message:', (err as Error)?.message ?? err);
      });
    };
    gs.addEventListener('gossipsub:message', this.gossipHandler);

    // Initialize inbox client for store-and-forward message retrieval
    this.inboxClient = new InboxClient(this.libp2p);

    // Track peer connections — auto-fetch missed messages from seeds on connect
    this.peerConnectHandler = (evt: CustomEvent) => {
      const peerId = evt.detail.toString();

      // Track seed PeerIds: if this connection came from bootstrap, remember the PeerId
      if (this.config.seedNodes.length > 0 && this.libp2p) {
        const conns = this.libp2p.getConnections(evt.detail);
        for (const conn of conns) {
          const remoteAddr = conn.remoteAddr.toString();
          if (this.config.seedNodes.some((seed) => remoteAddr.includes(seed.split('/p2p/')[0]))) {
            this.seedPeerIds.add(peerId);
          }
        }
      }

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
                console.log(`[Magic] Inbox: fetched ${messages.length} missed message(s) from ${peerId.slice(0, 16)}...`);
                for (const msg of messages) {
                  this.handleIncomingMessage(msg.topic, msg.data).catch((err) => {
                    console.warn('[Magic] Error handling inbox message:', (err as Error)?.message ?? err);
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
    });
    await this.peerExchange.start();

    // Start ledger sync protocol
    this.ledgerSync = new LedgerSync(
      this.libp2p,
      this.sharedLedger,
      this.ledgerConsensus,
      this.publicKey,
      this.privateKey,
    );
    await this.ledgerSync.start();

    // Build trust checker for direct messages
    const dmTrustChecker: DirectMessageTrustChecker = {
      isAllowed: (pubkeyHex: string) => this.trustPolicy.isAllowed(pubkeyHex, []),
      isDuplicate: (id: string) => this.spamFilter.isDuplicate(id),
      isRateLimited: (pubkeyHex: string) => this.spamFilter.isRateLimited(pubkeyHex, this.config.rateLimitPerMinute),
      reportSpam: (pubkeyHex: string) => { this.spamFilter.reportSpam(pubkeyHex); },
    };

    // Start direct message protocol with encryption keys and trust checking
    this.directMessage = new DirectMessageProtocol(this.libp2p, {
      onMessage: (envelope) => this.events.onDirectMessage?.(envelope),
      localPrivateKey: this.privateKey,
      localPubkeyHex: publicKeyToHex(this.publicKey),
      trustChecker: dmTrustChecker,
    });
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
              console.warn('[Magic] Re-advertisement broadcast failed:', (err as Error)?.message ?? err);
            });
          }).catch((err) => {
            console.warn('[Magic] Descriptor signing failed:', (err as Error)?.message ?? err);
          });
        }
      }, 4 * 60_000);
    }

    // Periodic inbox polling — fallback receive path for NATted nodes.
    // GossipSub requires bidirectional mesh, which breaks for nodes behind NAT.
    // This polls seeds every 30 seconds for any messages we missed, ensuring
    // messages are eventually delivered even when GossipSub relay fails.
    if (this.inboxClient && this.tagPubSub && !this.config.isSeedNode) {
      this.inboxPollTimer = setInterval(() => {
        if (this.paused || !this.inboxClient || !this.tagPubSub) return;
        const topics = this.tagPubSub.getSubscribedTags().map(
          (tag) => `magic/tag/${tag}`,
        );
        if (topics.length === 0) return;

        this.inboxClient.fetchFromAllPeers(topics).then((messages) => {
          if (messages.length > 0) {
            console.log(`[Magic] Inbox poll: ${messages.length} new message(s)`);
            for (const msg of messages) {
              this.handleIncomingMessage(msg.topic, msg.data).catch((err) => {
                console.warn('[Magic] Error handling polled inbox message:', (err as Error)?.message ?? err);
              });
            }
          }
        }).catch((err) => {
          console.warn('[Magic] Inbox poll failed:', (err as Error)?.message ?? err);
        });
      }, 30_000);
    }

    // Seed connectivity monitoring: track which seeds are reachable, emit
    // degraded/recovered events, and attempt manual re-dial when disconnected.
    if (this.config.seedNodes.length > 0 && !this.config.isSeedNode) {
      this.seedMonitorTimer = setInterval(() => {
        this.checkSeedConnectivity();
      }, 15_000);
    }

    const fingerprint = getFingerprint(this.publicKey);
    const addrs = this.libp2p.getMultiaddrs().map((a) => a.toString());
    console.log(`[Magic] Node started: ${fingerprint} (v${LEYLINE_VERSION})`);
    console.log(`[Magic] Listening on: ${addrs.join(', ')}`);
    console.log(`[Magic] Subscribed tags: ${this.config.subscribedTags.join(', ') || '(none)'}`);
    if (this.config.advertisedTags.length > 0) {
      console.log(`[Magic] Advertised tags: ${this.config.advertisedTags.join(', ')}`);
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
    this.payloadBudgets.clear();
    this.inboundTimestamps = [];

    // Remove event listeners before stopping libp2p
    if (this.libp2p && this.gossipHandler) {
      const gs = (this.libp2p.services as Record<string, unknown>).pubsub as GossipSub;
      gs.removeEventListener('gossipsub:message', this.gossipHandler);
      this.gossipHandler = null;
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
    console.log('[Magic] Node stopped');
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
          console.error(`[Magic] onTagQueued handler error on tag "${tag}":`, err);
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

  /** Allow a specific agent (by public key hex). */
  async allowAgent(pubkeyHex: string): Promise<void> {
    await this.trustPolicy.allowAgent(pubkeyHex);
  }

  /** Block a specific agent (by public key hex). */
  async blockAgent(pubkeyHex: string): Promise<void> {
    await this.trustPolicy.blockAgent(pubkeyHex);
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
      console.log(`[Magic] Ledger: submitted entry #${submitted.index}, broadcasting to ${this.libp2p?.getPeers().length ?? 0} peers...`);
      await this.ledgerSync.broadcastEntry(submitted);
      console.log(`[Magic] Ledger: broadcast complete`);
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
    console.log('[Magic] Inbound message delivery PAUSED');
  }

  /** Resume inbound message delivery after a `pause()`. */
  resume(): void {
    this.paused = false;
    console.log('[Magic] Inbound message delivery RESUMED');
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

  /** Get the shutdown signal for cooperative cancellation. */
  getShutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
  }

  /** Whether the node is currently degraded (no seeds reachable). */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** Get the number of connected seed nodes. */
  getConnectedSeedCount(): number {
    if (!this.libp2p) return 0;
    const connectedPeerIds = new Set(this.libp2p.getPeers().map((p) => p.toString()));
    let count = 0;
    for (const seedPeerId of this.seedPeerIds) {
      if (connectedPeerIds.has(seedPeerId)) count++;
    }
    return count;
  }

  private checkSeedConnectivity(): void {
    if (!this.libp2p || this.stopping) return;

    const connectedPeerIds = new Set(this.libp2p.getPeers().map((p) => p.toString()));

    // Build seedPeerIds from connected peers that match configured seed multiaddrs.
    // libp2p bootstrap dials seed addrs and we discover their PeerIds from connections.
    // Once we know a PeerId belongs to a seed, we track it persistently.
    // On initial start before any connection, seedPeerIds is empty and we track via
    // total connected peers as a fallback.
    const totalPeers = connectedPeerIds.size;
    const connectedSeeds = this.seedPeerIds.size > 0
      ? [...this.seedPeerIds].filter((id) => connectedPeerIds.has(id)).length
      : 0;

    const totalSeeds = Math.max(this.seedPeerIds.size, this.config.seedNodes.length);

    this.events.onSeedConnectivityChange?.(connectedSeeds, totalSeeds);

    if (totalPeers === 0 && !this.degraded) {
      this.degraded = true;
      const reason = 'No peers connected — operating in degraded mode (messages will be queued locally)';
      console.warn(`[Magic] ${reason}`);
      this.events.onDegraded?.(reason);

      // Attempt manual re-dial to seeds
      this.redialSeeds();
    } else if (totalPeers > 0 && this.degraded) {
      this.degraded = false;
      console.log('[Magic] Seed connectivity restored — recovered from degraded mode');
      this.events.onRecovered?.();
    }
  }

  private redialSeeds(): void {
    if (!this.libp2p || this.stopping) return;

    import('@multiformats/multiaddr').then(({ multiaddr }) => {
      for (const seedAddr of this.config.seedNodes) {
        if (!this.libp2p || this.stopping) return;
        this.libp2p.dial(multiaddr(seedAddr)).then(() => {
          console.log(`[Magic] Re-dial succeeded: ${seedAddr}`);
        }).catch(() => {
          // Expected — seed may still be unreachable
        });
      }
    }).catch(() => {
      // multiaddr module not available — shouldn't happen in practice
    });
  }

  protected async handleIncomingMessage(topic: string, data: Uint8Array): Promise<void> {
    // If paused, drop all inbound messages silently
    if (this.paused) return;

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
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Check deduplication
    const msgIdHex = Buffer.from(msg.id).toString('hex');
    if (this.spamFilter.isDuplicate(msgIdHex)) {
      await this.localLedger.append(data, 'blocked');
      return; // Already seen — recorded as blocked for audit
    }

    // Check rate limiting (per-sender)
    if (this.spamFilter.isRateLimited(senderHex, this.config.rateLimitPerMinute)) {
      await this.spamFilter.reportSpam(senderHex);
      this.peerReputation.recordSpam(senderHex);
      await this.localLedger.append(data, 'blocked');
      // Auto-block agents that repeatedly hit rate limits
      if (this.config.autoBlockThreshold > 0 &&
          this.spamFilter.getSpamCount(senderHex) >= this.config.autoBlockThreshold) {
        await this.trustPolicy.blockAgent(senderHex);
        console.warn(`[Magic] Auto-blocked agent ${senderHex.slice(0, 16)}... (spam count: ${this.spamFilter.getSpamCount(senderHex)})`);
      }
      return;
    }

    // Global inbound rate limit (token burn protection)
    if (this.config.maxInboundPerMinute > 0) {
      const now = Date.now();
      const cutoff = now - 60_000;
      // Prune old timestamps using binary search + slice (O(log n) vs O(n) shift loop)
      let lo = 0;
      let hi = this.inboundTimestamps.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.inboundTimestamps[mid] < cutoff) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) this.inboundTimestamps = this.inboundTimestamps.slice(lo);
      if (this.inboundTimestamps.length >= this.config.maxInboundPerMinute) {
        // Global cap reached — drop silently (not the sender's fault, just backpressure)
        return;
      }
      this.inboundTimestamps.push(now);
    }

    // Per-sender payload byte budget (prevents large-payload token burn)
    if (this.config.maxPayloadBytesPerMinute > 0) {
      const now = Date.now();
      let budget = this.payloadBudgets.get(senderHex);
      if (!budget || now - budget.windowStart > 60_000) {
        budget = { bytes: 0, windowStart: now };
        this.payloadBudgets.set(senderHex, budget);
      }
      budget.bytes += msg.payload.length;
      if (budget.bytes > this.config.maxPayloadBytesPerMinute) {
        await this.spamFilter.reportSpam(senderHex);
        await this.localLedger.append(data, 'blocked');
        return;
      }

      // Periodically evict stale payload budget entries to prevent memory leak
      if (this.payloadBudgets.size > 1000) {
        for (const [key, b] of this.payloadBudgets) {
          if (now - b.windowStart > 120_000) this.payloadBudgets.delete(key);
        }
      }
    }

    // Check trust policy BEFORE signature verification (deny-first).
    // This prevents a DoS where a malicious peer sends millions of messages
    // from untrusted senders, forcing expensive Ed25519 verification on each.
    if (!this.trustPolicy.isAllowed(senderHex, msg.tags)) {
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
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Message passed all checks — record and deliver
    this.peerReputation.recordSuccess(senderHex);
    await this.localLedger.append(data, 'received');

    // Track last-received timestamp for inbox sync
    this.inboxClient?.markReceived(msg.timestamp);

    // Deliver to tag-specific handlers (registered via onTag()).
    // These are distinct from the global onMessage event — a consumer may
    // listen to both without receiving duplicate notifications.
    this.tagPubSub?.handleMessage(topic, data);

    // Fire global event
    this.events.onMessage?.(msg, topic);
  }
}
