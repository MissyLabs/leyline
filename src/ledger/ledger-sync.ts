import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { SharedLedger, type SharedLedgerEntry } from './shared-ledger.js';
import { verify } from '../identity/keypair.js';

/**
 * Shared Ledger Sync Protocol for the Leyline network.
 *
 * Peers sync their shared ledger state using a request/response protocol.
 * Supports:
 * - Range requests: "give me entries from index X to Y"
 * - Push: broadcast new entries for peer confirmation
 * - Confirmation: peers validate and confirm entries they receive
 *
 * Protocol ID: /leyline/ledger-sync/1.0.0
 */

export const LEDGER_SYNC_PROTOCOL = '/leyline/ledger-sync/1.0.0';

type SyncMessageType = 'range-request' | 'range-response' | 'push-entry' | 'confirm-entry';

interface SyncMessage {
  type: SyncMessageType;
  senderPeerId: string;
  timestamp: number;
}

interface RangeRequest extends SyncMessage {
  type: 'range-request';
  startIndex: number;
  endIndex: number;
}

interface RangeResponse extends SyncMessage {
  type: 'range-response';
  entries: SerializedEntry[];
  totalEntries: number;
}

interface PushEntry extends SyncMessage {
  type: 'push-entry';
  entry: SerializedEntry;
}

interface ConfirmEntry extends SyncMessage {
  type: 'confirm-entry';
  entryIndex: number;
  confirmerPubkey: string; // hex
}

/** JSON-safe entry for wire transfer */
interface SerializedEntry {
  index: number;
  prevHash: string;
  hash: string;
  data: string;
  submitterPubkey: string;
  signature: string;
  timestamp: number;
  confirmations: number;
  confirmerPubkeys: string[];
}

type AnySyncMessage = RangeRequest | RangeResponse | PushEntry | ConfirmEntry;

