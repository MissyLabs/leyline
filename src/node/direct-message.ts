import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';

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
  /** Serialized MagicMessage bytes */
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
}

function encodeEnvelope(envelope: DirectEnvelope): Uint8Array {
  const wire: WireEnvelope = {
    payload: Buffer.from(envelope.payload).toString('base64'),
    targetPeerId: envelope.targetPeerId,
    senderPeerId: envelope.senderPeerId,
    timestamp: envelope.timestamp,
    isRelay: envelope.isRelay,
    hopsRemaining: envelope.hopsRemaining,
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

  return {
    payload: new Uint8Array(Buffer.from(wire.payload, 'base64')),
    targetPeerId: wire.targetPeerId,
    senderPeerId: wire.senderPeerId,
    timestamp: wire.timestamp,
    isRelay: wire.isRelay,
    hopsRemaining: wire.hopsRemaining,
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DirectMessageOptions {
  /** Called when a message addressed to this node arrives. */
  onMessage?: (msg: DirectEnvelope) => void;
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
   * Attempts a direct stream dial first. If that fails, asks each connected
   * peer to relay the envelope (hop count = 3). Returns `false` only when
   * every attempt fails.
   *
   * @param targetPeerId - libp2p peer ID string of the destination node.
   * @param payload      - Serialized {@link MagicMessage} bytes to deliver.
   * @returns `true` if the envelope was accepted by at least one path.
   */
  async send(targetPeerId: string, payload: Uint8Array): Promise<boolean> {
    const envelope: DirectEnvelope = {
      payload,
      targetPeerId,
      senderPeerId: this.libp2p.peerId.toString(),
      timestamp: Date.now(),
      isRelay: false,
      hopsRemaining: 0,
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
    return this.forwardToRelays(relayEnvelope, null);
  }

  /**
   * Accept a relay request: decrement the hop counter and attempt onward
   * delivery. The envelope is dropped if `hopsRemaining` reaches zero.
   *
   * @param envelope - The envelope to relay; must have `isRelay === true`.
   * @returns `true` if the envelope was successfully forwarded.
   */
  async relay(envelope: DirectEnvelope): Promise<boolean> {
    const decremented: DirectEnvelope = {
      ...envelope,
      hopsRemaining: envelope.hopsRemaining - 1,
    };

    if (decremented.hopsRemaining <= 0) {
      return false; // TTL exhausted — drop
    }

    // Try direct delivery to the target first.
    if (await this.deliverDirect(decremented.targetPeerId, decremented)) {
      return true;
    }

    // Forward to other connected peers, excluding the original sender so we
    // don't loop the envelope back.
    return this.forwardToRelays(decremented, decremented.senderPeerId);
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
   * Forward `envelope` to all connected peers except `excludePeerId`.
   * Returns `true` if at least one peer accepted the forwarded envelope.
   */
  private async forwardToRelays(
    envelope: DirectEnvelope,
    excludePeerId: string | null,
  ): Promise<boolean> {
    const candidates = this.libp2p
      .getPeers()
      .filter((p) => p.toString() !== excludePeerId);

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
              // This message is for us.
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
    }
  }
}
