import type { SharedLedger, SharedLedgerEntry } from './shared-ledger.js';
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
 * 2. Compare total confirmations in the divergent suffix
 * 3. The chain with more confirmations wins; ties broken by length, then kept local
 * 4. If the peer wins, roll back local entries and replay the peer's chain
 */
export class ForkResolver {
  private readonly ledger: SharedLedger;
  private readonly maxReorgDepth: number;
  private readonly log = new Logger('ForkResolver');

  constructor(ledger: SharedLedger, opts?: { maxReorgDepth?: number }) {
    this.ledger = ledger;
    this.maxReorgDepth = opts?.maxReorgDepth ?? 50;
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

    const localConfs = totalConfirmations(localSuffix);
    const peerConfs = totalConfirmations(peerSuffix);

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

      await this.ledger.rollbackTo(fork.divergenceIndex - 1);

      for (const entry of peerSuffix) {
        await this.ledger.submit(entry.data, entry.submitterPubkey, entry.signature);
        for (const confirmer of entry.confirmerPubkeys) {
          await this.ledger.addConfirmation(entry.index, confirmer);
        }
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

function totalConfirmations(entries: SharedLedgerEntry[]): number {
  let total = 0;
  for (const e of entries) {
    total += e.confirmations;
  }
  return total;
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
