import { SharedLedger, computeEntryHash, type SharedLedgerEntry } from './shared-ledger.js';
import { verify } from '../identity/keypair.js';
import { Logger } from '../utils/logger.js';

function toHex(arr: Uint8Array): string {
  return Buffer.from(arr).toString('hex');
}

export interface ForkInfo {
  divergenceIndex: number;
  localLength: number;
  peerLength: number;
  localConfirmations: number;
  peerConfirmations: number;
  resolved: boolean;
  winner: 'local' | 'peer' | 'none';
}

export interface PeerChainQuerier {
  getEntryHash(index: number): Promise<string | null>;
  getRange(startIndex: number, endIndex: number): Promise<SharedLedgerEntry[]>;
  getEntryCount(): Promise<number>;
}

/**
 * Detects and resolves forks between the local ledger and a peer's chain.
 *
 * Resolution strategy (non-Byzantine, honest-majority assumption):
 * 1. Find the divergence point via binary search
 * 2. Compare total *cryptographically verified* confirmations in the divergent suffix
 * 3. The chain with more verified confirmations wins; ties broken by length, then kept local
 * 4. If the peer wins, the peer suffix is fully validated (submitter signatures +
 *    recomputed hashes + continuity) before the local chain is rolled back and replaced.
 *
 * SEC-1: a peer can no longer force a reorg by inflating the bare `confirmations`
 * count or serving fabricated entries — confirmations must be backed by signatures
 * over `confirm:{hash}`, every entry's submitter signature is checked, and every
 * entry's hash is recomputed locally rather than trusted.
 */
/** Upper bound on confirmer entries examined per entry (DoS guard, SEC-1). */
const MAX_CONFIRMERS_PER_ENTRY = 64;

export class ForkResolver {
  private readonly ledger: SharedLedger;
  private readonly maxReorgDepth: number;
  private readonly log = new Logger('ForkResolver');
  /**
   * SEC-3: submitter authorization gate. When set, a peer suffix is refused if
   * ANY entry's submitter is not authorized — a reorg must not smuggle in
   * entries that ordinary ingest would reject.
   */
  private readonly isSubmitterAuthorized?: (submitterPubkeyHex: string) => boolean;

  constructor(
    ledger: SharedLedger,
    opts?: { maxReorgDepth?: number; isSubmitterAuthorized?: (submitterPubkeyHex: string) => boolean },
  ) {
    this.ledger = ledger;
    this.maxReorgDepth = opts?.maxReorgDepth ?? 50;
    this.isSubmitterAuthorized = opts?.isSubmitterAuthorized;
  }

  async detectFork(peer: PeerChainQuerier): Promise<ForkInfo | null> {
    let localCount: number;
    let peerCount: number;
    try {
      localCount = await this.ledger.getEntryCount();
      peerCount = await peer.getEntryCount();
    } catch (err) {
      this.log.warn('Failed to get entry counts during fork detection', { error: String(err) });
      return null;
    }

    if (localCount === 0 || peerCount === 0) return null;
    if (!Number.isFinite(peerCount) || peerCount < 0) {
      this.log.warn('Peer returned invalid entry count', { peerCount });
      return null;
    }

    const commonMax = Math.min(localCount, peerCount);

    let tipHash: string | null;
    let localTip: SharedLedgerEntry | null;
    try {
      tipHash = await peer.getEntryHash(commonMax);
      localTip = await this.ledger.getEntry(commonMax);
    } catch (err) {
      this.log.warn('Failed to get tip entries during fork detection', { error: String(err) });
      return null;
    }
    if (!tipHash || !localTip) return null;

    if (toHex(localTip.hash) === tipHash) return null;

    const divergenceIndex = await this.binarySearchDivergence(peer, 1, commonMax);

    if (divergenceIndex < 1 || divergenceIndex > commonMax) {
      this.log.warn('Binary search returned out-of-bounds divergence index', { divergenceIndex, commonMax });
      return null;
    }

    return {
      divergenceIndex,
      localLength: localCount,
      peerLength: peerCount,
      localConfirmations: 0,
      peerConfirmations: 0,
      resolved: false,
      winner: 'none',
    };
  }

