/**
 * @module discovery-protocol
 *
 * Structured service discovery for the Leyline P2P network, implemented as a
 * dedicated libp2p stream protocol: `/leyline/discovery/1.0.0`.
 *
 * Wire framing follows the same length-prefixed pattern used by
 * {@link PeerExchange}: messages are JSON-encoded and wrapped with
 * `it-length-prefixed` so that multiple logical messages can safely share a
 * single bidirectional stream.
 *
 * Three message kinds flow over the protocol:
 *
 *  - **query** — sent by the initiator to ask a peer to search its registry.
 *  - **result** — sent by the responder with matching descriptors.
 *  - **advertisement** — sent by the initiator to push a descriptor to a peer
 *    without expecting a reply.
 */

import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';

import {
  type ServiceDescriptor,
  type DiscoveryQuery,
  type DiscoveryResult,
  ServiceRegistry,
} from './service-registry.js';
import { sign, verify, hexToPublicKey } from '../identity/keypair.js';
import { withTimeout, STREAM_TIMEOUT_MS } from '../utils/stream-timeout.js';

const MAX_RESULT_SERVICES = 100;

// ---------------------------------------------------------------------------
// Protocol ID
// ---------------------------------------------------------------------------

/** libp2p protocol identifier for the Leyline discovery protocol. */
export const DISCOVERY_PROTOCOL = '/leyline/discovery/1.0.0';

// ---------------------------------------------------------------------------
// Wire message types
// ---------------------------------------------------------------------------

/**
 * Discriminated union that represents every message that can be exchanged over
 * the discovery stream.
 */
