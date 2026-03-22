import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub, type GossipSub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys';

import { type MagicConfig, mergeConfig } from '../config/config.js';
import { TagPubSub } from '../pubsub/tag-pubsub.js';
import { TrustPolicy, SpamFilter } from '../trust/policy.js';
import { LocalLedger } from '../ledger/local-log.js';
import { SharedLedger } from '../ledger/shared-ledger.js';
import {
  type MagicMessage,
  MessageType,
  createMessage,
  serializeMessage,
  deserializeMessage,
  validateMessage,
  verifyMessageSignature,
} from '../messages/message.js';
import {
  generateKeypair,
  publicKeyToHex,
  getFingerprint,
} from '../identity/keypair.js';

export interface MagicNodeEvents {
  onMessage?: (msg: MagicMessage, tag: string) => void;
  onPeerConnected?: (peerId: string) => void;
  onPeerDisconnected?: (peerId: string) => void;
}

export class MagicNode {
  protected config: MagicConfig;
  protected libp2p: Libp2p | null = null;
  protected tagPubSub: TagPubSub | null = null;
  protected trustPolicy: TrustPolicy;
  protected spamFilter: SpamFilter;
  protected localLedger: LocalLedger;
  protected sharedLedger: SharedLedger;
  protected publicKey: Uint8Array = new Uint8Array(0);
  protected privateKey: Uint8Array = new Uint8Array(0);
  protected events: MagicNodeEvents;

  constructor(config: Partial<MagicConfig>, events: MagicNodeEvents = {}) {
    this.config = mergeConfig(config);
    this.trustPolicy = new TrustPolicy();
    this.spamFilter = new SpamFilter(this.config.maxSeenMessages);
    this.localLedger = new LocalLedger(`${this.config.dataDir}/local-ledger`);
    this.sharedLedger = new SharedLedger(`${this.config.dataDir}/shared-ledger`);
    this.events = events;
  }

  async start(): Promise<void> {
    // Generate or load identity
    const keypair = await generateKeypair();
    this.publicKey = keypair.publicKey;
    this.privateKey = keypair.privateKey;

    const privKey = await privateKeyFromRaw(this.privateKey);

    // Build libp2p config
    const libp2pOptions: Record<string, unknown> = {
      privateKey: privKey,
      addresses: {
        listen: this.config.listenAddresses,
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        pubsub: gossipsub({
          emitSelf: false,
          allowPublishToZeroTopicPeers: true,
          fallbackToFloodsub: true,
        }),
      },
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

    // Open ledgers
    await this.localLedger.open();
    await this.sharedLedger.open();

    const fingerprint = getFingerprint(this.publicKey);
    const addrs = this.libp2p.getMultiaddrs().map((a) => a.toString());
    console.log(`[Magic] Node started: ${fingerprint}`);
    console.log(`[Magic] Listening on: ${addrs.join(', ')}`);
    console.log(`[Magic] Subscribed tags: ${this.config.subscribedTags.join(', ') || '(none)'}`);
  }

  async stop(): Promise<void> {
    await this.localLedger.close();
    await this.sharedLedger.close();
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
  allowAgent(pubkeyHex: string): void {
    this.trustPolicy.allowAgent(pubkeyHex);
  }

  /** Block a specific agent (by public key hex). */
  blockAgent(pubkeyHex: string): void {
    this.trustPolicy.blockAgent(pubkeyHex);
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
      this.spamFilter.reportSpam(senderHex);
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
      this.spamFilter.reportSpam(senderHex);
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