  async resolve(peer: PeerChainQuerier): Promise<ForkInfo | null> {
    const fork = await this.detectFork(peer);
    if (!fork) return null;

    const reorgDepth = fork.localLength - fork.divergenceIndex + 1;
    if (reorgDepth > this.maxReorgDepth) {
      this.log.warn('Reorg depth exceeds max — refusing to resolve', { reorgDepth, maxReorgDepth: this.maxReorgDepth });
      return { ...fork, resolved: false, winner: 'none' };
    }

    let localSuffix: SharedLedgerEntry[];
    let peerSuffix: SharedLedgerEntry[];
    try {
      localSuffix = await this.ledger.getRange(fork.divergenceIndex, fork.localLength);
      peerSuffix = await peer.getRange(fork.divergenceIndex, fork.peerLength);
    } catch (err) {
      this.log.warn('Failed to get chain ranges during resolution', { error: String(err) });
      return { ...fork, resolved: false, winner: 'none' };
    }

    if (!Array.isArray(peerSuffix)) {
      this.log.warn('Peer returned non-array range response');
      return { ...fork, resolved: false, winner: 'none' };
    }

    // Only count confirmations that are cryptographically proven (SEC-1).
    const localConfs = await verifiedConfirmations(localSuffix);
    const peerConfs = await verifiedConfirmations(peerSuffix);

    fork.localConfirmations = localConfs;
    fork.peerConfirmations = peerConfs;

    let winner: 'local' | 'peer';
    if (peerConfs > localConfs) {
      winner = 'peer';
    } else if (localConfs > peerConfs) {
      winner = 'local';
    } else if (peerSuffix.length > localSuffix.length) {
      winner = 'peer';
    } else {
      winner = 'local';
    }

    fork.winner = winner;

    if (winner === 'peer') {
      if (!validatePeerChainContinuity(peerSuffix, fork.divergenceIndex)) {
        this.log.warn('Peer chain failed continuity check — refusing reorg', {
          divergenceIndex: fork.divergenceIndex,
          peerEntries: peerSuffix.length,
        });
        fork.winner = 'local';
        fork.resolved = true;
        return fork;
      }

      // SEC-1: verify every peer entry (recomputed hash + submitter signature)
      // BEFORE mutating the local chain. A single bad entry aborts the reorg.
      if (!await validatePeerSuffix(peerSuffix)) {
        this.log.warn('Peer chain failed cryptographic validation — refusing reorg', {
          divergenceIndex: fork.divergenceIndex,
          peerEntries: peerSuffix.length,
        });
        fork.winner = 'local';
        fork.resolved = true;
        return fork;
      }

      // SEC-3: the reorg path bypasses LedgerSync's ordinary ingest gate, so
      // enforce the submitter allow-list over the ENTIRE suffix here, before
      // any rollback. If any entry's submitter is not authorized, refuse — a
      // chain with unauthorized submitters must not enter via reorg.
      if (this.isSubmitterAuthorized) {
        for (const entry of peerSuffix) {
          if (!this.isSubmitterAuthorized(toHex(entry.submitterPubkey))) {
            this.log.warn('Peer chain contains unauthorized submitter — refusing reorg', {
              divergenceIndex: fork.divergenceIndex,
              submitter: toHex(entry.submitterPubkey).slice(0, 16),
            });
            fork.winner = 'local';
            fork.resolved = true;
            return fork;
          }
        }
      }

      await this.ledger.rollbackTo(fork.divergenceIndex - 1);

      // SEC-1/adoption: import each peer entry VERBATIM (index, timestamp,
      // prevHash, hash, signature preserved) so the adopted local head hash
      // equals the peer head hash. Re-timestamping/re-hashing here (as submit()
      // does) would produce a different hash and leave the peer perpetually
      // "forked" against us.
      for (const entry of peerSuffix) {
        const sigs = entry.confirmerSignatures ?? [];
        const keptPubkeys: Uint8Array[] = [];
        const keptSigs: Uint8Array[] = [];
        const seen = new Set<string>();
        const n = Math.min(entry.confirmerPubkeys.length, MAX_CONFIRMERS_PER_ENTRY);
        for (let i = 0; i < n; i++) {
          const sig = sigs[i];
          if (!sig || sig.length === 0) continue;
          const pkHex = toHex(entry.confirmerPubkeys[i]);
          if (seen.has(pkHex)) continue;
          // Only preserve confirmations we can verify against the true hash.
          if (!await verifyConfirmation(entry.hash, entry.confirmerPubkeys[i], sig)) continue;
          seen.add(pkHex);
          keptPubkeys.push(entry.confirmerPubkeys[i]);
          keptSigs.push(sig);
        }
        await this.ledger.appendValidated({
          ...entry,
          confirmerPubkeys: keptPubkeys,
          confirmerSignatures: keptSigs,
          confirmations: keptPubkeys.length,
        });
      }

      // Adoption invariant: our head hash must now equal the peer head hash.
      const peerHead = peerSuffix[peerSuffix.length - 1];
      const localHead = await this.ledger.getLatest();
      if (!localHead || toHex(localHead.hash) !== toHex(peerHead.hash)) {
        this.log.error('Fork adoption did not converge to peer head hash', {
          divergenceIndex: fork.divergenceIndex,
          localHead: localHead ? toHex(localHead.hash).slice(0, 16) : 'none',
          peerHead: toHex(peerHead.hash).slice(0, 16),
        });
      }

      fork.resolved = true;
      this.log.info('Resolved fork: adopted peer chain', {
        divergenceIndex: fork.divergenceIndex,
        peerConfs,
        localConfs,
      });
    } else {
      fork.resolved = true;
      this.log.info('Fork resolved: keeping local chain', {
        divergenceIndex: fork.divergenceIndex,
        localConfs,
        peerConfs,
      });
    }

    return fork;
  }