function toHex(arr: Uint8Array): string {
  return Buffer.from(arr).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function serializeEntry(entry: SharedLedgerEntry): SerializedEntry {
  return {
    index: entry.index,
    prevHash: toHex(entry.prevHash),
    hash: toHex(entry.hash),
    data: toHex(entry.data),
    submitterPubkey: toHex(entry.submitterPubkey),
    signature: toHex(entry.signature),
    timestamp: entry.timestamp,
    confirmations: entry.confirmations,
    confirmerPubkeys: entry.confirmerPubkeys.map(toHex),
  };
}

function deserializeEntry(se: SerializedEntry): SharedLedgerEntry {
  return {
    index: se.index,
    prevHash: fromHex(se.prevHash),
    hash: fromHex(se.hash),
    data: fromHex(se.data),
    submitterPubkey: fromHex(se.submitterPubkey),
    signature: fromHex(se.signature),
    timestamp: se.timestamp,
    confirmations: se.confirmations,
    confirmerPubkeys: se.confirmerPubkeys.map(fromHex),
  };
}

function encode(msg: AnySyncMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

function decode(data: Uint8Array): AnySyncMessage {
  return JSON.parse(new TextDecoder().decode(data));
}

export interface LedgerSyncEvents {
  onEntryReceived?: (entry: SharedLedgerEntry) => void;
  onEntryConfirmed?: (index: number, confirmerPubkey: string) => void;
  onSyncComplete?: (peerId: string, entriesReceived: number) => void;
}

/**
 * Manages shared ledger synchronization between peers.
 */
export class LedgerSync {
  private libp2p: Libp2p;
  private ledger: SharedLedger;
  private localPeerId: string;
  private localPubkey: Uint8Array;
  private localPrivkey: Uint8Array;
  private events: LedgerSyncEvents;
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  /** How often to attempt sync with peers (60 seconds) */
  private syncIntervalMs: number;

  constructor(
    libp2p: Libp2p,
    ledger: SharedLedger,
    localPubkey: Uint8Array,
    localPrivkey: Uint8Array,
    opts: {
      syncIntervalMs?: number;
      events?: LedgerSyncEvents;
    } = {},
  ) {
    this.libp2p = libp2p;
    this.ledger = ledger;
    this.localPeerId = libp2p.peerId.toString();
    this.localPubkey = localPubkey;
    this.localPrivkey = localPrivkey;
    this.syncIntervalMs = opts.syncIntervalMs ?? 60_000;
    this.events = opts.events ?? {};
  }

  async start(): Promise<void> {
    // Register protocol handler
    await this.libp2p.handle(LEDGER_SYNC_PROTOCOL, async ({ stream }) => {
      await this.handleIncoming(stream);
    });

    // Start periodic sync
    this.syncInterval = setInterval(() => {
      this.syncWithAllPeers().catch(() => {});
    }, this.syncIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    await this.libp2p.unhandle(LEDGER_SYNC_PROTOCOL);
  }

  /**
   * Request a range of ledger entries from a specific peer.
   */
  async requestRange(peerId: string, startIndex: number, endIndex: number): Promise<SharedLedgerEntry[]> {
    const peerIdObj = this.libp2p.getPeers().find((p) => p.toString() === peerId);
    if (!peerIdObj) return [];

    let stream: Stream;
    try {
      stream = await this.libp2p.dialProtocol(peerIdObj, LEDGER_SYNC_PROTOCOL);
    } catch {
      return [];
    }

    const request: RangeRequest = {
      type: 'range-request',
      senderPeerId: this.localPeerId,
      timestamp: Date.now(),
      startIndex,
      endIndex,
    };

    const entries: SharedLedgerEntry[] = [];

    try {
      await pipe(
        [encode(request)],
        (source) => lp.encode(source),
        stream,
        (source) => lp.decode(source),
        async (source) => {
          for await (const msg of source) {
            const response = decode(msg.subarray()) as RangeResponse;
            if (response.type === 'range-response') {
              for (const se of response.entries) {
                const entry = deserializeEntry(se);
                entries.push(entry);
                this.events.onEntryReceived?.(entry);
              }
            }
          }
        },
      );
    } catch {
      // Stream error
    }

    return entries;
  }

  /**
   * Push a new entry to a specific peer for their confirmation.
   */
  async pushEntry(peerId: string, entry: SharedLedgerEntry): Promise<void> {
    const peerIdObj = this.libp2p.getPeers().find((p) => p.toString() === peerId);
    if (!peerIdObj) return;

    let stream: Stream;
    try {
      stream = await this.libp2p.dialProtocol(peerIdObj, LEDGER_SYNC_PROTOCOL);
    } catch {
      return;
    }

    const msg: PushEntry = {
      type: 'push-entry',
      senderPeerId: this.localPeerId,
      timestamp: Date.now(),
      entry: serializeEntry(entry),
    };

    try {
      await pipe(
        [encode(msg)],
        (source) => lp.encode(source),
        stream,
      );
    } catch {
      // Stream error
    }
  }

  /**
   * Push an entry to all connected peers.
   */
  async broadcastEntry(entry: SharedLedgerEntry): Promise<void> {
    const peers = this.libp2p.getPeers();
    await Promise.allSettled(
      peers.map((p) => this.pushEntry(p.toString(), entry)),
    );
  }

  /**
   * Sync with all connected peers — request any entries we're missing.
   */
  async syncWithAllPeers(): Promise<void> {
    const localCount = await this.ledger.getEntryCount();
    const peers = this.libp2p.getPeers();

    for (const peerId of peers) {
      try {
        // Request entries beyond what we have
        const entries = await this.requestRange(
          peerId.toString(),
          localCount + 1,
          localCount + 100, // Request up to 100 entries at a time
        );

        // Validate and ingest received entries
        let ingested = 0;
        for (const entry of entries) {
          const valid = await this.validateReceivedEntry(entry);
          if (valid) {
            // Submit to our local shared ledger
            await this.ledger.submit(
              entry.data,
              entry.submitterPubkey,
              entry.signature,
            );
            ingested++;
          }
        }

        if (ingested > 0) {
          this.events.onSyncComplete?.(peerId.toString(), ingested);
        }
      } catch {
        // Individual peer sync failure — continue with others
      }
    }
  }

  /**
   * Validate a received shared ledger entry.
   * Checks the submitter's signature over the data.
   */
  private async validateReceivedEntry(entry: SharedLedgerEntry): Promise<boolean> {
    try {
      // Verify the submitter's signature over the data
      const isValid = await verify(entry.submitterPubkey, entry.signature, entry.data);
      return isValid;
    } catch {
      return false;
    }
  }

  /**
   * Handle incoming sync protocol messages.
   */
  private async handleIncoming(stream: Stream): Promise<void> {
    const self = this;
    try {
      await pipe(
        stream,
        (source) => lp.decode(source),
        async function* (source: AsyncIterable<{ subarray(): Uint8Array }>) {
          for await (const msg of source) {
            const syncMsg = decode(msg.subarray());

            switch (syncMsg.type) {
              case 'range-request': {
                const req = syncMsg as RangeRequest;
                const entries = await self.ledger.getRange(req.startIndex, req.endIndex);
                const response: RangeResponse = {
                  type: 'range-response',
                  senderPeerId: self.localPeerId,
                  timestamp: Date.now(),
                  entries: entries.map(serializeEntry),
                  totalEntries: await self.ledger.getEntryCount(),
                };
                yield encode(response);
                break;
              }

              case 'push-entry': {
                const push = syncMsg as PushEntry;
                const entry = deserializeEntry(push.entry);
                const valid = await self.validateReceivedEntry(entry);

                if (valid) {
                  // Ingest the entry
                  await self.ledger.submit(entry.data, entry.submitterPubkey, entry.signature);
                  self.events.onEntryReceived?.(entry);

                  // Send back a confirmation
                  const { sign } = await import('../identity/keypair.js');
                  await sign(self.localPrivkey, entry.hash);
                  await self.ledger.addConfirmation(entry.index, self.localPubkey);

                  const confirm: ConfirmEntry = {
                    type: 'confirm-entry',
                    senderPeerId: self.localPeerId,
                    timestamp: Date.now(),
                    entryIndex: entry.index,
                    confirmerPubkey: toHex(self.localPubkey),
                  };
                  yield encode(confirm);
                }
                break;
              }

              case 'confirm-entry': {
                const confirm = syncMsg as ConfirmEntry;
                await self.ledger.addConfirmation(
                  confirm.entryIndex,
                  fromHex(confirm.confirmerPubkey),
                );
                self.events.onEntryConfirmed?.(confirm.entryIndex, confirm.confirmerPubkey);
                break;
              }
            }
          }
        },
        (source) => lp.encode(source),
        stream,
      );
    } catch {
      // Stream error
    }
  }
}
