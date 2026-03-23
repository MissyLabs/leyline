import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { sign as edSign, verify as edVerify, hexToPublicKey } from '../identity/keypair.js';

/**
 * Peer Exchange Protocol for the Leyline network.
 *
 * Nodes periodically exchange known peer lists using a dedicated
 * libp2p protocol stream. This enables mesh growth beyond direct
 * seed node connections.
 *
 * Protocol ID: /leyline/peer-exchange/1.0.0
 */

export const PEER_EXCHANGE_PROTOCOL = '/leyline/peer-exchange/1.0.0';

export interface PeerRecord {
  peerId: string;
  multiaddrs: string[];
  pubkeyHex: string;
  offeredTags: string[];
  lastSeen: number;
  /** Ed25519 signature over the canonical record fields, hex-encoded. Proves the record was created by the holder of pubkeyHex. */
  signature?: string;
}

export interface PeerExchangeMessage {
  type: 'request' | 'response';
  peers: PeerRecord[];
  senderPeerId: string;
  timestamp: number;
}

function encode(msg: PeerExchangeMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

function decode(data: Uint8Array): PeerExchangeMessage {
  const parsed = JSON.parse(new TextDecoder().decode(data));
  if (typeof parsed.type !== 'string' || !Array.isArray(parsed.peers) ||
      typeof parsed.senderPeerId !== 'string' || typeof parsed.timestamp !== 'number') {
    throw new TypeError('Malformed PeerExchangeMessage');
  }
  // Cap incoming peers array to prevent DoS via oversized responses
  if (parsed.peers.length > 200) parsed.peers = parsed.peers.slice(0, 200);
  return parsed;
}

/**
 * Manages the peer exchange protocol for a node.
 * Maintains a local peer table and syncs it with connected peers.
 */
/**
 * Compute the canonical signable bytes for a peer record.
 * Includes all fields except `signature`, sorted by key for determinism.
 */
function computePeerRecordSignableBytes(record: PeerRecord): Uint8Array {
  const { signature: _, ...rest } = record;
  const canonical = Object.keys(rest)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = (rest as Record<string, unknown>)[key];
      return acc;
    }, {});
  return new TextEncoder().encode(JSON.stringify(canonical));
}

export class PeerExchange {
  private libp2p: Libp2p;
  private peerTable = new Map<string, PeerRecord>();
  private localPeerId: string;
  private exchangeInterval: ReturnType<typeof setInterval> | null = null;
  /** Local private key for signing outbound peer records. */
  private localPrivateKey?: Uint8Array;
  /** Local public key hex for our own records. */
  private localPubkeyHex?: string;

  /** Max peers to store in the table */
  private maxPeers: number;

  /** Max age before a peer record is considered stale (30 min) */
  private maxPeerAge: number;

  /** How often to exchange peers (30 seconds) */
  private exchangeIntervalMs: number;

  constructor(
    libp2p: Libp2p,
    opts: {
      maxPeers?: number;
      maxPeerAge?: number;
      exchangeIntervalMs?: number;
      localPrivateKey?: Uint8Array;
      localPubkeyHex?: string;
    } = {},
  ) {
    this.libp2p = libp2p;
    this.localPeerId = libp2p.peerId.toString();
    this.maxPeers = opts.maxPeers ?? 500;
    this.maxPeerAge = opts.maxPeerAge ?? 30 * 60 * 1000;
    this.exchangeIntervalMs = opts.exchangeIntervalMs ?? 30_000;
    this.localPrivateKey = opts.localPrivateKey;
    this.localPubkeyHex = opts.localPubkeyHex;
  }

  /** Sign a peer record with the local private key. */
  async signRecord(record: PeerRecord): Promise<PeerRecord> {
    if (!this.localPrivateKey) return record;
    const signable = computePeerRecordSignableBytes(record);
    const sig = await edSign(this.localPrivateKey, signable);
    return { ...record, signature: Buffer.from(sig).toString('hex') };
  }

  /** Verify a peer record's signature against its pubkeyHex. Returns false if unsigned or invalid. */
  static async verifyRecord(record: PeerRecord): Promise<boolean> {
    if (!record.signature || !record.pubkeyHex) return false;
    try {
      const pubkey = hexToPublicKey(record.pubkeyHex);
      const signable = computePeerRecordSignableBytes(record);
      const sigBytes = new Uint8Array(Buffer.from(record.signature, 'hex'));
      return await edVerify(pubkey, sigBytes, signable);
    } catch {
      return false;
    }
  }

  /** Start the peer exchange protocol — register handler and begin periodic exchange. */
  async start(): Promise<void> {
    // Register as a protocol handler
    await this.libp2p.handle(PEER_EXCHANGE_PROTOCOL, async ({ stream }) => {
      await this.handleIncoming(stream);
    });

    // Start periodic exchange with connected peers
    this.exchangeInterval = setInterval(() => {
      this.exchangeWithPeers().catch(() => {
        // Swallow exchange errors — they're expected during churn
      });
    }, this.exchangeIntervalMs);
  }

