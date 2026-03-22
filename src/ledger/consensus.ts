import { createHash } from 'node:crypto';

/**
 * Consensus mechanism for the shared distributed ledger.
 *
 * Uses timestamp-based ordering with hash tie-breaking:
 * - Entries are ordered by timestamp (earliest first)
 * - Ties are broken by the lexicographic order of the entry hash
 * - A quorum of peer confirmations is required before an entry is considered finalized
 *
 * This is NOT a Byzantine fault tolerant consensus — it assumes a majority of
 * honest nodes. Suitable for the initial network where seed operators are trusted.
 */

/**
 * Configuration for the consensus mechanism.
 */
export interface ConsensusConfig {
  /** Minimum number of peer confirmations required to consider an entry finalized. */
  quorumSize: number;
  /** Milliseconds to wait for confirmations before a proposal is eligible for re-proposal. */
  proposalTimeoutMs: number;
  /** Maximum number of proposals that may be held in the pending state simultaneously. */
  maxPendingEntries: number;
}

const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  quorumSize: 2,
  proposalTimeoutMs: 30_000,
  maxPendingEntries: 100,
};

/**
 * A single entry proposal awaiting consensus.
 */
export interface EntryProposal {
  /** Raw application payload. */
  data: Uint8Array;
  /** Ed25519 public key of the submitting peer, as raw bytes. */
  submitterPubkey: Uint8Array;
  /** Submitter's signature over the data. */
  signature: Uint8Array;
  /** Unix epoch milliseconds at the time of proposal creation. */
  timestamp: number;
  /**
   * SHA-256 hex digest of (data ‖ timestamp ‖ submitterPubkey).
   * Serves as the canonical identity for this proposal.
   */
  hash: string;
  /** Hex-encoded public keys of peers that have confirmed this proposal. */
  confirmations: Set<string>;
  /** Lifecycle state of the proposal. */
  status: 'pending' | 'confirmed' | 'rejected';
  /** Unix epoch milliseconds when this proposal was first created locally. */
  proposedAt: number;
}

/**
 * Manages pre-commit consensus for the shared distributed ledger.
 *
 * Callers should:
 * 1. Call {@link propose} when a node wants to submit a new entry.
 * 2. Broadcast the proposal hash to peers.
 * 3. Call {@link addConfirmation} as peer acknowledgements arrive.
 * 4. Once {@link isFinalized} returns `true`, commit the entry to {@link SharedLedger}.
 * 5. Periodically call {@link pruneExpired} to reclaim memory.
 */
export class LedgerConsensus {
  private readonly config: ConsensusConfig;
  /** All proposals keyed by their hash. */
  private readonly proposals = new Map<string, EntryProposal>();

