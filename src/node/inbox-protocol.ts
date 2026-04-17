/**
 * @module inbox-protocol
 *
 * Store-and-forward inbox protocol for the Leyline network.
 *
 * Protocol ID: /leyline/inbox/1.0.0
 *
 * When a peer connects, it can request any messages it missed while offline.
 * The request includes the topics the peer is subscribed to and a timestamp
 * of when it last received a message. The server (typically a seed node)
 * responds with all buffered messages for those topics since that timestamp.
 *
 * This protocol runs on seed nodes that buffer messages via MessageBuffer.
 * Regular nodes use it as a client to fetch missed messages on connect.
 */

import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import type { GossipSub } from '@chainsafe/libp2p-gossipsub';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { type BufferedMessage, type MessageBuffer } from './message-buffer.js';
import { withTimeout, STREAM_TIMEOUT_MS } from '../utils/stream-timeout.js';
import { Logger } from '../utils/logger.js';

export const INBOX_PROTOCOL = '/leyline/inbox/1.0.0';

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

interface InboxRequest {
  type: 'fetch';
  /** GossipSub topics the peer wants messages for. */
  topics: string[];
  /** Unix ms timestamp — only messages received after this are returned. */
  since: number;
  /** Max messages to return (client-side cap). */
  limit: number;
}

interface InboxResponse {
  type: 'messages';
  /** Buffered messages, oldest first. */
  messages: Array<{
    /** Base64-encoded serialized message bytes. */
    data: string;
    /** GossipSub topic. */
    topic: string;
    /** When the seed received this message. */
    receivedAt: number;
    /** Message ID hex. */
    id: string;
  }>;
  /** Total messages available (may exceed limit). */
  totalAvailable: number;
}

type InboxWireMessage = InboxRequest | InboxResponse;

