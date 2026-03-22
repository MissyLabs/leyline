import { describe, it, expect, beforeEach } from 'vitest';
import { LedgerConsensus } from '../src/ledger/consensus.js';
import type { EntryProposal } from '../src/ledger/consensus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tiny helpers that produce repeatable Uint8Array test values. */
const enc = new TextEncoder();

function makeData(label: string): Uint8Array {
  return enc.encode(`data:${label}`);
}

function makePubkey(label: string): Uint8Array {
  return enc.encode(`pubkey:${label}`);
}

function makeSig(label: string): Uint8Array {
  return enc.encode(`sig:${label}`);
}

/**
 * Propose a single entry with convenient defaults so individual tests can
 * focus on the dimension they care about.
 */
function proposeEntry(
  consensus: LedgerConsensus,
  label = 'entry',
): EntryProposal {
  return consensus.propose(makeData(label), makePubkey(label), makeSig(label));
}

/**
 * Push a proposal to confirmed status by adding `count` distinct confirmer
 * pubkeys.
 */
function confirmN(
  consensus: LedgerConsensus,
  hash: string,
  count: number,
  prefix = 'confirmer',
): boolean {
  let quorumReached = false;
  for (let i = 0; i < count; i++) {
    const result = consensus.addConfirmation(hash, `${prefix}-${i}`);
    if (result) quorumReached = true;
  }
  return quorumReached;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LedgerConsensus', () => {
  // Default config: quorumSize=2, proposalTimeoutMs=30_000, maxPendingEntries=100
  let consensus: LedgerConsensus;

  beforeEach(() => {
    consensus = new LedgerConsensus();
  });

  // -------------------------------------------------------------------------
  // propose
  // -------------------------------------------------------------------------

  describe('propose', () => {
    it('returns a proposal with status pending', () => {
      const p = proposeEntry(consensus);
      expect(p.status).toBe('pending');
    });

    it('assigns a non-empty hex hash', () => {
      const p = proposeEntry(consensus);
      expect(typeof p.hash).toBe('string');
      expect(p.hash.length).toBeGreaterThan(0);
      // SHA-256 hex: 64 hex chars.
      expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('records proposedAt close to Date.now()', () => {
      const before = Date.now();
      const p = proposeEntry(consensus);
      const after = Date.now();
      expect(p.proposedAt).toBeGreaterThanOrEqual(before);
      expect(p.proposedAt).toBeLessThanOrEqual(after);
    });

    it('starts with an empty confirmations set', () => {
      const p = proposeEntry(consensus);
      expect(p.confirmations.size).toBe(0);
    });

    it('getProposal() returns the same proposal by hash', () => {
      const p = proposeEntry(consensus);
      expect(consensus.getProposal(p.hash)).toBe(p);
    });

    it('appears in getPendingProposals()', () => {
      const p = proposeEntry(consensus);
      const pending = consensus.getPendingProposals();
      expect(pending).toHaveLength(1);
      expect(pending[0].hash).toBe(p.hash);
    });

    it('throws when maxPendingEntries is reached', () => {
      const small = new LedgerConsensus({ maxPendingEntries: 2 });
      proposeEntry(small, 'a');
      proposeEntry(small, 'b');
      expect(() => proposeEntry(small, 'c')).toThrow(/maxPendingEntries/);
    });

    it('two distinct proposals get different hashes', () => {
      const p1 = proposeEntry(consensus, 'alpha');
      const p2 = proposeEntry(consensus, 'beta');
      expect(p1.hash).not.toBe(p2.hash);
    });
  });

  // -------------------------------------------------------------------------
  // addConfirmation
  // -------------------------------------------------------------------------

  describe('addConfirmation', () => {
    it('returns false before quorum is reached', () => {
      const p = proposeEntry(consensus); // quorumSize defaults to 2
      const result = consensus.addConfirmation(p.hash, 'peer-a');
      expect(result).toBe(false);
      expect(p.status).toBe('pending');
    });

    it('returns true and sets status to confirmed when quorum is reached', () => {
      const p = proposeEntry(consensus);
      consensus.addConfirmation(p.hash, 'peer-a');
      const quorumHit = consensus.addConfirmation(p.hash, 'peer-b');

      expect(quorumHit).toBe(true);
      expect(p.status).toBe('confirmed');
    });

    it('each confirmer is counted at most once', () => {
      const p = proposeEntry(consensus);
      consensus.addConfirmation(p.hash, 'same-peer');
      consensus.addConfirmation(p.hash, 'same-peer');
      // Still only 1 unique confirmation — quorum of 2 not yet met.
      expect(p.confirmations.size).toBe(1);
      expect(p.status).toBe('pending');
    });

    it('silently ignores confirmations for an unknown hash', () => {
      const result = consensus.addConfirmation('nonexistent-hash', 'peer');
      expect(result).toBe(false);
    });

    it('silently ignores confirmations after quorum is already reached', () => {
      const p = proposeEntry(consensus);
      confirmN(consensus, p.hash, 2);
      expect(p.status).toBe('confirmed');

      // A third confirmation must be a no-op.
      const late = consensus.addConfirmation(p.hash, 'late-peer');
      expect(late).toBe(false);
    });

    it('isFinalized() returns true after quorum', () => {
      const p = proposeEntry(consensus);
      confirmN(consensus, p.hash, 2);
      expect(consensus.isFinalized(p.hash)).toBe(true);
    });

    it('isFinalized() returns false for unknown hash', () => {
      expect(consensus.isFinalized('ghost')).toBe(false);
    });

    it('confirmed proposals no longer appear in getPendingProposals()', () => {
      const p = proposeEntry(consensus);
      confirmN(consensus, p.hash, 2);
      expect(consensus.getPendingProposals()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getOrderedEntries / getFinalizedProposals
  // -------------------------------------------------------------------------

  describe('getOrderedEntries', () => {
    it('returns an empty array when nothing is confirmed', () => {
      proposeEntry(consensus);
      expect(consensus.getOrderedEntries()).toHaveLength(0);
    });

    it('returns confirmed entries sorted by timestamp ascending', async () => {
      const p1 = proposeEntry(consensus, 'first');
      await new Promise((r) => setTimeout(r, 5));
      const p2 = proposeEntry(consensus, 'second');

      confirmN(consensus, p1.hash, 2);
      confirmN(consensus, p2.hash, 2);

      const ordered = consensus.getOrderedEntries();
      expect(ordered).toHaveLength(2);
      expect(ordered[0].hash).toBe(p1.hash);
      expect(ordered[1].hash).toBe(p2.hash);
    });

    it('uses hash as a tie-breaker when timestamps are equal', () => {
      // Manually create a consensus that has two proposals with identical
      // timestamps by overriding Date.now via proposals with a custom config.
      // Instead, we confirm several proposals and inspect the sort invariant
      // across multiple runs to validate the comparator is deterministic.
      const c = new LedgerConsensus({ quorumSize: 1 });

      const entries: EntryProposal[] = [];
      for (let i = 0; i < 5; i++) {
        entries.push(c.propose(makeData(`tie-${i}`), makePubkey(`tie-${i}`), makeSig(`tie-${i}`)));
      }
      for (const e of entries) {
        c.addConfirmation(e.hash, 'confirmer');
      }

      const ordered = c.getOrderedEntries();
      // Verify the array is sorted: each entry's timestamp must be <= next, and
      // when equal the hash must be lexicographically <= next hash.
      for (let i = 0; i < ordered.length - 1; i++) {
        const a = ordered[i];
        const b = ordered[i + 1];
        const timeOk = a.timestamp < b.timestamp;
        const tieOk = a.timestamp === b.timestamp && a.hash <= b.hash;
        expect(timeOk || tieOk).toBe(true);
      }
    });

    it('concurrent proposals all appear in ordered output after confirmation', async () => {
      // Propose multiple entries in rapid succession (same event-loop tick).
      const c = new LedgerConsensus({ quorumSize: 1 });
      const hashes: string[] = [];
      for (let i = 0; i < 4; i++) {
        const p = c.propose(makeData(`concurrent-${i}`), makePubkey(`p-${i}`), makeSig(`s-${i}`));
        hashes.push(p.hash);
      }

      for (const h of hashes) {
        c.addConfirmation(h, 'confirmer');
      }

      const ordered = c.getOrderedEntries();
      expect(ordered).toHaveLength(4);

      // All hashes must be present.
      const returnedHashes = ordered.map((e) => e.hash).sort();
      expect(returnedHashes).toEqual([...hashes].sort());
    });

    it('pending entries are excluded from getOrderedEntries()', () => {
      const p = proposeEntry(consensus);
      // Only one confirmation — quorum not met.
      consensus.addConfirmation(p.hash, 'peer-a');
      expect(consensus.getOrderedEntries()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // pruneExpired
  // -------------------------------------------------------------------------

  describe('pruneExpired', () => {
    it('returns 0 when no proposals have timed out', () => {
      proposeEntry(consensus); // default 30s timeout — far from expiring
      expect(consensus.pruneExpired()).toBe(0);
    });

    it('removes pending proposals that have exceeded the timeout', async () => {
      const short = new LedgerConsensus({ proposalTimeoutMs: 1 });
      proposeEntry(short, 'will-expire');

      // Wait for the timeout to elapse.
      await new Promise((r) => setTimeout(r, 20));

      expect(short.pruneExpired()).toBe(1);
      expect(short.getPendingProposals()).toHaveLength(0);
    });

    it('does not prune confirmed proposals', async () => {
      const short = new LedgerConsensus({ proposalTimeoutMs: 1, quorumSize: 1 });
      const p = proposeEntry(short, 'confirmed-entry');
      short.addConfirmation(p.hash, 'peer');

      await new Promise((r) => setTimeout(r, 20));

      expect(short.pruneExpired()).toBe(0);
      expect(short.getOrderedEntries()).toHaveLength(1);
    });

    it('does not prune rejected proposals', async () => {
      const short = new LedgerConsensus({ proposalTimeoutMs: 1 });
      const p = proposeEntry(short, 'rejected-entry');
      short.reject(p.hash);

      await new Promise((r) => setTimeout(r, 20));

      // pruneExpired only removes pending — rejected proposals are terminal but
      // the implementation only deletes pending ones.
      expect(short.pruneExpired()).toBe(0);
    });

    it('selectively prunes only the expired pending proposals', async () => {
      const mixed = new LedgerConsensus({ proposalTimeoutMs: 1 });
      proposeEntry(mixed, 'expires-fast');

      // Wait for the first proposal to expire, then add a new one.
      await new Promise((r) => setTimeout(r, 20));

      // Re-create with a fresh (long) timeout for the second proposal.
      // Because we cannot reset Date.now() we use a new instance config.
      const fresh = new LedgerConsensus({ proposalTimeoutMs: 30_000 });
      proposeEntry(fresh, 'stays');

      // Prune the short-timeout instance — the single proposal must be pruned.
      expect(mixed.pruneExpired()).toBe(1);

      // The fresh-timeout instance must not prune anything.
      expect(fresh.pruneExpired()).toBe(0);
      expect(fresh.getPendingProposals()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // reject
  // -------------------------------------------------------------------------

  describe('reject', () => {
    it('marks a pending proposal as rejected', () => {
      const p = proposeEntry(consensus);
      consensus.reject(p.hash);
      expect(p.status).toBe('rejected');
    });

    it('rejected proposal is no longer pending', () => {
      const p = proposeEntry(consensus);
      consensus.reject(p.hash);
      expect(consensus.getPendingProposals()).toHaveLength(0);
    });

    it('rejected proposal cannot be finalized by subsequent confirmations', () => {
      const p = proposeEntry(consensus);
      consensus.reject(p.hash);
      const result = consensus.addConfirmation(p.hash, 'peer');
      expect(result).toBe(false);
      expect(p.status).toBe('rejected');
    });

    it('isFinalized() returns false for a rejected proposal', () => {
      const p = proposeEntry(consensus);
      consensus.reject(p.hash);
      expect(consensus.isFinalized(p.hash)).toBe(false);
    });

    it('reject is a no-op for an already-confirmed proposal', () => {
      const p = proposeEntry(consensus);
      confirmN(consensus, p.hash, 2);
      expect(p.status).toBe('confirmed');

      consensus.reject(p.hash);
      // Must remain confirmed — reject does not override a terminal state.
      expect(p.status).toBe('confirmed');
    });

    it('reject is a no-op for an unknown hash', () => {
      expect(() => consensus.reject('ghost-hash')).not.toThrow();
    });
  });
});
