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
    const localCount = await this.ledger.getEntryCount();
    const peerCount = await peer.getEntryCount();

    if (localCount === 0 || peerCount === 0) return null;

    const commonMax = Math.min(localCount, peerCount);

    const tipHash = await peer.getEntryHash(commonMax);
    const localTip = await this.ledger.getEntry(commonMax);
    if (!tipHash || !localTip) return null;

    if (toHex(localTip.hash) === tipHash) return null;

    const divergenceIndex = await this.binarySearchDivergence(peer, 1, commonMax);

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

    const localSuffix = await this.ledger.getRange(fork.divergenceIndex, fork.localLength);
    const peerSuffix = await peer.getRange(fork.divergenceIndex, fork.peerLength);

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
      const peerHash = await peer.getEntryHash(mid);
      const localEntry = await this.ledger.getEntry(mid);

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