  private async binarySearchDivergence(
    peer: PeerChainQuerier,
    low: number,
    high: number,
  ): Promise<number> {
    while (low < high) {
      const mid = Math.floor((low + high) / 2);

      let peerHash: string | null;
      let localEntry: SharedLedgerEntry | null;
      try {
        peerHash = await peer.getEntryHash(mid);
        localEntry = await this.ledger.getEntry(mid);
      } catch {
        high = mid;
        continue;
      }

      if (!peerHash || !localEntry) {
        high = mid;
        continue;
      }

      if (toHex(localEntry.hash) === peerHash) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }
}

/** Verify a confirmer signature over `confirm:{entryHash}`. */
async function verifyConfirmation(entryHash: Uint8Array, confirmerPubkey: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const confirmData = new TextEncoder().encode(`confirm:${toHex(entryHash)}`);
  try {
    return await verify(confirmerPubkey, signature, confirmData);
  } catch {
    return false;
  }
}

/**
 * Count only cryptographically-verified confirmations across a suffix.
 * A confirmation counts only when its stored signature verifies against
 * `confirm:{entryHash}` for the corresponding confirmer pubkey.
 */
async function verifiedConfirmations(entries: SharedLedgerEntry[]): Promise<number> {
  let total = 0;
  for (const e of entries) {
    // Guard against a peer inflating the hash used for confirmation binding:
    // recompute it locally so a fabricated `hash` can't be used to "validate"
    // attacker-signed confirmations.
    const trueHash = computeEntryHash(e);
    const sigs = e.confirmerSignatures ?? [];
    // SEC-1: deduplicate confirmers by pubkey so a repeated (key,sig) pair
    // contributes weight 1, not N — otherwise a peer replays one valid key
    // thousands of times to inflate confirmation weight and force a reorg.
    // Cap the number of positions examined BEFORE doing signature work so a
    // huge confirmer array can't burn CPU.
    const seen = new Set<string>();
    const n = Math.min(e.confirmerPubkeys.length, MAX_CONFIRMERS_PER_ENTRY);
    for (let i = 0; i < n; i++) {
      const sig = sigs[i];
      if (!sig || sig.length === 0) continue;
      const pkHex = toHex(e.confirmerPubkeys[i]);
      if (seen.has(pkHex)) continue;
      if (await verifyConfirmation(trueHash, e.confirmerPubkeys[i], sig)) {
        seen.add(pkHex);
        total++;
      }
    }
  }
  return total;
}

/**
 * Validate a peer suffix cryptographically: each entry's hash must match the
 * locally-recomputed hash and the submitter signature must verify over `data`.
 */
async function validatePeerSuffix(entries: SharedLedgerEntry[]): Promise<boolean> {
  for (const e of entries) {
    if (toHex(computeEntryHash(e)) !== toHex(e.hash)) return false;
    let sigOk = false;
    try {
      sigOk = await verify(e.submitterPubkey, e.signature, e.data);
    } catch {
      sigOk = false;
    }
    if (!sigOk) return false;
  }
  return true;
}

function validatePeerChainContinuity(entries: SharedLedgerEntry[], startIndex: number): boolean {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.index !== startIndex + i) return false;
    if (i > 0) {
      const prev = entries[i - 1];
      if (toHex(entry.prevHash) !== toHex(prev.hash)) return false;
    }
  }
  return true;
}