function encode(msg: InboxWireMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

function decode(data: Uint8Array): InboxWireMessage {
  const parsed = JSON.parse(new TextDecoder().decode(data));
  if (typeof parsed.type !== 'string') {
    throw new TypeError('Malformed InboxWireMessage');
  }
  if (parsed.type === 'fetch') {
    if (!Array.isArray(parsed.topics)) parsed.topics = [];
    // Pre-cap BEFORE Set construction to prevent O(n) processing of huge arrays
    const raw = parsed.topics.slice(0, 200).filter((t: unknown) => typeof t === 'string');
    const unique = [...new Set<string>(raw)];
    parsed.topics = unique.slice(0, 100);
    parsed.since = typeof parsed.since === 'number' ? parsed.since : 0;
    parsed.limit = typeof parsed.limit === 'number' ? Math.min(Math.max(1, parsed.limit), 500) : 200;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Server side (seed nodes)
// ---------------------------------------------------------------------------

/**
 * Inbox server — runs on seed nodes to serve buffered messages to
 * reconnecting peers.
 */
export class InboxServer {
  private readonly libp2p: Libp2p;
  private readonly buffer: MessageBuffer;

  constructor(libp2p: Libp2p, buffer: MessageBuffer) {
    this.libp2p = libp2p;
    this.buffer = buffer;
  }

  async start(): Promise<void> {
    await this.libp2p.handle(INBOX_PROTOCOL, async ({ stream, connection }) => {
      const remotePeerId = connection.remotePeer.toString();
      await this.handleRequest(stream, remotePeerId);
    });
  }

  async stop(): Promise<void> {
    await this.libp2p.unhandle(INBOX_PROTOCOL);
  }

  /**
   * Get the set of GossipSub topics a remote peer is subscribed to.
   * Checks both current GossipSub state and any custom subscription
   * tracker (for peers that just reconnected and haven't propagated
   * subscriptions yet).
   */
  private getPeerSubscriptions(peerId: string): Set<string> {
    const subscribed = new Set<string>();

    // Check GossipSub state
    const gs = (this.libp2p.services as Record<string, unknown>).pubsub as GossipSub;
    for (const topic of gs.getTopics()) {
      const subscribers = gs.getSubscribers(topic);
      if (subscribers.some((p) => p.toString() === peerId)) {
        subscribed.add(topic);
      }
    }

    // Also check the custom subscription tracker if available
    if (this.subscriptionTracker) {
      const tracked = this.subscriptionTracker(peerId);
      for (const topic of tracked) {
        subscribed.add(topic);
      }
    }

    return subscribed;
  }

  /** Optional external subscription tracker (provided by SeedNode). */
  private subscriptionTracker?: (peerId: string) => Set<string>;

  /** Set an external subscription tracker for enhanced peer topic resolution. */
  setSubscriptionTracker(tracker: (peerId: string) => Set<string>): void {
    this.subscriptionTracker = tracker;
  }

  private async handleRequest(stream: Stream, remotePeerId: string): Promise<void> {
    // Get the topics this peer is subscribed to for authorization.
    // Uses both GossipSub state and the external subscription tracker
    // (provided by SeedNode) which persists subscriptions across reconnects.
    const peerTopics = this.getPeerSubscriptions(remotePeerId);

    try {
      await pipe(
        stream,
        (source) => lp.decode(source),
        (source) => withTimeout(source, STREAM_TIMEOUT_MS),
        async function* (this: InboxServer, source: AsyncIterable<{ subarray(): Uint8Array }>) {
          for await (const msg of source) {
            const req = decode(msg.subarray());
            if (req.type === 'fetch') {
              // Authorization: only serve topics the peer is subscribed to.
              // The subscription tracker (set by SeedNode) persists across
              // reconnects, so this covers the "just reconnected" case without
              // the security hole of allowing access to all buffered topics.
              const authorizedTopics = req.topics.filter((t: string) =>
                peerTopics.has(t),
              );

              const cap = Math.min(req.limit, 500);
              const messages = this.buffer.getForTopics(authorizedTopics, req.since, cap);

              const response: InboxResponse = {
                type: 'messages',
                messages: messages.map((m) => ({
                  data: Buffer.from(m.data).toString('base64'),
                  topic: m.topic,
                  receivedAt: m.receivedAt,
                  id: m.id,
                })),
                totalAvailable: messages.length,
              };

              yield encode(response);
            }
          }
        }.bind(this),
        (source) => lp.encode(source),
        stream,
      );
    } catch {
      // Stream error — expected during peer churn
    } finally {
      try { stream.close(); } catch { /* already closed */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Client side (regular nodes)
// ---------------------------------------------------------------------------

/**
 * Inbox client — runs on regular nodes to fetch missed messages from
 * seed nodes on connect.
 */
export class InboxClient {
  private readonly libp2p: Libp2p;
  private readonly log = new Logger('InboxClient');
  private readonly shutdownSignal?: AbortSignal;
  /** Timestamp of the last message we received (for "since" requests). */
  private lastReceivedAt: number = 0;

  constructor(libp2p: Libp2p, shutdownSignal?: AbortSignal) {
    this.libp2p = libp2p;
    this.shutdownSignal = shutdownSignal;
  }

  /** Update the last-received timestamp. Called by MagicNode on each message. */
  markReceived(timestamp: number): void {
    if (timestamp > this.lastReceivedAt) {
      this.lastReceivedAt = timestamp;
    }
  }

  /** Get the last-received timestamp. */
  getLastReceivedAt(): number {
    return this.lastReceivedAt;
  }

  /**
   * Fetch missed messages from a specific peer (typically a seed node).
   *
   * @param peerId - The seed node to request from.
   * @param topics - GossipSub topics to fetch messages for.
   * @param since  - Only messages after this timestamp. Defaults to lastReceivedAt.
   * @param limit  - Max messages to fetch. Defaults to 200.
   * @returns Array of buffered messages, or empty array on failure.
   */
  async fetch(
    peerId: string,
    topics: string[],
    since?: number,
    limit: number = 200,
  ): Promise<BufferedMessage[]> {
    const peerIdObj = this.libp2p.getPeers().find((p) => p.toString() === peerId);
    if (!peerIdObj) return [];

    let stream: Stream;
    try {
      stream = await this.libp2p.dialProtocol(peerIdObj, INBOX_PROTOCOL, { signal: this.shutdownSignal });
    } catch {
      return []; // Peer doesn't support inbox protocol
    }

    const request: InboxRequest = {
      type: 'fetch',
      topics,
      since: since ?? this.lastReceivedAt,
      limit,
    };

    const results: BufferedMessage[] = [];

    try {
      await pipe(
        [encode(request)],
        (source) => lp.encode(source),
        stream,
        (source) => lp.decode(source),
        (source) => withTimeout(source, STREAM_TIMEOUT_MS),
        async (source) => {
          for await (const msg of source) {
            const resp = decode(msg.subarray()) as InboxResponse;
            if (resp.type === 'messages') {
              for (const m of resp.messages) {
                results.push({
                  data: new Uint8Array(Buffer.from(m.data, 'base64')),
                  topic: m.topic,
                  receivedAt: m.receivedAt,
                  id: m.id,
                });
              }
              if (resp.totalAvailable > resp.messages.length) {
                this.log.info('Partial inbox fetch', { fetched: resp.messages.length, available: resp.totalAvailable, limit });
              }
            }
          }
        },
      );
    } catch {
      // Stream error
    } finally {
      try { stream.close(); } catch { /* already closed */ }
    }

    return results;
  }

  /**
   * Fetch missed messages from ALL connected peers (tries each seed).
   * Deduplicates by message ID across responses.
   */
  async fetchFromAllPeers(topics: string[], since?: number): Promise<BufferedMessage[]> {
    const peers = this.libp2p.getPeers();
    const allMessages: BufferedMessage[] = [];
    const seenIds = new Set<string>();

    for (const peer of peers) {
      const messages = await this.fetch(peer.toString(), topics, since);
      for (const msg of messages) {
        if (!seenIds.has(msg.id)) {
          seenIds.add(msg.id);
          allMessages.push(msg);
        }
      }
    }

    // Sort chronologically
    allMessages.sort((a, b) => a.receivedAt - b.receivedAt);
    return allMessages;
  }
}
