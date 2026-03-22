import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';

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
  return JSON.parse(new TextDecoder().decode(data));
}

/**
 * Manages the peer exchange protocol for a node.
 * Maintains a local peer table and syncs it with connected peers.
 */
export class PeerExchange {
  private libp2p: Libp2p;
  private peerTable = new Map<string, PeerRecord>();
  private localPeerId: string;
  private exchangeInterval: ReturnType<typeof setInterval> | null = null;

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
    } = {},
  ) {
    this.libp2p = libp2p;
    this.localPeerId = libp2p.peerId.toString();
    this.maxPeers = opts.maxPeers ?? 500;
    this.maxPeerAge = opts.maxPeerAge ?? 30 * 60 * 1000;
    this.exchangeIntervalMs = opts.exchangeIntervalMs ?? 30_000;
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

  /** Add or update a peer in our local table. */
  addPeer(record: PeerRecord): void {
    if (record.peerId === this.localPeerId) return; // Don't track ourselves

    const existing = this.peerTable.get(record.peerId);
    if (!existing || record.lastSeen > existing.lastSeen) {
      this.peerTable.set(record.peerId, record);
    }

    // Enforce max peers — evict oldest if over limit
    if (this.peerTable.size > this.maxPeers) {
      this.evictOldest();
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
                this.addPeer(peer);
                receivedPeers.push(peer);
              }
            }
          }
        },
      );
    } catch {
      // Stream error — expected during peer churn
    }

    return receivedPeers;
  }

  /** Exchange peers with all currently connected peers. */
  private async exchangeWithPeers(): Promise<void> {
    this.pruneStale();

    const connectedPeers = this.libp2p.getPeers();
    const exchanges = connectedPeers.map((peerId) =>
      this.exchangeWithPeer(peerId.toString()).catch(() => []),
    );
    await Promise.allSettled(exchanges);
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
              // Merge their peers into our table
              for (const peer of request.peers) {
                self.addPeer(peer);
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
