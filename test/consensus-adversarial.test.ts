/**
 * Adversarial tests for ledger consensus.
 * Simulates malicious peer behavior to verify hardening.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LedgerConsensus } from '../src/ledger/consensus.js';
import { generateKeypair, sign, verify, publicKeyToHex } from '../src/identity/keypair.js';

const enc = new TextEncoder();

describe('LedgerConsensus — adversarial scenarios', () => {
  let consensus: LedgerConsensus;

  beforeEach(() => {
    consensus = new LedgerConsensus({ quorumSize: 3, maxPendingEntries: 50 });
  });

  it('single peer cannot reach quorum alone (quorum=3)', () => {
    const data = enc.encode('entry-1');
    const pubkey = enc.encode('attacker'.padEnd(32, '0'));
    const sig = enc.encode('sig'.padEnd(64, '0'));

    const proposal = consensus.propose(data, pubkey, sig);

    // Attacker adds their own confirmation
    consensus.addConfirmation(proposal.hash, publicKeyToHex(pubkey));
    expect(consensus.isFinalized(proposal.hash)).toBe(false);

    // Even adding the same key again doesn't help (Set deduplicates)
    consensus.addConfirmation(proposal.hash, publicKeyToHex(pubkey));
    expect(consensus.isFinalized(proposal.hash)).toBe(false);

    const p = consensus.getProposal(proposal.hash);
    expect(p!.confirmations.size).toBe(1);
  });

  it('flooding with proposals is capped by maxPendingEntries', () => {
    const pubkey = enc.encode('spammer'.padEnd(32, '0'));
    const sig = enc.encode('sig'.padEnd(64, '0'));

    for (let i = 0; i < 50; i++) {
      consensus.propose(enc.encode(`spam-${i}`), pubkey, sig);
    }

    // 51st should throw
    expect(() => {
      consensus.propose(enc.encode('overflow'), pubkey, sig);
    }).toThrow(/maxPendingEntries/);
  });

  it('rejected proposals cannot be resurrected by adding confirmations', () => {
    const data = enc.encode('rejected-entry');
    const pubkey = enc.encode('honest'.padEnd(32, '0'));
    const sig = enc.encode('sig'.padEnd(64, '0'));

    const proposal = consensus.propose(data, pubkey, sig);
    consensus.reject(proposal.hash);

    // Try to confirm after rejection
    consensus.addConfirmation(proposal.hash, 'confirmer-1');
    consensus.addConfirmation(proposal.hash, 'confirmer-2');
    consensus.addConfirmation(proposal.hash, 'confirmer-3');

    expect(consensus.isFinalized(proposal.hash)).toBe(false);
    expect(consensus.getProposal(proposal.hash)!.status).toBe('rejected');
  });

  it('content-based dedup prevents duplicate proposals for same data', () => {
    const data = enc.encode('unique-data');
    const pubkey = enc.encode('submitter'.padEnd(32, '0'));
    const sig = enc.encode('sig'.padEnd(64, '0'));

    const proposal1 = consensus.propose(data, pubkey, sig);
    const proposal2 = consensus.propose(data, pubkey, sig);

    // Should return the same proposal (content dedup)
    expect(proposal2.hash).toBe(proposal1.hash);
    expect(consensus.getPendingProposals().length).toBe(1);
  });

  it('pruneExpired removes timed-out pending proposals', async () => {
    const shortTimeout = new LedgerConsensus({
      quorumSize: 3,
      proposalTimeoutMs: 50,
    });

    const data = enc.encode('ephemeral');
    const pubkey = enc.encode('temp'.padEnd(32, '0'));
    const sig = enc.encode('sig'.padEnd(64, '0'));

    shortTimeout.propose(data, pubkey, sig);
    expect(shortTimeout.getPendingProposals().length).toBe(1);

    await new Promise(r => setTimeout(r, 60));
    shortTimeout.pruneExpired();

    expect(shortTimeout.getPendingProposals().length).toBe(0);
  });

  it('proposeRemote rejects future timestamps beyond clock skew', () => {
    const data = enc.encode('future-entry');
    const pubkey = enc.encode('time-traveler'.padEnd(32, '0'));
    const sig = enc.encode('sig'.padEnd(64, '0'));

    const result = consensus.proposeRemote(
      data, pubkey, sig,
      Date.now() + 120_000, // 2 min in future, default skew is 60s
    );
    expect(result).toBeUndefined();
  });

  it('different submitters for same data create different proposals', () => {
    const data = enc.encode('shared-data');
    const pubkey1 = enc.encode('alice'.padEnd(32, '0'));
    const pubkey2 = enc.encode('bob'.padEnd(32, '0'));
    const sig = enc.encode('sig'.padEnd(64, '0'));

    const p1 = consensus.propose(data, pubkey1, sig);
    const p2 = consensus.propose(data, pubkey2, sig);

    // Different submitters = different content hashes = different proposals
    expect(p1.hash).not.toBe(p2.hash);
    expect(consensus.getPendingProposals().length).toBe(2);
  });
});

describe('Signature verification — adversarial', () => {
  it('attacker cannot forge confirmation for another peer', async () => {
    const honest = await generateKeypair();
    const attacker = await generateKeypair();
    const entryHash = '0'.repeat(64);

    const payload = enc.encode(`confirm:${entryHash}`);

    // Attacker signs with their key but claims to be honest peer
    const attackerSig = await sign(attacker.privateKey, payload);

    // Verification against honest peer's key should fail
    const valid = await verify(honest.publicKey, attackerSig, payload);
    expect(valid).toBe(false);
  });

  it('confirmation for different entry hash is rejected', async () => {
    const peer = await generateKeypair();
    const realHash = 'a'.repeat(64);
    const fakeHash = 'b'.repeat(64);

    const realPayload = enc.encode(`confirm:${realHash}`);
    const sig = await sign(peer.privateKey, realPayload);

    const fakePayload = enc.encode(`confirm:${fakeHash}`);
    const valid = await verify(peer.publicKey, sig, fakePayload);
    expect(valid).toBe(false);
  });

  it('submitter signature cannot be transferred to different data', async () => {
    const peer = await generateKeypair();
    const data1 = enc.encode('legitimate-entry');
    const data2 = enc.encode('malicious-entry');

    const sig1 = await sign(peer.privateKey, data1);

    // Try to use sig1 to validate data2
    const valid = await verify(peer.publicKey, sig1, data2);
    expect(valid).toBe(false);
  });
});
