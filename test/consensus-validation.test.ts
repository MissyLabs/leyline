import { describe, it, expect } from 'vitest';
import { LedgerConsensus } from '../src/ledger/consensus.js';

describe('LedgerConsensus validation', () => {
  it('rejects quorumSize of 0', () => {
    expect(() => new LedgerConsensus({ quorumSize: 0 })).toThrow(/quorumSize/);
  });

  it('rejects negative quorumSize', () => {
    expect(() => new LedgerConsensus({ quorumSize: -1 })).toThrow(/quorumSize/);
  });

  it('rejects non-integer quorumSize', () => {
    expect(() => new LedgerConsensus({ quorumSize: 1.5 })).toThrow(/quorumSize/);
  });

  it('accepts quorumSize of 1', () => {
    expect(() => new LedgerConsensus({ quorumSize: 1 })).not.toThrow();
  });

  it('rejects maxPendingEntries of 0', () => {
    expect(() => new LedgerConsensus({ maxPendingEntries: 0 })).toThrow(/maxPendingEntries/);
  });
});
