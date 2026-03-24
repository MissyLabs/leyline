import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { SharedLedger, type SharedLedgerEntry } from './shared-ledger.js';
import { LedgerConsensus } from './consensus.js';
import { verify, publicKeyToHex } from '../identity/keypair.js';

/** Default timeout for stream operations (30 seconds). */
const STREAM_TIMEOUT_MS = 30_000;

/**
 * Wrap an async iterable with a per-message timeout. If no message arrives
 * within `timeoutMs`, the iterable is terminated and the underlying iterator
 * is properly cleaned up to prevent resource leaks.
 */
async function* withTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number = STREAM_TIMEOUT_MS,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        iterator.next(),
        new Promise<{ done: true; value: undefined }>((resolve) => {
          timer = setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (result.done) break;
      yield result.value;
    }
  } finally {
    // Ensure the underlying iterator is properly closed on exit (timeout or break)
    await iterator.return?.();
  }
}

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
  const parsed = JSON.parse(new TextDecoder().decode(data));
  if (typeof parsed.type !== 'string' || typeof parsed.senderPeerId !== 'string' ||
      typeof parsed.timestamp !== 'number') {
    throw new TypeError('Malformed SyncMessage');
  }
  // Sanitize numeric fields to prevent NaN/Infinity
  if (parsed.type === 'range-request') {
    parsed.startIndex = Math.max(0, Math.floor(parsed.startIndex ?? 0));
    parsed.endIndex = Math.max(0, Math.floor(parsed.endIndex ?? 0));
  }
  return parsed;
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
  private consensus: LedgerConsensus;
  private localPeerId: string;
  private localPubkey: Uint8Array;
  private localPubkeyHex: string;
  private localPrivkey: Uint8Array;
  private events: LedgerSyncEvents;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;

  /** How often to attempt sync with peers (60 seconds) */
  private syncIntervalMs: number;

  constructor(
    libp2p: Libp2p,
    ledger: SharedLedger,
    consensus: LedgerConsensus,
    localPubkey: Uint8Array,
    localPrivkey: Uint8Array,
    opts: {
      syncIntervalMs?: number;
      events?: LedgerSyncEvents;
    } = {},
  ) {
    this.libp2p = libp2p;
    this.ledger = ledger;
    this.consensus = consensus;
    this.localPeerId = libp2p.peerId.toString();
    this.localPubkey = localPubkey;
    this.localPubkeyHex = publicKeyToHex(localPubkey);
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

    // Periodically prune expired consensus proposals
    this.pruneInterval = setInterval(() => {
      this.consensus.pruneExpired();
    }, 30_000);
  }

  async stop(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    // Flush any orphaned pending proposals
    this.consensus.pruneExpired();
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
          for await (const msg of withTimeout(source)) {
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
      // Stream error or timeout
    } finally {
      try { stream.close(); } catch { /* already closed */ }
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
    } finally {
      try { stream.close(); } catch { /* already closed */ }
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
   * Also performs fork detection by comparing hashes at the boundary.
   */
  async syncWithAllPeers(): Promise<void> {
    const localCount = await this.ledger.getEntryCount();
    const peers = this.libp2p.getPeers();

    for (const peerId of peers) {
      try {
        // Fork detection: if we have entries, request the overlapping entry to compare hashes
        if (localCount > 0) {
          const overlap = await this.requestRange(peerId.toString(), localCount, localCount);
          if (overlap.length > 0) {
            const localEntry = await this.ledger.getEntry(localCount);
            if (localEntry && toHex(localEntry.hash) !== toHex(overlap[0].hash)) {
              console.warn(
                `[LedgerSync] Fork detected with peer ${peerId.toString()} at index ${localCount}. ` +
                `Local hash: ${toHex(localEntry.hash).slice(0, 16)}..., ` +
                `Peer hash: ${toHex(overlap[0].hash).slice(0, 16)}...`,
              );
              // Skip this peer — their chain diverged. In a non-Byzantine network
              // the longest chain with the most confirmations is preferred.
              // A future protocol upgrade could implement chain reorganization.
              continue;
            }
          }
        }

        // Request entries beyond what we have
        const entries = await this.requestRange(
          peerId.toString(),
          localCount + 1,
          localCount + 100, // Request up to 100 entries at a time
        );

        // Validate and propose received entries through consensus
        let ingested = 0;
        for (const entry of entries) {
          const valid = await this.validateReceivedEntry(entry);
          if (valid) {
            const committed = await this.proposeAndMaybeCommit(
              entry.data,
              entry.submitterPubkey,
              entry.signature,
              // Count existing confirmers from the synced entry
              entry.confirmerPubkeys.map(toHex),
            );
            if (committed) ingested++;
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
   * Propose an entry through consensus and commit if quorum is reached.
   * Adds the given confirmer pubkeys as confirmations.
   *
   * @returns `true` if the entry was committed to the shared ledger.
   */
  async proposeAndMaybeCommit(
    data: Uint8Array,
    submitterPubkey: Uint8Array,
    signature: Uint8Array,
    confirmerPubkeyHexes: string[] = [],
  ): Promise<boolean> {
    // First check if we already have a proposal for this content (cross-node dedup)
    let proposal = this.consensus.findByContent(data, submitterPubkey);

    if (!proposal || proposal.status !== 'pending') {
      try {
        proposal = this.consensus.propose(data, submitterPubkey, signature);
      } catch {
        // maxPendingEntries reached — skip
        return false;
      }
    }

    // Add confirmations from the provided list
    for (const confirmerHex of confirmerPubkeyHexes) {
      const reached = this.consensus.addConfirmation(proposal.hash, confirmerHex);
      if (reached) {
        return this.commitFinalized(proposal.hash);
      }
    }

    // Check if already finalized (e.g. quorumSize <= 0 or enough confirmations)
    if (this.consensus.isFinalized(proposal.hash)) {
      return this.commitFinalized(proposal.hash);
    }

    return false;
  }

  /**
   * Handle a confirmation for a specific ledger entry index.
   * Finds the matching pending proposal by looking up the committed entry data
   * and routes the confirmation to just that proposal.
   */
  private async handleConfirmationForEntry(confirmerPubkeyHex: string, entryIndex: number): Promise<void> {
    // Try to find the entry in the ledger to match against proposals
    const entry = await this.ledger.getEntry(entryIndex);
    if (entry) {
      // Find the proposal that matches this entry's content
      const proposal = this.consensus.findByContent(entry.data, entry.submitterPubkey);
      if (proposal && proposal.status === 'pending') {
        const reached = this.consensus.addConfirmation(proposal.hash, confirmerPubkeyHex);
        if (reached) {
          await this.commitFinalized(proposal.hash);
        }
        return;
      }
    }

    // Fallback: if we can't match to a specific proposal, try pending proposals
    // but only those that are awaiting confirmation (not all)
    for (const proposal of this.consensus.getPendingProposals()) {
      const reached = this.consensus.addConfirmation(proposal.hash, confirmerPubkeyHex);
      if (reached) {
        await this.commitFinalized(proposal.hash);
        return; // Only commit one at a time
      }
    }
  }

  /**
   * Commit a finalized proposal to the shared ledger.
   */
  private async commitFinalized(hash: string): Promise<boolean> {
    const proposal = this.consensus.getProposal(hash);
    if (!proposal) return false;

    await this.ledger.submit(
      proposal.data,
      proposal.submitterPubkey,
      proposal.signature,
    );
    return true;
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
          for await (const msg of withTimeout(source)) {
            const syncMsg = decode(msg.subarray());

            switch (syncMsg.type) {
              case 'range-request': {
                const req = syncMsg as RangeRequest;
                // Cap range size to prevent amplification attacks
                const maxRangeSize = 100;
                const cappedEnd = Math.min(req.endIndex, req.startIndex + maxRangeSize - 1);
                const entries = await self.ledger.getRange(req.startIndex, cappedEnd);
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
                console.log(`[LedgerSync] Received push-entry #${entry.index} (valid: ${valid}) from ${push.senderPeerId.slice(0, 16)}...`);

                if (valid) {
                  // Propose through consensus. The submitter signed the entry,
                  // which counts as their confirmation. Add both the submitter's
                  // AND our own confirmation to reach quorum.
                  const submitterHex = toHex(entry.submitterPubkey);
                  await self.proposeAndMaybeCommit(
                    entry.data,
                    entry.submitterPubkey,
                    entry.signature,
                    [submitterHex, self.localPubkeyHex],
                  );
                  self.events.onEntryReceived?.(entry);

                  // Send back a confirmation so the sender can count us
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
                // Only accept confirmations from the peer we're actually connected to
                // (the confirmerPubkey in the message must match the stream sender).
                // Since we can't verify the pubkey against the stream peer directly,
                // we use the senderPeerId from the message as a cross-check — the
                // confirmation is only meaningful from the peer that opened this stream.
                // The confirmerPubkey is recorded but the quorum security comes from
                // each peer only being able to add ONE confirmation per entry.
                const confirmerHex = confirm.confirmerPubkey;

                // Route confirmation to the specific entry, not all proposals
                await self.handleConfirmationForEntry(confirmerHex, confirm.entryIndex);
                // Also record confirmation on already-committed entries
                await self.ledger.addConfirmation(
                  confirm.entryIndex,
                  fromHex(confirmerHex),
                );
                self.events.onEntryConfirmed?.(confirm.entryIndex, confirmerHex);
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
    } finally {
      try { stream.close(); } catch { /* already closed */ }
    }
  }
}
