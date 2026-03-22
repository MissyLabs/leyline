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
import { DirectMessageProtocol, type DirectEnvelope } from './direct-message.js';
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

    // Handle incoming messages
    gs.addEventListener('gossipsub:message', (evt: CustomEvent) => {
      const { msg } = evt.detail;
      this.handleIncomingMessage(msg.topic, msg.data);
    });

    // Track peer connections
    this.libp2p.addEventListener('peer:connect', (evt: CustomEvent) => {
      const peerId = evt.detail.toString();
      this.events.onPeerConnected?.(peerId);
    });

    this.libp2p.addEventListener('peer:disconnect', (evt: CustomEvent) => {
      const peerId = evt.detail.toString();
      this.events.onPeerDisconnected?.(peerId);
    });

    // Open persistent stores
    await this.trustPolicy.open();
    await this.spamFilter.open();
    await this.localLedger.open();
    await this.sharedLedger.open();

    // Start peer exchange protocol
    this.peerExchange = new PeerExchange(this.libp2p);
    await this.peerExchange.start();

    // Start ledger sync protocol
    this.ledgerSync = new LedgerSync(
      this.libp2p,
      this.sharedLedger,
      this.publicKey,
      this.privateKey,
    );
    await this.ledgerSync.start();

    // Start direct message protocol
    this.directMessage = new DirectMessageProtocol(this.libp2p, {
      onMessage: (envelope) => this.events.onDirectMessage?.(envelope),
    });
    await this.directMessage.start();

    // Start discovery protocol
    const localPeerId = this.libp2p.peerId.toString();
    this.discoveryProtocol = new DiscoveryProtocol(
      this.libp2p,
      this.serviceRegistry,
      publicKeyToHex(this.publicKey),
      localPeerId,
    );
    await this.discoveryProtocol.start();

    const fingerprint = getFingerprint(this.publicKey);
    const addrs = this.libp2p.getMultiaddrs().map((a) => a.toString());
    console.log(`[Magic] Node started: ${fingerprint}`);
    console.log(`[Magic] Listening on: ${addrs.join(', ')}`);
    console.log(`[Magic] Subscribed tags: ${this.config.subscribedTags.join(', ') || '(none)'}`);
  }

  async stop(): Promise<void> {
    await this.discoveryProtocol?.stop();
    await this.directMessage?.stop();
    await this.peerExchange?.stop();
    await this.ledgerSync?.stop();
    await this.localLedger.close();
    await this.sharedLedger.close();
    await this.trustPolicy.close();
    await this.spamFilter.close();
    await this.libp2p?.stop();
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

    const data = serializeMessage(msg);
    await this.tagPubSub!.publish(tags, data);

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

  /** Allow a specific agent (by public key hex). */
  async allowAgent(pubkeyHex: string): Promise<void> {
    await this.trustPolicy.allowAgent(pubkeyHex);
  }

  /** Block a specific agent (by public key hex). */
  async blockAgent(pubkeyHex: string): Promise<void> {
    await this.trustPolicy.blockAgent(pubkeyHex);
  }

  /** Send a direct message to a specific peer. */
  async sendDirect(targetPeerId: string, payload: Uint8Array): Promise<boolean> {
    if (!this.directMessage) return false;
    return this.directMessage.send(targetPeerId, payload);
  }

  /** Register a local service for discovery. */
  registerService(opts: Omit<ServiceDescriptor, 'id' | 'advertisedAt' | 'providerPubkey' | 'providerPeerId' | 'multiaddrs'>): ServiceDescriptor {
    return this.serviceRegistry.register({
      ...opts,
      providerPubkey: publicKeyToHex(this.publicKey),
      providerPeerId: this.libp2p?.peerId.toString() ?? '',
      multiaddrs: this.getMultiaddrs(),
    });
  }

  /** Query all connected peers for services matching a query. */
  async discoverServices(query: { tags?: string[]; name?: string; limit?: number }): Promise<ServiceDescriptor[]> {
    if (!this.discoveryProtocol) return this.serviceRegistry.query(query);
    return this.discoveryProtocol.queryAllPeers(query);
  }

  /** Submit data to the shared (provable) ledger. */
  async submitToSharedLedger(data: Uint8Array): Promise<void> {
    const { sign } = await import('../identity/keypair.js');
    const signature = await sign(this.privateKey, data);
    await this.sharedLedger.submit(data, this.publicKey, signature);
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
      return; // Already seen
    }

    // Check rate limiting
    if (this.spamFilter.isRateLimited(senderHex, this.config.rateLimitPerMinute)) {
      await this.spamFilter.reportSpam(senderHex);
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Check trust policy (deny-first)
    if (!this.trustPolicy.isAllowed(senderHex, msg.tags)) {
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Verify signature
    const sigValid = await verifyMessageSignature(msg);
    if (!sigValid) {
      await this.spamFilter.reportSpam(senderHex);
      await this.localLedger.append(data, 'blocked');
      return;
    }

    // Message passed all checks — record and deliver
    await this.localLedger.append(data, 'received');

    // Deliver to tag pub/sub handlers
    this.tagPubSub?.handleMessage(topic, data);

    // Fire global event
    this.events.onMessage?.(msg, topic);
  }
}