  /** Stop the protocol handler and periodic exchange. */
  async stop(): Promise<void> {
    if (this.exchangeInterval) {
      clearInterval(this.exchangeInterval);
      this.exchangeInterval = null;
    }
    await this.libp2p.unhandle(PEER_EXCHANGE_PROTOCOL);
  }

  /** Maximum number of tags per peer record. */
  private static readonly MAX_TAGS_PER_PEER = 50;
  /** Maximum number of multiaddrs per peer record. */
  private static readonly MAX_ADDRS_PER_PEER = 10;
  /** Maximum string length for individual fields. */
  private static readonly MAX_FIELD_LENGTH = 512;

  /**
   * Validate a peer record before storing it.
   * Returns false for malformed or suspiciously large records.
   */
  private isValidRecord(record: PeerRecord): boolean {
    if (typeof record.peerId !== 'string' || record.peerId.length === 0 || record.peerId.length > PeerExchange.MAX_FIELD_LENGTH) return false;
    if (typeof record.pubkeyHex !== 'string' || record.pubkeyHex.length > PeerExchange.MAX_FIELD_LENGTH) return false;
    if (typeof record.lastSeen !== 'number' || !Number.isFinite(record.lastSeen)) return false;
    if (!Array.isArray(record.multiaddrs) || record.multiaddrs.length > PeerExchange.MAX_ADDRS_PER_PEER) return false;
    if (!Array.isArray(record.offeredTags) || record.offeredTags.length > PeerExchange.MAX_TAGS_PER_PEER) return false;

    for (const addr of record.multiaddrs) {
      if (typeof addr !== 'string' || addr.length > PeerExchange.MAX_FIELD_LENGTH) return false;
    }
    for (const tag of record.offeredTags) {
      if (typeof tag !== 'string' || tag.length > PeerExchange.MAX_FIELD_LENGTH) return false;
    }

    // Reject timestamps far in the future (> 5 min tolerance)
    if (record.lastSeen > Date.now() + 5 * 60_000) return false;

    return true;
  }

  /** Add or update a peer in our local table. Signed records are preferred. */
  addPeer(record: PeerRecord): void {
    if (record.peerId === this.localPeerId) return; // Don't track ourselves
    if (!this.isValidRecord(record)) return; // Reject malformed records

    const existing = this.peerTable.get(record.peerId);

    // If the existing record is signed and the new one isn't, keep the signed one
    if (existing?.signature && !record.signature) return;

    if (!existing || record.lastSeen > existing.lastSeen) {
      this.peerTable.set(record.peerId, record);
    }

    // Enforce max peers — evict oldest if over limit
    if (this.peerTable.size > this.maxPeers) {
      this.evictOldest();
    }
  }

  /** Add or update a peer after signature verification. Returns true if accepted. */
  async addPeerVerified(record: PeerRecord): Promise<boolean> {
    if (record.peerId === this.localPeerId) return false;
    if (!this.isValidRecord(record)) return false;

    // Require a valid signature on all remote peer records.
    // Without this, a malicious peer can inject fake addresses into the peer table
    // and redirect traffic to attacker-controlled nodes.
    if (!record.signature || !record.pubkeyHex) return false;
    const valid = await PeerExchange.verifyRecord(record);
    if (!valid) return false;

    const isNew = !this.peerTable.has(record.peerId);
    this.addPeer(record);

    // Attempt to dial newly discovered peers that we're not yet connected to
    if (isNew && record.multiaddrs.length > 0) {
      this.tryDial(record).catch(() => {
        // Dial failures are expected — peer may be offline or behind NAT
      });
    }

    return true;
  }

  /**
   * Attempt to dial a discovered peer using its multiaddrs.
   * Best-effort: failures are silently ignored since the peer may be unreachable.
   */
  private async tryDial(record: PeerRecord): Promise<void> {
    // Skip if already connected
    const alreadyConnected = this.libp2p.getPeers().some((p) => p.toString() === record.peerId);
    if (alreadyConnected) return;

    const { multiaddr } = await import('@multiformats/multiaddr');
    for (const addr of record.multiaddrs) {
      try {
        const ma = multiaddr(addr);
        await this.libp2p.dial(ma);
        return; // Success — stop trying other addrs
      } catch {
        // Try next addr
      }
    }
  }

  /** Remove a peer from the table. */
  removePeer(peerId: string): void {
    this.peerTable.delete(peerId);
  }

  /** Get all known peers. */
  getPeers(): PeerRecord[] {
    return [...this.peerTable.values()];
  }

  /** Get a specific peer record. */
  getPeer(peerId: string): PeerRecord | undefined {
    return this.peerTable.get(peerId);
  }

