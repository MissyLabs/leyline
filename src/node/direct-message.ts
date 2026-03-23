import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { encryptPayload, decryptPayload } from '../crypto/envelope.js';
import { hexToPublicKey } from '../identity/keypair.js';

/**
 * Direct Message Protocol for the Leyline network.
 *
 * Delivers messages point-to-point using a dedicated libp2p stream protocol,
 * bypassing GossipSub entirely. Falls back to store-and-forward relay when a
 * direct connection to the target peer cannot be established.
 *
 * Protocol ID: /leyline/direct/1.0.0
 */

export const DIRECT_MESSAGE_PROTOCOL = '/leyline/direct/1.0.0';

/**
 * Wire envelope for a direct or relayed message.
 *
 * The `payload` field carries opaque serialized {@link MagicMessage} bytes so
 * that the routing layer stays decoupled from the message format.
 */
export interface DirectEnvelope {
  /** Serialized MagicMessage bytes (plaintext after decryption, or cleartext if unencrypted) */
  payload: Uint8Array;
  /** Target peer ID */
  targetPeerId: string;
  /** Sender peer ID */
  senderPeerId: string;
  /** Timestamp */
  timestamp: number;
  /** Whether this is a relay hop (not the final destination) */
  isRelay: boolean;
  /** Remaining hops for relay */
  hopsRemaining: number;
  /** Whether the payload is encrypted */
  encrypted: boolean;
  /** XChaCha20 nonce (24 bytes), present when encrypted */
  nonce?: Uint8Array;
  /** Sender's Ed25519 public key hex, present when encrypted (needed for decryption) */
  senderPubkeyHex?: string;
  /** Peer IDs that have already handled this envelope (prevents relay loops) */
  visitedPeers?: string[];
}

// ---------------------------------------------------------------------------
// Internal wire type — payload is base64 so it survives JSON round-trips
// ---------------------------------------------------------------------------

interface WireEnvelope {
  payload: string;
  targetPeerId: string;
  senderPeerId: string;
  timestamp: number;
  isRelay: boolean;
  hopsRemaining: number;
  encrypted: boolean;
  nonce?: string;
  senderPubkeyHex?: string;
  visitedPeers?: string[];
}

function encodeEnvelope(envelope: DirectEnvelope): Uint8Array {
  const wire: WireEnvelope = {
    payload: Buffer.from(envelope.payload).toString('base64'),
    targetPeerId: envelope.targetPeerId,
    senderPeerId: envelope.senderPeerId,
    timestamp: envelope.timestamp,
    isRelay: envelope.isRelay,
    hopsRemaining: envelope.hopsRemaining,
    encrypted: envelope.encrypted,
    nonce: envelope.nonce ? Buffer.from(envelope.nonce).toString('base64') : undefined,
    senderPubkeyHex: envelope.senderPubkeyHex,
    visitedPeers: envelope.visitedPeers,
  };
  return new TextEncoder().encode(JSON.stringify(wire));
}

