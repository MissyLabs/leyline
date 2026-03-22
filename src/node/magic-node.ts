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
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';

import { type MagicConfig, mergeConfig } from '../config/config.js';
import { TagPubSub } from '../pubsub/tag-pubsub.js';
import { TrustPolicy, SpamFilter } from '../trust/policy.js';
import { LocalLedger } from '../ledger/local-log.js';
import { SharedLedger } from '../ledger/shared-ledger.js';
import { LedgerSync } from '../ledger/ledger-sync.js';
import { PeerExchange } from './peer-exchange.js';
import { DirectMessageProtocol, type DirectEnvelope, type DirectMessageTrustChecker } from './direct-message.js';
import { ServiceRegistry, type ServiceDescriptor } from '../discovery/service-registry.js';
import { DiscoveryProtocol } from '../discovery/discovery-protocol.js';
import { PersistentTrustPolicy, PersistentSpamFilter } from '../trust/persistent-policy.js';
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
  protected ledgerConsensus: LedgerConsensus;
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
      }),
      dcutr: dcutr(),
    };
    if (this.config.isSeedNode) services.relay = circuitRelayServer();

    // Build libp2p config
    const libp2pOptions: Record<string, unknown> = {
      privateKey: privKey,
      addresses: {
        listen: listenAddresses,
      },
      transports,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services,
      ...(this.config.seedNodes.length > 0
        ? { peerDiscovery: [bootstrap({ list: this.config.seedNodes })] }
        : {}),
    };

    this.libp2p = await createLibp2p(libp2pOptions as Parameters<typeof createLibp2p>[0]);

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
      this.handleIncomingMessage(msg.topic, msg.data);
    };
    gs.addEventListener('gossipsub:message', this.gossipHandler);

    // Track peer connections (store handlers for cleanup in stop())
    this.peerConnectHandler = (evt: CustomEvent) => {
      const peerId = evt.detail.toString();
      this.events.onPeerConnected?.(peerId);
    };
    this.libp2p.addEventListener('peer:connect', this.peerConnectHandler);

    this.peerDisconnectHandler = (evt: CustomEvent) => {
      const peerId = evt.detail.toString();
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

    // Start discovery protocol (with trust filtering)
    const localPeerId = this.libp2p.peerId.toString();
    this.discoveryProtocol = new DiscoveryProtocol(
      this.libp2p,
      this.serviceRegistry,
      publicKeyToHex(this.publicKey),
      localPeerId,
      this.privateKey,
      { isAllowed: (pubkeyHex: string) => this.trustPolicy.isAllowed(pubkeyHex, []) },
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
            dp.broadcastAdvertisement(signed).catch(() => {
              // Best-effort re-advertisement
            });
          }).catch(() => {
            // Signing failure — skip this cycle
          });
        }
      }, 4 * 60_000);
    }

    const fingerprint = getFingerprint(this.publicKey);
    const addrs = this.libp2p.getMultiaddrs().map((a) => a.toString());
    console.log(`[Magic] Node started: ${fingerprint}`);
    console.log(`[Magic] Listening on: ${addrs.join(', ')}`);
    console.log(`[Magic] Subscribed tags: ${this.config.subscribedTags.join(', ') || '(none)'}`);
    if (this.config.advertisedTags.length > 0) {
      console.log(`[Magic] Advertised tags: ${this.config.advertisedTags.join(', ')}`);
    }
  }

  async stop(): Promise<void> {
    if (this.reAdvertiseTimer) {
      clearInterval(this.reAdvertiseTimer);
      this.reAdvertiseTimer = null;
    }
    await this.discoveryProtocol?.stop();
    await this.directMessage?.stop();
    await this.peerExchange?.stop();
    await this.ledgerSync?.stop();
    await this.localLedger.close();
    await this.sharedLedger.close();
    await this.trustPolicy.close();
    await this.spamFilter.close();

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
      const countBefore = await this.sharedLedger.getEntryCount();

      // Route through consensus: propose, add own confirmation, broadcast to peers
      await this.ledgerSync.proposeAndMaybeCommit(
        data,
        this.publicKey,
        signature,
        [publicKeyToHex(this.publicKey)],
      );

      // Only broadcast if a new entry was actually committed
      const countAfter = await this.sharedLedger.getEntryCount();
      if (countAfter > countBefore) {
        const entry = await this.sharedLedger.getLatest();
        if (entry) {
          await this.ledgerSync.broadcastEntry(entry);
        }
      }
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
      // Prune old timestamps
      while (this.inboundTimestamps.length > 0 && this.inboundTimestamps[0] < cutoff) {
        this.inboundTimestamps.shift();
      }
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
    }

    // Check trust policy (deny-first)
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
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Message passed all checks — record and deliver
    await this.localLedger.append(data, 'received');

    // Deliver to tag-specific handlers (registered via onTag()).
    // These are distinct from the global onMessage event — a consumer may
    // listen to both without receiving duplicate notifications.
    this.tagPubSub?.handleMessage(topic, data);

    // Fire global event
    this.events.onMessage?.(msg, topic);
  }
}