  /** Get peer count. */
  getPeerCount(): number {
    return this.peerTable.size;
  }

  /** Prune stale peers. Returns number pruned. */
  pruneStale(): number {
    const cutoff = Date.now() - this.maxPeerAge;
    let pruned = 0;
    for (const [peerId, record] of this.peerTable) {
      if (record.lastSeen < cutoff) {
        this.peerTable.delete(peerId);
        pruned++;
      }
    }
    return pruned;
  }

  /** Initiate a peer exchange with a specific peer. */
  async exchangeWithPeer(peerId: string): Promise<PeerRecord[]> {
    const peerIdObj = this.libp2p.getPeers().find((p) => p.toString() === peerId);
    if (!peerIdObj) return [];

    let stream: Stream;
    try {
      stream = await this.libp2p.dialProtocol(peerIdObj, PEER_EXCHANGE_PROTOCOL);
    } catch {
      return []; // Peer doesn't support the protocol
    }

    const request: PeerExchangeMessage = {
      type: 'request',
      peers: this.getPeersForExchange(),
      senderPeerId: this.localPeerId,
      timestamp: Date.now(),
    };

    const receivedPeers: PeerRecord[] = [];

    try {
      await pipe(
        [encode(request)],
        (source) => lp.encode(source),
        stream,
        (source) => lp.decode(source),
        async (source) => {
          for await (const msg of source) {
            const response = decode(msg.subarray());
            if (response.type === 'response') {
              for (const peer of response.peers) {
                const accepted = await this.addPeerVerified(peer);
                if (accepted) receivedPeers.push(peer);
              }
            }
          }
        },
      );
    } catch {
      // Stream error — expected during peer churn
    } finally {
      try { stream.close(); } catch { /* already closed */ }
    }

    return receivedPeers;
  }

  /** Maximum concurrent peer exchanges to prevent thundering herd. */
  private static readonly MAX_CONCURRENT_EXCHANGES = 5;

  /** Exchange peers with connected peers, capped at MAX_CONCURRENT_EXCHANGES concurrency. */
  private async exchangeWithPeers(): Promise<void> {
    this.pruneStale();

    const connectedPeers = this.libp2p.getPeers();
    if (connectedPeers.length === 0) return;

    // Select a random subset when there are more peers than our concurrency limit
    let selected = connectedPeers.map((p) => p.toString());
    if (selected.length > PeerExchange.MAX_CONCURRENT_EXCHANGES) {
      selected = selected.sort(() => Math.random() - 0.5).slice(0, PeerExchange.MAX_CONCURRENT_EXCHANGES);
    }

    const exchanges = selected.map((peerId) =>
      this.exchangeWithPeer(peerId).catch(() => [] as PeerRecord[]),
    );
    const results = await Promise.allSettled(exchanges);

    const succeeded = results.filter(
      (r) => r.status === 'fulfilled' && r.value.length > 0,
    ).length;
    if (succeeded === 0 && selected.length > 0) {
      console.warn(`[PeerExchange] All ${selected.length} peer exchange(s) returned no results`);
    }
  }

  /** Handle an incoming peer exchange request. */
  private async handleIncoming(stream: Stream): Promise<void> {
    const self = this;
    try {
      await pipe(
        stream,
        (source) => lp.decode(source),
        async function* (source: AsyncIterable<{ subarray(): Uint8Array }>) {
          for await (const msg of source) {
            const request = decode(msg.subarray());
            if (request.type === 'request') {
              // Merge their peers into our table (with signature verification)
              for (const peer of request.peers) {
                await self.addPeerVerified(peer);
              }

              // Send back our peer list
              const response: PeerExchangeMessage = {
                type: 'response',
                peers: self.getPeersForExchange(),
                senderPeerId: self.localPeerId,
                timestamp: Date.now(),
              };
              yield encode(response);
            }
          }
        },
        (source) => lp.encode(source),
        stream,
      );
    } catch {
      // Stream error — expected
    } finally {
      try { stream.close(); } catch { /* already closed */ }
    }
  }

  /** Get a subset of peers suitable for exchange (limit to avoid huge messages). */
  private getPeersForExchange(): PeerRecord[] {
    const peers = this.getPeers();
    // Send at most 50 peers per exchange
    if (peers.length <= 50) return peers;
    // Shuffle and take 50
    const shuffled = peers.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 50);
  }

  /** Evict the oldest peers when over maxPeers. */
  private evictOldest(): void {
    const sorted = [...this.peerTable.entries()].sort(
      (a, b) => a[1].lastSeen - b[1].lastSeen,
    );
    const toEvict = sorted.slice(0, Math.ceil(this.maxPeers * 0.1));
    for (const [peerId] of toEvict) {
      this.peerTable.delete(peerId);
    }
  }
}