function decodeEnvelope(data: Uint8Array): DirectEnvelope {
  const wire = JSON.parse(new TextDecoder().decode(data)) as WireEnvelope;

  if (
    typeof wire.payload !== 'string' ||
    typeof wire.targetPeerId !== 'string' ||
    typeof wire.senderPeerId !== 'string' ||
    typeof wire.timestamp !== 'number' ||
    typeof wire.isRelay !== 'boolean' ||
    typeof wire.hopsRemaining !== 'number'
  ) {
    throw new TypeError('Malformed DirectEnvelope: missing or incorrectly typed field(s)');
  }

  // Validate and sanitize fields to prevent type confusion from malicious peers
  const hopsRemaining = Math.max(0, Math.min(wire.hopsRemaining, 10));
  const visitedPeers = Array.isArray(wire.visitedPeers)
    ? wire.visitedPeers.filter((p): p is string => typeof p === 'string').slice(0, 50)
    : [];

  return {
    payload: new Uint8Array(Buffer.from(wire.payload, 'base64')),
    targetPeerId: wire.targetPeerId,
    senderPeerId: wire.senderPeerId,
    timestamp: wire.timestamp,
    isRelay: wire.isRelay,
    hopsRemaining,
    encrypted: wire.encrypted ?? false,
    nonce: wire.nonce ? new Uint8Array(Buffer.from(wire.nonce, 'base64')) : undefined,
    senderPubkeyHex: typeof wire.senderPubkeyHex === 'string' ? wire.senderPubkeyHex : undefined,
    visitedPeers,
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Interface for trust checking in direct messages (avoids circular dependency). */
export interface DirectMessageTrustChecker {
  /** Returns true if the sender is allowed to send direct messages. */
  isAllowed(pubkeyHex: string): boolean;
  /** Returns true if this message ID has already been seen. */
  isDuplicate(messageIdHex: string): boolean;
  /** Returns true if the sender is over the rate limit. */
  isRateLimited(pubkeyHex: string): boolean;
  /** Record a spam report. */
  reportSpam(pubkeyHex: string): void;
}

export interface DirectMessageOptions {
  /** Called when a message addressed to this node arrives (payload is decrypted). */
  onMessage?: (msg: DirectEnvelope) => void;
  /** Local Ed25519 private key for decrypting incoming messages. */
  localPrivateKey?: Uint8Array;
  /** Local Ed25519 public key hex for identifying the sender in encrypted envelopes. */
  localPubkeyHex?: string;
  /** Optional trust checker for validating incoming direct messages. */
  trustChecker?: DirectMessageTrustChecker;
}

// ---------------------------------------------------------------------------
// Protocol class
// ---------------------------------------------------------------------------

/**
 * Implements direct peer-to-peer messaging over a dedicated libp2p stream
 * protocol. When a direct connection to the target is unavailable the envelope
 * is forwarded through connected peers with a decrementing hop counter, giving
 * the network a best-effort relay capability.
 *
 * @example
 * ```ts
 * const dm = new DirectMessageProtocol(libp2p, {
 *   onMessage: (env) => console.log('received', env),
 * });
 * await dm.start();
 * const delivered = await dm.send(targetPeerId, payloadBytes);
 * ```
 */
export class DirectMessageProtocol {
  private readonly libp2p: Libp2p;
  private readonly opts: DirectMessageOptions;

  constructor(libp2p: Libp2p, opts: DirectMessageOptions = {}) {
    this.libp2p = libp2p;
    this.opts = opts;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Register the `/leyline/direct/1.0.0` protocol handler so this node can
   * receive incoming direct and relayed envelopes.
   */
  async start(): Promise<void> {
    await this.libp2p.handle(DIRECT_MESSAGE_PROTOCOL, async ({ stream }) => {
      await this.handleIncoming(stream);
    });
  }

  /** Unregister the protocol handler. */
  async stop(): Promise<void> {
    await this.libp2p.unhandle(DIRECT_MESSAGE_PROTOCOL);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Send `payload` directly to `targetPeerId`.
   *
   * When `recipientPubkeyHex` is provided and the local private key is
   * available, the payload is encrypted with X25519 + XChaCha20-Poly1305.
   * Otherwise falls back to cleartext.
   *
   * Attempts a direct stream dial first. If that fails, asks each connected
   * peer to relay the envelope (hop count = 3). Returns `false` only when
   * every attempt fails.
   *
   * @param targetPeerId       - libp2p peer ID string of the destination node.
   * @param payload            - Serialized {@link MagicMessage} bytes to deliver.
   * @param recipientPubkeyHex - Recipient's Ed25519 public key hex for encryption.
   * @returns `true` if the envelope was accepted by at least one path.
   */
  async send(
    targetPeerId: string,
    payload: Uint8Array,
    recipientPubkeyHex?: string,
  ): Promise<boolean> {
    let finalPayload = payload;
    let encrypted = false;
    let nonce: Uint8Array | undefined;

    // Encrypt if we have both our private key and the recipient's public key
    if (recipientPubkeyHex && this.opts.localPrivateKey) {
      const recipientPub = hexToPublicKey(recipientPubkeyHex);
      const result = encryptPayload(payload, this.opts.localPrivateKey, recipientPub);
      finalPayload = result.ciphertext;
      nonce = result.nonce;
      encrypted = true;
    }

    const localPeerId = this.libp2p.peerId.toString();
    const envelope: DirectEnvelope = {
      payload: finalPayload,
      targetPeerId,
      senderPeerId: localPeerId,
      timestamp: Date.now(),
      isRelay: false,
      hopsRemaining: 0,
      encrypted,
      nonce,
      // Always include sender pubkey so trust checks work for both encrypted and cleartext DMs
      senderPubkeyHex: this.opts.localPubkeyHex,
      visitedPeers: [localPeerId],
    };

    // 1. Try direct delivery.
    if (await this.deliverDirect(targetPeerId, envelope)) {
      return true;
    }

    // 2. Fall back to relay through connected peers.
    const relayEnvelope: DirectEnvelope = {
      ...envelope,
      isRelay: true,
      hopsRemaining: 3,
    };
    return this.forwardToRelays(relayEnvelope);
  }

  /**
   * Accept a relay request: decrement the hop counter and attempt onward
   * delivery. The envelope is dropped if `hopsRemaining` reaches zero.
   *
   * @param envelope - The envelope to relay; must have `isRelay === true`.
   * @returns `true` if the envelope was successfully forwarded.
   */
  async relay(envelope: DirectEnvelope): Promise<boolean> {
    const localPeerId = this.libp2p.peerId.toString();
    const visited = new Set(envelope.visitedPeers ?? []);

    // If we've already relayed this envelope, drop to prevent loops
    if (visited.has(localPeerId)) {
      return false;
    }
    visited.add(localPeerId);

    const decremented: DirectEnvelope = {
      ...envelope,
      hopsRemaining: envelope.hopsRemaining - 1,
      visitedPeers: [...visited],
    };

    if (decremented.hopsRemaining <= 0) {
      return false; // TTL exhausted — drop
    }

    // Try direct delivery to the target first.
    if (await this.deliverDirect(decremented.targetPeerId, decremented)) {
      return true;
    }

    // Forward to other connected peers, excluding all previously visited peers.
    return this.forwardToRelays(decremented);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Open a stream directly to `targetPeerId` and write `envelope`.
   * Returns `true` on success, `false` if the peer is unreachable or does not
   * support the protocol.
   */
  private async deliverDirect(
    targetPeerId: string,
    envelope: DirectEnvelope,
  ): Promise<boolean> {
    const peerIdObj = this.libp2p
      .getPeers()
      .find((p) => p.toString() === targetPeerId);

    if (!peerIdObj) {
      return false; // Not a currently connected peer
    }

    let stream: Stream;
    try {
      stream = await this.libp2p.dialProtocol(peerIdObj, DIRECT_MESSAGE_PROTOCOL);
    } catch {
      return false; // Peer doesn't support the protocol or connection failed
    }

    try {
      await pipe(
        [encodeEnvelope(envelope)],
        (source) => lp.encode(source),
        stream,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Forward `envelope` to all connected peers not in `visitedPeers`.
   * Returns `true` if at least one peer accepted the forwarded envelope.
   */
  private async forwardToRelays(
    envelope: DirectEnvelope,
  ): Promise<boolean> {
    const visited = new Set(envelope.visitedPeers ?? []);
    const candidates = this.libp2p
      .getPeers()
      .filter((p) => !visited.has(p.toString()));

    if (candidates.length === 0) {
      return false;
    }

    const results = await Promise.allSettled(
      candidates.map((peerIdObj) =>
        this.deliverDirect(peerIdObj.toString(), envelope),
      ),
    );

    return results.some(
      (r) => r.status === 'fulfilled' && r.value === true,
    );
  }

  /**
   * Handle an incoming stream carrying a {@link DirectEnvelope}.
   *
   * - If the envelope is addressed to this node, deliver it to `onMessage`.
   * - If the envelope is a relay hop addressed elsewhere, call {@link relay}.
   */
  private async handleIncoming(stream: Stream): Promise<void> {
    const localPeerId = this.libp2p.peerId.toString();

    try {
      await pipe(
        stream,
        (source) => lp.decode(source),
        async (source: AsyncIterable<{ subarray(): Uint8Array }>) => {
          for await (const msg of source) {
            let envelope: DirectEnvelope;
            try {
              envelope = decodeEnvelope(msg.subarray());
            } catch {
              continue; // Malformed envelope — skip
            }

            if (envelope.targetPeerId === localPeerId) {
              // Trust validation for direct messages
              if (this.opts.trustChecker) {
                // Reject DMs without sender identity — can't validate trust
                if (!envelope.senderPubkeyHex) continue;

                const checker = this.opts.trustChecker;
                // Dedup check using a hash of sender+timestamp+target as envelope ID
                const envelopeId = `dm:${envelope.senderPubkeyHex}:${envelope.timestamp}:${envelope.targetPeerId}`;
                if (checker.isDuplicate(envelopeId)) continue;
                // Rate limit check
                if (checker.isRateLimited(envelope.senderPubkeyHex)) {
                  checker.reportSpam(envelope.senderPubkeyHex);
                  continue;
                }
                // Trust check — for DMs we check agent-level allow (no tags)
                if (!checker.isAllowed(envelope.senderPubkeyHex)) continue;
              }

              // This message is for us — decrypt if encrypted.
              if (envelope.encrypted && envelope.nonce && envelope.senderPubkeyHex && this.opts.localPrivateKey) {
                try {
                  const senderPub = hexToPublicKey(envelope.senderPubkeyHex);
                  const plaintext = decryptPayload(
                    envelope.payload,
                    envelope.nonce,
                    this.opts.localPrivateKey,
                    senderPub,
                  );
                  envelope.payload = plaintext;
                } catch {
                  // Decryption failed (tampered, wrong key) — drop
                  continue;
                }
              }
              this.opts.onMessage?.(envelope);
            } else if (envelope.isRelay && envelope.hopsRemaining > 0) {
              // We are an intermediate relay hop.
              this.relay(envelope).catch(() => {
                // Relay failures are expected during churn — swallow
              });
            }
            // Envelopes with isRelay=false that aren't addressed to us are
            // dropped silently (misconfigured sender).
          }
        },
      );
    } catch {
      // Stream error — expected during peer churn
    } finally {
      try { stream.close(); } catch { /* already closed */ }
    }
  }
}