type DiscoveryWireMessage =
  | {
      kind: 'query';
      query: DiscoveryQuery;
      requestId: string;
      senderPeerId: string;
      timestamp: number;
    }
  | {
      kind: 'result';
      requestId: string;
      result: DiscoveryResult;
    }
  | {
      kind: 'advertisement';
      descriptor: ServiceDescriptor;
      senderPeerId: string;
      timestamp: number;
    };

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Encode a wire message to UTF-8 JSON bytes. */
function encodeMsg(msg: DiscoveryWireMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

/** Decode UTF-8 JSON bytes back to a wire message with validation. */
function decodeMsg(data: Uint8Array): DiscoveryWireMessage {
  const parsed = JSON.parse(new TextDecoder().decode(data));
  if (typeof parsed.kind !== 'string') {
    throw new TypeError('Malformed DiscoveryWireMessage: missing kind');
  }
  return parsed as DiscoveryWireMessage;
}

/** Generate a short random request-correlation ID. */
function newRequestId(): string {
  // Use Math.random for a lightweight non-crypto correlation ID.
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// DiscoveryProtocol
// ---------------------------------------------------------------------------

/**
 * Manages the `/leyline/discovery/1.0.0` stream protocol for a node.
 *
 * **Initialisation**
 * ```ts
 * const registry = new ServiceRegistry();
 * const discovery = new DiscoveryProtocol(libp2p, registry, pubkeyHex, peerId);
 * await discovery.start();
 * ```
 *
 * **Querying peers**
 * ```ts
 * const results = await discovery.queryAllPeers({ tags: ['ai', 'image'] });
 * ```
 *
 * **Advertising a service**
 * ```ts
 * const descriptor = registry.register({ name: 'ImageGen', tags: ['ai', 'image'], ... });
 * await discovery.broadcastAdvertisement(descriptor);
 * ```
 */
/** Interface for trust checking in discovery (avoids circular dependency). */
export interface DiscoveryTrustChecker {
  /** Returns true if the provider is allowed (not blocked). */
  isAllowed(pubkeyHex: string): boolean;
}

/** Per-peer rate limiting for discovery requests. */
export interface DiscoveryRateLimitConfig {
  /** Maximum requests per window per peer (default 30). */
  maxRequestsPerWindow?: number;
  /** Window duration in milliseconds (default 60_000). */
  windowMs?: number;
}

export class DiscoveryProtocol {
  private readonly libp2p: Libp2p;
  private readonly registry: ServiceRegistry;
  private readonly localPubkeyHex: string;
  private readonly localPeerId: string;
  private readonly localPrivateKey: Uint8Array;
  private readonly trustChecker?: DiscoveryTrustChecker;

  /** Timer handle for the periodic prune task. */
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  /** How often to prune expired services (60 seconds). */
  private readonly pruneIntervalMs = 60_000;

  /** Per-peer request timestamps for rate limiting. */
  private readonly peerRequestTimes = new Map<string, number[]>();
  private readonly rateLimitConfig: Required<DiscoveryRateLimitConfig>;

  constructor(
    libp2p: Libp2p,
    registry: ServiceRegistry,
    localPubkeyHex: string,
    localPeerId: string,
    localPrivateKey: Uint8Array,
    trustChecker?: DiscoveryTrustChecker,
    rateLimitConfig?: DiscoveryRateLimitConfig,
  ) {
    this.libp2p = libp2p;
    this.registry = registry;
    this.localPubkeyHex = localPubkeyHex;
    this.localPeerId = localPeerId;
    this.localPrivateKey = localPrivateKey;
    this.trustChecker = trustChecker;
    this.rateLimitConfig = {
      maxRequestsPerWindow: rateLimitConfig?.maxRequestsPerWindow ?? 30,
      windowMs: rateLimitConfig?.windowMs ?? 60_000,
    };
  }

  /** Check and record a request from a peer. Returns false if rate-limited. */
  checkRateLimit(peerId: string): boolean {
    const now = Date.now();
    const windowStart = now - this.rateLimitConfig.windowMs;
    let times = this.peerRequestTimes.get(peerId);
    if (!times) {
      times = [];
      this.peerRequestTimes.set(peerId, times);
    }
    // Evict timestamps outside window
    while (times.length > 0 && times[0] < windowStart) {
      times.shift();
    }
    if (times.length >= this.rateLimitConfig.maxRequestsPerWindow) {
      return false;
    }
    times.push(now);
    return true;
  }

  /**
   * Compute the canonical signable bytes for a service descriptor.
   * Includes all fields except `signature` itself, sorted by key for determinism.
   */
  static computeSignableBytes(descriptor: ServiceDescriptor): Uint8Array {
    const { signature: _, ...rest } = descriptor;
    const canonical = Object.keys(rest)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (rest as Record<string, unknown>)[key];
        return acc;
      }, {});
    return new TextEncoder().encode(JSON.stringify(canonical));
  }

  /** Sign a descriptor with the local private key. */
  async signDescriptor(descriptor: ServiceDescriptor): Promise<ServiceDescriptor> {
    const signable = DiscoveryProtocol.computeSignableBytes(descriptor);
    const sig = await sign(this.localPrivateKey, signable);
    return { ...descriptor, signature: Buffer.from(sig).toString('hex') };
  }

  /** Verify a descriptor's signature against its providerPubkey. Returns false if unsigned or invalid. */
  static async verifyDescriptor(descriptor: ServiceDescriptor): Promise<boolean> {
    if (!descriptor.signature) return false;
    try {
      const pubkey = hexToPublicKey(descriptor.providerPubkey);
      const signable = DiscoveryProtocol.computeSignableBytes(descriptor);
      const sigBytes = new Uint8Array(Buffer.from(descriptor.signature, 'hex'));
      return await verify(pubkey, sigBytes, signable);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Register the protocol handler with libp2p and start the periodic prune
   * timer.
   */
  async start(): Promise<void> {
    await this.libp2p.handle(DISCOVERY_PROTOCOL, async ({ stream, connection }) => {
      const remotePeerId = connection.remotePeer.toString();
      await this.handleIncoming(stream, remotePeerId);
    });

    this.pruneTimer = setInterval(() => {
      const pruned = this.registry.pruneExpired();
      if (pruned > 0) {
        console.log(`[Discovery] Pruned ${pruned} expired service(s)`);
      }
    }, this.pruneIntervalMs);
  }

  /**
   * Unregister the protocol handler and stop the prune timer.
   */
  async stop(): Promise<void> {
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.peerRequestTimes.clear();

    await this.libp2p.unhandle(DISCOVERY_PROTOCOL);
  }

  // ---------------------------------------------------------------------------
  // Outbound operations
  // ---------------------------------------------------------------------------

  /**
   * Send a discovery query to a specific peer and return the matching
   * descriptors it reports.
   *
   * The method opens a new stream to the target peer, writes the query, reads
   * back the result frame, then closes the stream.
   *
   * @param peerId - String representation of the target peer's ID.
   * @param query  - Search predicate to forward.
   * @returns The list of {@link ServiceDescriptor} records returned by the peer.
   *          Returns an empty array when the peer is unreachable or does not
   *          support the protocol.
   */
  async queryPeer(peerId: string, query: DiscoveryQuery): Promise<ServiceDescriptor[]> {
    const peerIdObj = this.libp2p.getPeers().find((p) => p.toString() === peerId);
    if (peerIdObj === undefined) return [];

    let stream: Stream;
    try {
      stream = await this.libp2p.dialProtocol(peerIdObj, DISCOVERY_PROTOCOL);
    } catch {
      return []; // Peer unreachable or does not support the protocol.
    }

    const requestId = newRequestId();
    const queryMsg: DiscoveryWireMessage = {
      kind: 'query',
      query,
      requestId,
      senderPeerId: this.localPeerId,
      timestamp: Date.now(),
    };

    const collected: ServiceDescriptor[] = [];

    try {
      await pipe(
        [encodeMsg(queryMsg)],
        (source) => lp.encode(source),
        stream,
        (source) => lp.decode(source),
        (source) => withTimeout(source, STREAM_TIMEOUT_MS),
        async (source) => {
          for await (const chunk of source) {
            const msg = decodeMsg(chunk.subarray());
            if (msg.kind === 'result' && msg.requestId === requestId) {
              const services = msg.result.services.slice(0, MAX_RESULT_SERVICES);
              for (const descriptor of services) {
                // Skip services from blocked providers
                if (this.trustChecker && !this.trustChecker.isAllowed(descriptor.providerPubkey)) {
                  continue;
                }
                const valid = await DiscoveryProtocol.verifyDescriptor(descriptor);
                if (valid) {
                  this.registry.addRemote(descriptor);
                  collected.push(descriptor);
                }
              }
            }
          }
        },
      );
    } catch {
      // Stream errors are expected during peer churn; return what we have.
    }

    return collected;
  }

  /**
   * Query every currently connected peer concurrently and merge all results.
   *
   * Duplicate descriptors (same `id`) from multiple peers are deduplicated;
   * the first-seen copy is retained.
   *
   * @param query - Search predicate forwarded to every peer.
   * @returns Deduplicated union of all peers' matching descriptors.
   */
  async queryAllPeers(query: DiscoveryQuery): Promise<ServiceDescriptor[]> {
    const connectedPeers = this.libp2p.getPeers();

    const perPeerResults = await Promise.allSettled(
      connectedPeers.map((p) => this.queryPeer(p.toString(), query)),
    );

    const seen = new Set<string>();
    const merged: ServiceDescriptor[] = [];

    for (const outcome of perPeerResults) {
      if (outcome.status !== 'fulfilled') continue;
      for (const descriptor of outcome.value) {
        if (!seen.has(descriptor.id)) {
          seen.add(descriptor.id);
          merged.push(descriptor);
        }
      }
    }

    return merged;
  }

  /**
   * Push a service advertisement to every currently connected peer.
   *
   * Each peer receives a one-way `advertisement` frame; no reply is expected.
   * The call resolves once all push attempts have settled (successes and
   * failures alike).
   *
   * @param descriptor - The {@link ServiceDescriptor} to broadcast.
   */
  async broadcastAdvertisement(descriptor: ServiceDescriptor): Promise<void> {
    const connectedPeers = this.libp2p.getPeers();

    const pushes = connectedPeers.map(async (peerIdObj) => {
      let stream: Stream;
      try {
        stream = await this.libp2p.dialProtocol(peerIdObj, DISCOVERY_PROTOCOL);
      } catch {
        return; // Peer unreachable — skip silently.
      }

      const adMsg: DiscoveryWireMessage = {
        kind: 'advertisement',
        descriptor,
        senderPeerId: this.localPeerId,
        timestamp: Date.now(),
      };

      try {
        await pipe(
          [encodeMsg(adMsg)],
          (source) => lp.encode(source),
          stream,
          (source) => withTimeout(source, STREAM_TIMEOUT_MS),
          async (source) => {
            for await (const _ of source) { /* intentional no-op */ }
          },
        );
      } catch {
        // Ignore individual stream errors.
      }
    });

    await Promise.allSettled(pushes);
  }

  // ---------------------------------------------------------------------------
  // Inbound handler
  // ---------------------------------------------------------------------------

  /**
   * Handle an incoming stream opened by a remote peer.
   *
   * Reads the first frame from the stream and dispatches based on its `kind`:
   * - `query` — runs the query against the local registry and writes a result
   *   frame back.
   * - `advertisement` — merges the descriptor into the local registry; writes
   *   no reply.
   * - `result` — unexpected as an inbound opener; ignored.
   */
  private async handleIncoming(stream: Stream, remotePeerId: string): Promise<void> {
    const self = this;

    try {
      await pipe(
        stream,
        (source) => lp.decode(source),
        (source) => withTimeout(source, STREAM_TIMEOUT_MS),
        async function* (
          source: AsyncIterable<{ subarray(): Uint8Array }>,
        ): AsyncIterable<Uint8Array> {
          for await (const chunk of source) {
            const msg = decodeMsg(chunk.subarray());

            if (!self.checkRateLimit(remotePeerId)) {
              break;
            }

            if (msg.kind === 'query') {
              // Search local registry and respond, capped to prevent amplification
              const cappedQuery = {
                ...msg.query,
                limit: Math.min(msg.query.limit ?? 100, 100),
              };
              const matches = self.registry.query(cappedQuery);

              const result: DiscoveryResult = {
                services: matches,
                responderId: self.localPeerId,
                timestamp: Date.now(),
              };

              const reply: DiscoveryWireMessage = {
                kind: 'result',
                requestId: msg.requestId,
                result,
              };

              yield encodeMsg(reply);

            } else if (msg.kind === 'advertisement') {
              // Skip advertisements from blocked providers
              if (self.trustChecker && !self.trustChecker.isAllowed(msg.descriptor.providerPubkey)) {
                continue;
              }
              // Verify signature before merging into our registry.
              const valid = await DiscoveryProtocol.verifyDescriptor(msg.descriptor);
              if (valid) {
                self.registry.addRemote(msg.descriptor);
              }
              // No reply sent — the generator produces nothing for this branch.
            }
            // 'result' frames are never expected as inbound openers; ignore.
          }
        },
        (source) => lp.encode(source),
        stream,
      );
    } catch {
      // Stream errors are expected during normal peer churn.
    } finally {
      try { stream.close(); } catch { /* already closed */ }
    }
  }
}
