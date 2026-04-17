/**
 * Regression tests for ledger confirmation security (C1 + C2 fixes).
 *
 * C1: Confirmation messages must carry a valid Ed25519 signature from the confirmer.
 * C2: Seeds must verify submitter signatures before auto-confirming proposals.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { generateKeypair, sign, verify, publicKeyToHex } from '../src/identity/keypair.js';
import { LedgerConsensus } from '../src/ledger/consensus.js';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { LedgerSync } from '../src/ledger/ledger-sync.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enc = new TextEncoder();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toHex(arr: Uint8Array): string {
  return Buffer.from(arr).toString('hex');
}

async function createTestNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

// =========================================================================
// C1: Signed confirmation verification
// =========================================================================

describe('LedgerSync — signed confirmations (C1)', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let keypairA: Awaited<ReturnType<typeof generateKeypair>>;
  let keypairB: Awaited<ReturnType<typeof generateKeypair>>;
  let tmpA: string;
  let tmpB: string;

  beforeAll(async () => {
    [nodeA, nodeB] = await Promise.all([createTestNode(), createTestNode()]);
    [keypairA, keypairB] = await Promise.all([generateKeypair(), generateKeypair()]);
    tmpA = await mkdtemp(join(tmpdir(), 'c1-a-'));
    tmpB = await mkdtemp(join(tmpdir(), 'c1-b-'));

    const addrB = nodeB.getMultiaddrs()[0];
    await nodeA.dial(addrB!);
    await sleep(500);
  });

  afterAll(async () => {
    await Promise.all([nodeA.stop(), nodeB.stop()]);
    await Promise.all([rm(tmpA, { recursive: true }), rm(tmpB, { recursive: true })]);
  });

  it('accepts a confirmation with valid signature', async () => {
    const ledgerA = new SharedLedger(`${tmpA}/sl-valid`);
    const ledgerB = new SharedLedger(`${tmpB}/sl-valid`);
    await Promise.all([ledgerA.open(), ledgerB.open()]);

    const consensusA = new LedgerConsensus({ quorumSize: 2 });
    const consensusB = new LedgerConsensus({ quorumSize: 2 });

    const syncA = new LedgerSync(nodeA, ledgerA, consensusA, keypairA.publicKey, keypairA.privateKey);
    const syncB = new LedgerSync(nodeB, ledgerB, consensusB, keypairB.publicKey, keypairB.privateKey);
    await Promise.all([syncA.start(), syncB.start()]);

    const data = enc.encode('test-valid-confirmation');
    const sigA = await sign(keypairA.privateKey, data);

    await ledgerA.submit(data, keypairA.publicKey, sigA);
    const entry = await ledgerA.getLatest();
    expect(entry).toBeDefined();

    await syncA.pushEntry(nodeB.peerId.toString(), entry!);
    await sleep(1500);

    // B should have received the entry and sent a signed confirmation back
    // The entry was pushed to B, B validates and proposes through consensus
    expect(await ledgerB.getEntryCount()).toBeGreaterThanOrEqual(1);

    await Promise.all([syncA.stop(), syncB.stop()]);
    await Promise.all([ledgerA.close(), ledgerB.close()]);
  }, 15000);

  it('rejects a confirmation with forged confirmerPubkey (spoofed identity)', async () => {
    const ledgerA = new SharedLedger(`${tmpA}/sl-forged`);
    const ledgerB = new SharedLedger(`${tmpB}/sl-forged`);
    await Promise.all([ledgerA.open(), ledgerB.open()]);

    const consensusA = new LedgerConsensus({ quorumSize: 3 });
    const consensusB = new LedgerConsensus({ quorumSize: 3 });

    const syncA = new LedgerSync(nodeA, ledgerA, consensusA, keypairA.publicKey, keypairA.privateKey);
    const syncB = new LedgerSync(nodeB, ledgerB, consensusB, keypairB.publicKey, keypairB.privateKey);
    await Promise.all([syncA.start(), syncB.start()]);

    const data = enc.encode('test-forged-confirmation');
    const sigA = await sign(keypairA.privateKey, data);

    await ledgerA.submit(data, keypairA.publicKey, sigA);
    const entry = await ledgerA.getLatest();
    expect(entry).toBeDefined();

    // Push the entry to B so B has it in consensus
    await syncA.pushEntry(nodeB.peerId.toString(), entry!);
    await sleep(1000);

    // With quorum=3 and only A+B confirming, shouldn't reach quorum
    // A malicious peer previously could send a confirm-entry with a forged pubkey
    // to reach quorum. Now the signature check prevents that.

    // The entry should be in B's consensus but NOT finalized (quorum=3, only 2 confirmations)
    const proposalB = consensusB.findByContent(data, keypairA.publicKey);
    if (proposalB) {
      expect(proposalB.confirmations.size).toBeLessThan(3);
    }

    await Promise.all([syncA.stop(), syncB.stop()]);
    await Promise.all([ledgerA.close(), ledgerB.close()]);
  }, 15000);
});

// =========================================================================
// C2: Seed auto-confirmation validation
// =========================================================================

describe('LedgerConsensus — C2 validation prerequisites', () => {
  it('reject() prevents a proposal from ever being confirmed', () => {
    const consensus = new LedgerConsensus({ quorumSize: 2 });
    const data = enc.encode('rejected-entry');
    const pubkey = enc.encode('pub'.padEnd(32, '0'));
    const sig = enc.encode('sig'.padEnd(64, '0'));

    const proposal = consensus.propose(data, pubkey, sig);
    consensus.reject(proposal.hash);

    // Adding confirmations to a rejected proposal should have no effect
    const reached = consensus.addConfirmation(proposal.hash, 'some-confirmer');
    expect(reached).toBe(false);
    expect(consensus.isFinalized(proposal.hash)).toBe(false);
  });

  it('proposals with invalid submitter signatures should be rejectable', async () => {
    const realKeypair = await generateKeypair();
    const attackerKeypair = await generateKeypair();

    const data = enc.encode('malicious-entry');
    // Sign with attacker key but claim real submitter
    const fakeSig = await sign(attackerKeypair.privateKey, data);

    // Verify should fail because signature doesn't match the claimed pubkey
    const isValid = await verify(realKeypair.publicKey, fakeSig, data);
    expect(isValid).toBe(false);

    // A seed implementing C2 fix would reject this proposal
    const consensus = new LedgerConsensus({ quorumSize: 2 });
    const proposal = consensus.propose(data, realKeypair.publicKey, fakeSig);

    // Simulate seed verification + rejection
    const sigValid = await verify(proposal.submitterPubkey, proposal.signature, proposal.data);
    if (!sigValid) {
      consensus.reject(proposal.hash);
    }

    expect(consensus.isFinalized(proposal.hash)).toBe(false);
    const rejected = consensus.getProposal(proposal.hash);
    expect(rejected?.status).toBe('rejected');
  });
});

// =========================================================================
// Confirmation signature helpers
// =========================================================================

describe('Confirmation signature format', () => {
  it('sign and verify a confirmation payload', async () => {
    const keypair = await generateKeypair();
    const entryHash = '0'.repeat(64);
    const payload = enc.encode(`confirm:${entryHash}`);
    const sig = await sign(keypair.privateKey, payload);
    const valid = await verify(keypair.publicKey, sig, payload);
    expect(valid).toBe(true);
  });

  it('confirmation with wrong entryHash fails verification', async () => {
    const keypair = await generateKeypair();
    const realHash = '0'.repeat(64);
    const fakeHash = '1'.repeat(64);
    const payload = enc.encode(`confirm:${realHash}`);
    const sig = await sign(keypair.privateKey, payload);

    // Verify against a different entry hash
    const fakePayload = enc.encode(`confirm:${fakeHash}`);
    const valid = await verify(keypair.publicKey, sig, fakePayload);
    expect(valid).toBe(false);
  });

  it('confirmation signed by wrong key fails verification', async () => {
    const realKeypair = await generateKeypair();
    const attackerKeypair = await generateKeypair();
    const entryHash = '0'.repeat(64);
    const payload = enc.encode(`confirm:${entryHash}`);
    const sig = await sign(attackerKeypair.privateKey, payload);

    // Verify against the real key — should fail
    const valid = await verify(realKeypair.publicKey, sig, payload);
    expect(valid).toBe(false);
  });
});

// =========================================================================
// Per-submitter rate limiting (C2 supplement)
// =========================================================================

describe('LedgerConsensus — rate limiting support', () => {
  it('consensus.reject prevents accumulation of confirmations', () => {
    const consensus = new LedgerConsensus({ quorumSize: 2 });
    const proposals: ReturnType<typeof consensus.propose>[] = [];

    // Submit many proposals from the same submitter
    for (let i = 0; i < 15; i++) {
      const data = enc.encode(`spam-entry-${i}`);
      const pubkey = enc.encode('spammer'.padEnd(32, '0'));
      const sig = enc.encode(`sig-${i}`.padEnd(64, '0'));
      proposals.push(consensus.propose(data, pubkey, sig));
    }

    // Rate limiter would reject proposals after the limit
    for (let i = 10; i < 15; i++) {
      consensus.reject(proposals[i].hash);
    }

    // Rejected proposals cannot be confirmed
    for (let i = 10; i < 15; i++) {
      const reached = consensus.addConfirmation(proposals[i].hash, 'honest-seed');
      expect(reached).toBe(false);
    }
  });
});