  constructor(config?: Partial<ConsensusConfig>) {
    this.config = { ...DEFAULT_CONSENSUS_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new proposal for a ledger entry.
   *
   * The proposal is placed in `'pending'` status immediately. The caller is
   * responsible for broadcasting it to peers and collecting confirmations via
   * {@link addConfirmation}.
   *
   * Throws if {@link ConsensusConfig.maxPendingEntries} would be exceeded.
   */
  propose(
    data: Uint8Array,
    submitterPubkey: Uint8Array,
    signature: Uint8Array,
  ): EntryProposal {
    const pendingCount = this.getPendingProposals().length;
    if (pendingCount >= this.config.maxPendingEntries) {
      throw new Error(
        `LedgerConsensus: maxPendingEntries (${this.config.maxPendingEntries}) reached — cannot accept new proposal`,
      );
    }

    const timestamp = Date.now();
    const hash = this.computeProposalHash(data, timestamp, submitterPubkey);

    const proposal: EntryProposal = {
      data,
      submitterPubkey,
      signature,
      timestamp,
      hash,
      confirmations: new Set<string>(),
      status: 'pending',
      proposedAt: timestamp,
    };

    this.proposals.set(hash, proposal);
    return proposal;
  }

  /**
   * Record a confirmation from a peer for the proposal identified by `hash`.
   *
   * - Silently ignores confirmations for unknown, already-confirmed, or rejected proposals.
   * - Each `confirmerPubkey` is counted at most once per proposal.
   *
   * @returns `true` if this confirmation caused the proposal to reach quorum
   *          (i.e. the proposal transitioned from `'pending'` to `'confirmed'`
   *          as a result of this call), `false` otherwise.
   */
  addConfirmation(hash: string, confirmerPubkey: string): boolean {
    const proposal = this.proposals.get(hash);
    if (!proposal || proposal.status !== 'pending') return false;

    proposal.confirmations.add(confirmerPubkey);

    if (proposal.confirmations.size >= this.config.quorumSize) {
      proposal.status = 'confirmed';
      return true;
    }

    return false;
  }

  /**
   * Returns `true` when the proposal has accumulated at least
   * {@link ConsensusConfig.quorumSize} distinct confirmations.
   */
  isFinalized(hash: string): boolean {
    const proposal = this.proposals.get(hash);
    return proposal?.status === 'confirmed';
  }

  /**
   * Retrieve a proposal by its hash, or `undefined` if not found.
   */
  getProposal(hash: string): EntryProposal | undefined {
    return this.proposals.get(hash);
  }

  /**
   * All proposals currently in `'pending'` status.
   */
  getPendingProposals(): EntryProposal[] {
    return Array.from(this.proposals.values()).filter(
      (p) => p.status === 'pending',
    );
  }

  /**
   * All proposals that have reached quorum, sorted by timestamp ascending,
   * with lexicographic hash ordering as a tie-breaker.
   */
  getFinalizedProposals(): EntryProposal[] {
    return Array.from(this.proposals.values())
      .filter((p) => p.status === 'confirmed')
      .sort(compareByTimestampThenHash);
  }

  /**
   * Returns finalized entries in the canonical total order:
   * timestamp ascending, hash lexicographic ascending for ties.
   *
   * This is the order in which entries should be appended to the
   * {@link SharedLedger} to guarantee identical chains across all nodes.
   */
  getOrderedEntries(): EntryProposal[] {
    return this.getFinalizedProposals();
  }

  /**
   * Remove proposals whose age exceeds {@link ConsensusConfig.proposalTimeoutMs}
   * and that are still `'pending'` (i.e. never reached quorum).
   *
   * @returns The number of proposals pruned.
   */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [hash, proposal] of this.proposals) {
      if (
        proposal.status === 'pending' &&
        now - proposal.proposedAt > this.config.proposalTimeoutMs
      ) {
        this.proposals.delete(hash);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Mark a proposal as `'rejected'`, preventing it from ever being finalized.
   * No-ops if the proposal does not exist or is already in a terminal state.
   */
  reject(hash: string): void {
    const proposal = this.proposals.get(hash);
    if (proposal && proposal.status === 'pending') {
      proposal.status = 'rejected';
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute the canonical SHA-256 proposal hash as a hex string.
   *
   * Input is the concatenation of:
   *   data ‖ 8-byte big-endian timestamp (ms) ‖ submitterPubkey
   */
  private computeProposalHash(
    data: Uint8Array,
    timestamp: number,
    submitterPubkey: Uint8Array,
  ): string {
    const hasher = createHash('sha256');
    hasher.update(data);
    const tsBuf = Buffer.alloc(8);
    tsBuf.writeBigUInt64BE(BigInt(timestamp));
    hasher.update(tsBuf);
    hasher.update(submitterPubkey);
    return hasher.digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Internal ordering comparator
// ---------------------------------------------------------------------------

/**
 * Sort comparator: timestamp ascending, then hash lexicographic ascending.
 */
function compareByTimestampThenHash(a: EntryProposal, b: EntryProposal): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}
