/**
 * @module handshake-protocol
 *
 * Version handshake protocol for the Leyline network.
 *
 * Protocol ID: /leyline/handshake/1.0.0
 *
 * When a peer connects, both sides exchange version information.
 * The responder checks compatibility and returns a result with
 * an upgrade message if the peer is too old.
 *
 * This runs automatically on every new peer connection. Seeds
 * use it to track version distribution across the network.
 */

import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import {
  LEYLINE_VERSION,
  COMPAT,
  checkCompat,
  type CompatResult,
} from '../config/compat.js';

export const HANDSHAKE_PROTOCOL = '/leyline/handshake/1.0.0';

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

interface HandshakeRequest {
  type: 'hello';
  version: string;
  minVersion: string;
}

interface HandshakeResponse {
  type: 'welcome';
  version: string;
  minVersion: string;
  compatible: boolean;
  deprecated: boolean;
  message: string;
}

type HandshakeMessage = HandshakeRequest | HandshakeResponse;

function encode(msg: HandshakeMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

function decode(data: Uint8Array): HandshakeMessage {
  const parsed = JSON.parse(new TextDecoder().decode(data));
  if (typeof parsed.type !== 'string') {
    throw new TypeError('Malformed HandshakeMessage');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface HandshakeEvents {
  /** Fired when a peer's version has been verified. */
  onPeerVersion?: (peerId: string, version: string, result: CompatResult) => void;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/**
 * Version handshake protocol. Registers as a libp2p stream handler
 * and initiates handshakes with new peers on connect.
 */
export class HandshakeProtocol {
  private readonly libp2p: Libp2p;
  private readonly events: HandshakeEvents;

  /** Tracked peer versions: peerId → version string */
  private readonly peerVersions = new Map<string, string>();

  /** Peers that failed compat check: peerId → rejection message */
  private readonly incompatiblePeers = new Set<string>();
  /** Tracked per-peer timeouts for cleanup on stop(). */
  private readonly pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  private connectHandler: ((evt: CustomEvent) => void) | null = null;

  constructor(libp2p: Libp2p, events: HandshakeEvents = {}) {
    this.libp2p = libp2p;
    this.events = events;
  }

  async start(): Promise<void> {
    // Register as responder
    await this.libp2p.handle(HANDSHAKE_PROTOCOL, async ({ stream, connection }) => {
      const remotePeerId = connection.remotePeer.toString();
      await this.handleIncoming(stream, remotePeerId);
    });

    // Initiate handshake with every new peer
    this.connectHandler = (evt: CustomEvent) => {
      const peerId = evt.detail.toString();
      // Small delay to let the connection stabilize
      const timer = setTimeout(() => {
        this.pendingTimeouts.delete(timer);
        if (this.stopped) return;
        this.initiateHandshake(peerId).catch(() => {
          // Peer may not support handshake protocol (old version) — that's informative too
          if (!this.peerVersions.has(peerId)) {
            this.peerVersions.set(peerId, 'unknown');
            const result = checkCompat('0.0.0');
            this.events.onPeerVersion?.(peerId, 'unknown', result);
          }
        });
      }, 1000);
      this.pendingTimeouts.add(timer);
    };
    this.libp2p.addEventListener('peer:connect', this.connectHandler);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.pendingTimeouts) {
      clearTimeout(timer);
    }
    this.pendingTimeouts.clear();
    if (this.connectHandler) {
      this.libp2p.removeEventListener('peer:connect', this.connectHandler);
      this.connectHandler = null;
    }
    await this.libp2p.unhandle(HANDSHAKE_PROTOCOL);
  }

  /** Get the version of a connected peer, or 'unknown'. */
  getPeerVersion(peerId: string): string {
    return this.peerVersions.get(peerId) ?? 'unknown';
  }

  /** Get all tracked peer versions. */
  getAllPeerVersions(): Map<string, string> {
    return new Map(this.peerVersions);
  }

  /** Get version distribution stats: version → count. */
  getVersionStats(): Map<string, number> {
    const stats = new Map<string, number>();
    for (const version of this.peerVersions.values()) {
      stats.set(version, (stats.get(version) ?? 0) + 1);
    }
    return stats;
  }

  /** Check if a peer is known to be incompatible. */
  isIncompatible(peerId: string): boolean {
    return this.incompatiblePeers.has(peerId);
  }

  /** Remove tracking for a disconnected peer. */
  removePeer(peerId: string): void {
    this.peerVersions.delete(peerId);
    this.incompatiblePeers.delete(peerId);
  }

  // --------------------------------------------------------------------------
  // Initiator side
  // --------------------------------------------------------------------------

  private async initiateHandshake(peerId: string): Promise<void> {
    const peerIdObj = this.libp2p.getPeers().find((p) => p.toString() === peerId);
    if (!peerIdObj) return;

    let stream: Stream;
    try {
      stream = await this.libp2p.dialProtocol(peerIdObj, HANDSHAKE_PROTOCOL);
    } catch {
      return; // Peer doesn't support handshake
    }

    const hello: HandshakeRequest = {
      type: 'hello',
      version: LEYLINE_VERSION,
      minVersion: COMPAT.minVersion,
    };

    try {
      await pipe(
        [encode(hello)],
        (source) => lp.encode(source),
        stream,
        (source) => lp.decode(source),
        async (source) => {
          for await (const msg of source) {
            const resp = decode(msg.subarray()) as HandshakeResponse;
            if (resp.type === 'welcome') {
              this.peerVersions.set(peerId, resp.version);

              // Check if THEY think WE'RE compatible
              if (!resp.compatible) {
                console.error(`[Handshake] REJECTED by ${peerId.slice(0, 16)}...: ${resp.message}`);
              } else if (resp.deprecated) {
                console.warn(`[Handshake] DEPRECATION WARNING from ${peerId.slice(0, 16)}...: ${resp.message}`);
              }

              // Check if WE think THEY'RE compatible
              const ourCheck = checkCompat(resp.version);
              if (!ourCheck.compatible) {
                this.incompatiblePeers.add(peerId);
                console.warn(`[Handshake] Peer ${peerId.slice(0, 16)}... version ${resp.version} is incompatible: ${ourCheck.message}`);
              } else if (ourCheck.deprecated) {
                console.log(`[Handshake] Peer ${peerId.slice(0, 16)}... version ${resp.version} is deprecated`);
              }

              this.events.onPeerVersion?.(peerId, resp.version, ourCheck);
            }
          }
        },
      );
    } catch {
      // Stream error
    } finally {
      try { stream.close(); } catch { /* already closed */ }
    }
  }

  // --------------------------------------------------------------------------
  // Responder side
  // --------------------------------------------------------------------------

  private async handleIncoming(stream: Stream, remotePeerId: string): Promise<void> {
    const self = this;
    try {
      await pipe(
        stream,
        (source) => lp.decode(source),
        async function* (source: AsyncIterable<{ subarray(): Uint8Array }>) {
          for await (const msg of source) {
            const req = decode(msg.subarray()) as HandshakeRequest;
            if (req.type === 'hello') {
              // Track their version
              self.peerVersions.set(remotePeerId, req.version);

              // Check their version against our compat matrix
              const result = checkCompat(req.version);

              if (!result.compatible) {
                self.incompatiblePeers.add(remotePeerId);
                console.warn(`[Handshake] Incompatible peer ${remotePeerId.slice(0, 16)}... version ${req.version}: ${result.message}`);
              } else if (result.deprecated) {
                console.log(`[Handshake] Deprecated peer ${remotePeerId.slice(0, 16)}... version ${req.version}`);
              }

              self.events.onPeerVersion?.(remotePeerId, req.version, result);

              // Check our version against THEIR minVersion
              const theyThinkWeAre = checkCompat(LEYLINE_VERSION);

              const response: HandshakeResponse = {
                type: 'welcome',
                version: LEYLINE_VERSION,
                minVersion: COMPAT.minVersion,
                compatible: result.compatible,
                deprecated: result.deprecated,
                message: result.message,
              };

              yield encode(response);
            }
          }
        },
        (source) => lp.encode(source),
        stream,
      );
    } catch {
      // Stream error
    } finally {
      try { stream.close(); } catch { /* already closed */ }
    }
  }
}
