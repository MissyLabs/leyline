import type { Libp2p } from 'libp2p';
import type { Stream } from '@libp2p/interface';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { SharedLedger, type SharedLedgerEntry } from './shared-ledger.js';
import { LedgerConsensus } from './consensus.js';
import { ForkResolver, type PeerChainQuerier } from './fork-resolver.js';
import { sign, verify, publicKeyToHex } from '../identity/keypair.js';
import { withTimeout, STREAM_TIMEOUT_MS } from '../utils/stream-timeout.js';
import { Logger } from '../utils/logger.js';

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
  entryHash: string; // hex — binds confirmation to a specific entry
  confirmerPubkey: string; // hex
  confirmationSignature: string; // hex — Ed25519 sig over "confirm:{entryHash}"
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
    const si = Number(parsed.startIndex);
    const ei = Number(parsed.endIndex);
    parsed.startIndex = Number.isFinite(si) ? Math.max(0, Math.floor(si)) : 0;
    parsed.endIndex = Number.isFinite(ei) ? Math.max(0, Math.floor(ei)) : 0;
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
  private forkResolver: ForkResolver;
  private readonly log = new Logger('LedgerSync');

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
    this.forkResolver = new ForkResolver(ledger);
  }

  async start(): Promise<void> {
    // Register protocol handler
    await this.libp2p.handle(LEDGER_SYNC_PROTOCOL, async ({ stream }) => {
      await this.handleIncoming(stream);
    });

    // Start periodic sync
    this.syncInterval = setInterval(() => {
      this.syncWithAllPeers().catch((err) => {
        this.log.warn('Periodic sync failed', { error: String((err as Error)?.message ?? err) });
      });
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
        (source) => lp.decode(source),
        (source) => withTimeout(source, STREAM_TIMEOUT_MS),
        async (source) => {
          for await (const chunk of source) {
            const syncMsg = decode(chunk.subarray());
            if (syncMsg.type === 'confirm-entry') {
              const confirm = syncMsg as ConfirmEntry;
              const confirmerHex = confirm.confirmerPubkey;
              if (!confirmerHex || confirmerHex.length !== 64 ||
                  !confirm.entryHash || confirm.entryHash.length !== 64 ||
                  !confirm.confirmationSignature || confirm.confirmationSignature.length !== 128) {
                continue;
              }
              const confirmData = new TextEncoder().encode(`confirm:${confirm.entryHash}`);
              let sigValid = false;
              try {
                sigValid = await verify(fromHex(confirmerHex), fromHex(confirm.confirmationSignature), confirmData);
              } catch { /* malformed */ }
              if (sigValid) {
                await this.handleConfirmationForEntry(confirmerHex, confirm.entryIndex);
                await this.ledger.addConfirmation(confirm.entryIndex, fromHex(confirmerHex));
                this.events.onEntryConfirmed?.(confirm.entryIndex, confirmerHex);
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
    const peers = this.libp2p.getPeers();

    for (const peerId of peers) {
      try {
        await this.syncWithPeer(peerId.toString());
      } catch {
        // Individual peer sync failure — continue with others
      }
    }
  }

  private async syncWithPeer(peerId: string): Promise<void> {
    const localCount = await this.ledger.getEntryCount();

    // Fork detection and resolution via ForkResolver
    if (localCount > 0) {
      const peerQuerier = this.makePeerQuerier(peerId);
      const forkResult = await this.forkResolver.resolve(peerQuerier);
      if (forkResult) {
        this.events.onSyncComplete?.(peerId, forkResult.resolved ? 1 : 0);
        if (forkResult.winner === 'peer' && forkResult.resolved) return;
      }
    }

    // Request entries beyond what we have
    const currentCount = await this.ledger.getEntryCount();
    const entries = await this.requestRange(
      peerId,
      currentCount + 1,
      currentCount + 100,
    );

    let ingested = 0;
    for (const entry of entries) {
      const valid = await this.validateReceivedEntry(entry);
      if (valid) {
        const committed = await this.proposeAndMaybeCommit(
          entry.data,
          entry.submitterPubkey,
          entry.signature,
          entry.confirmerPubkeys.map(toHex),
        );
        if (committed) ingested++;
      }
    }

    if (ingested > 0) {
      this.events.onSyncComplete?.(peerId, ingested);
    }
  }

  private makePeerQuerier(peerId: string): PeerChainQuerier {
    const self = this;
    return {
      async getEntryHash(index: number): Promise<string | null> {
        const entries = await self.requestRange(peerId, index, index);
        if (entries.length === 0) return null;
        return toHex(entries[0].hash);
      },
      async getRange(startIndex: number, endIndex: number): Promise<SharedLedgerEntry[]> {
        return self.requestRange(peerId, startIndex, endIndex);
      },
      async getEntryCount(): Promise<number> {
        const probe = await self.requestRange(peerId, 1, 1);
        if (probe.length === 0) return 0;
        // Use a binary probe to estimate peer chain length
        let low = 1, high = 100_000;
        while (low < high) {
          const mid = Math.floor((low + high + 1) / 2);
          const check = await self.requestRange(peerId, mid, mid);
          if (check.length > 0) {
            low = mid;
          } else {
            high = mid - 1;
          }
        }
        return low;
      },
    };
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

    // No fallback: if we can't match a confirmation to a specific entry's
    // proposal, discard it. The previous blanket fallback could confirm the
    // wrong proposal when multiple were pending.
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
    const count = await this.ledger.getEntryCount();
    this.log.info('Committed entry to ledger', { total: count, confirmations: proposal.confirmations.size });
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
                self.log.info('Received push-entry', { index: entry.index, valid, peer: push.senderPeerId.slice(0, 16) });

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

                  // Send back a signed confirmation so the sender can count us
                  const entryHash = toHex(entry.hash);
                  const confirmPayload = new TextEncoder().encode(`confirm:${entryHash}`);
                  const confirmSig = await sign(self.localPrivkey, confirmPayload);
                  const confirm: ConfirmEntry = {
                    type: 'confirm-entry',
                    senderPeerId: self.localPeerId,
                    timestamp: Date.now(),
                    entryIndex: entry.index,
                    entryHash,
                    confirmerPubkey: toHex(self.localPubkey),
                    confirmationSignature: toHex(confirmSig),
                  };
                  yield encode(confirm);
                }
                break;
              }

              case 'confirm-entry': {
                const confirm = syncMsg as ConfirmEntry;
                const confirmerHex = confirm.confirmerPubkey;

                // Validate field lengths
                if (!confirmerHex || confirmerHex.length !== 64 ||
                    !confirm.entryHash || confirm.entryHash.length !== 64 ||
                    !confirm.confirmationSignature || confirm.confirmationSignature.length !== 128) {
                  break;
                }

                // Verify the confirmation is cryptographically signed by the confirmer
                const confirmData = new TextEncoder().encode(`confirm:${confirm.entryHash}`);
                let sigValid = false;
                try {
                  sigValid = await verify(
                    fromHex(confirmerHex),
                    fromHex(confirm.confirmationSignature),
                    confirmData,
                  );
                } catch {
                  // Malformed key or signature
                }
                if (!sigValid) {
                  break;
                }

                // Verify entryHash matches the actual entry at the claimed index
                const ledgerEntry = await self.ledger.getEntry(confirm.entryIndex);
                if (ledgerEntry && toHex(ledgerEntry.hash) !== confirm.entryHash) {
                  break;
                }

                await self.handleConfirmationForEntry(confirmerHex, confirm.entryIndex);
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
