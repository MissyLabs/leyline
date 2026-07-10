import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { generateKeypair, sign } from '../src/identity/keypair.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enc = new TextEncoder();

// FEAT-1 / IMP-1: indexed, paginated, provable ledger.
describe('SharedLedger — proof, pagination, submitter index (FEAT-1)', () => {
  let tmpDir: string;
  let ledger: SharedLedger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ledger-feat1-'));
    ledger = new SharedLedger(tmpDir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const submit = (label: string, pubkey: Uint8Array) =>
    ledger.submit(enc.encode(label), pubkey, new Uint8Array(64).fill(1));

  it('produces a verifiable inclusion proof for an entry', async () => {
    const pk = new Uint8Array(32).fill(7);
    for (let i = 0; i < 5; i++) await submit(`e${i}`, pk);

    const proof = await ledger.getProof(2);
    expect(proof).not.toBeNull();
    const head = await ledger.getLatest();
    expect(SharedLedger.verifyProof(proof!, Buffer.from(head!.hash).toString('hex'), 5)).toBe(true);
    expect(proof!.index).toBe(2);
    expect(proof!.latestIndex).toBe(5);
  });

  it('rejects a proof whose target entry data has been tampered', async () => {
    const pk = new Uint8Array(32).fill(7);
    for (let i = 0; i < 4; i++) await submit(`e${i}`, pk);

    const proof = await ledger.getProof(1);
    expect(proof).not.toBeNull();
    const head = await ledger.getLatest();
    const trustedHead = Buffer.from(head!.hash).toString('hex');
    // Tamper with the target entry's data — the recomputed hash chain must break.
    proof!.steps[0].data = Buffer.from(enc.encode('forged')).toString('hex');
    expect(SharedLedger.verifyProof(proof!, trustedHead)).toBe(false);
  });

  it('rejects a proof whose latestHash was swapped', async () => {
    const pk = new Uint8Array(32).fill(7);
    for (let i = 0; i < 3; i++) await submit(`e${i}`, pk);
    const proof = await ledger.getProof(1);
    const head = await ledger.getLatest();
    const trustedHead = Buffer.from(head!.hash).toString('hex');
    proof!.latestHash = 'deadbeef'.repeat(8);
    expect(SharedLedger.verifyProof(proof!, trustedHead)).toBe(false);
  });

  it('returns null for an out-of-range proof index', async () => {
    await submit('only', new Uint8Array(32).fill(7));
    expect(await ledger.getProof(0)).toBeNull();
    expect(await ledger.getProof(99)).toBeNull();
  });

  it('paginates query results with a forward cursor', async () => {
    const pk = new Uint8Array(32).fill(7);
    for (let i = 0; i < 10; i++) await submit(`e${i}`, pk);

    const page1 = await ledger.queryPage({ limit: 4 });
    expect(page1.entries.map((e) => e.index)).toEqual([1, 2, 3, 4]);
    expect(page1.nextCursor).toBe(4);

    const page2 = await ledger.queryPage({ limit: 4, after: page1.nextCursor! });
    expect(page2.entries.map((e) => e.index)).toEqual([5, 6, 7, 8]);

    const page3 = await ledger.queryPage({ limit: 4, after: page2.nextCursor! });
    expect(page3.entries.map((e) => e.index)).toEqual([9, 10]);
    expect(page3.nextCursor).toBeNull();
  });

  it('uses the submitter index to return only a submitter\'s entries', async () => {
    const alice = new Uint8Array(32).fill(1);
    const bob = new Uint8Array(32).fill(2);
    await submit('a1', alice);
    await submit('b1', bob);
    await submit('a2', alice);
    await submit('b2', bob);
    await submit('a3', alice);

    const aliceHex = Buffer.from(alice).toString('hex');
    const results = await ledger.query({ submitterPubkeyHex: aliceHex });
    expect(results.map((e) => new TextDecoder().decode(e.data))).toEqual(['a1', 'a2', 'a3']);
  });

  it('keeps the submitter index consistent after rollbackTo', async () => {
    const alice = new Uint8Array(32).fill(1);
    for (let i = 0; i < 5; i++) await submit(`a${i}`, alice);
    await ledger.rollbackTo(2);

    const aliceHex = Buffer.from(alice).toString('hex');
    const results = await ledger.query({ submitterPubkeyHex: aliceHex });
    expect(results.map((e) => e.index)).toEqual([1, 2]);
    // Re-submitting extends the chain and index cleanly.
    await submit('a-new', alice);
    const after = await ledger.query({ submitterPubkeyHex: aliceHex });
    expect(after.map((e) => e.index)).toEqual([1, 2, 3]);
  });

  it('requestProof round-trips a genuine keypair-signed entry proof', async () => {
    const kp = await generateKeypair();
    const data = enc.encode('provable-fact');
    const sig = await sign(kp.privateKey, data);
    await ledger.submit(data, kp.publicKey, sig);
    const proof = await ledger.getProof(1);
    const head = await ledger.getLatest();
    expect(SharedLedger.verifyProof(proof!, Buffer.from(head!.hash).toString('hex'), 1)).toBe(true);
  });

  // FINDING 4: verifyProof must NOT trust the proof's own head. A fabricated
  // self-consistent proof (whose latestHash matches its own forged chain) must
  // fail when checked against the real trusted head; a genuine proof passes.
  it('rejects a self-consistent forged proof against the real trusted head', async () => {
    const pk = new Uint8Array(32).fill(7);
    for (let i = 0; i < 3; i++) await submit(`real-${i}`, pk); // real chain, 3 entries
    const trustedHead = Buffer.from((await ledger.getLatest())!.hash).toString('hex');

    // Attacker fabricates an entirely different one-step chain and sets its
    // latestHash to its OWN computed hash — internally consistent but bogus.
    const forgedLedgerDir = await mkdtemp(join(tmpdir(), 'ledger-forge-'));
    const forged = new SharedLedger(forgedLedgerDir);
    await forged.open();
    await forged.submit(enc.encode('attacker-controlled'), new Uint8Array(32).fill(42), new Uint8Array(64).fill(1));
    const forgedProof = await forged.getProof(1);
    await forged.close();
    await rm(forgedLedgerDir, { recursive: true, force: true });

    // The forged proof is internally self-consistent...
    expect(forgedProof!.latestHash).toBe(forgedProof!.steps[forgedProof!.steps.length - 1].hash);
    // ...but MUST fail against the real trusted head.
    expect(SharedLedger.verifyProof(forgedProof!, trustedHead)).toBe(false);

    // A genuine proof from the real ledger still verifies against that head.
    const genuine = await ledger.getProof(1);
    expect(SharedLedger.verifyProof(genuine!, trustedHead)).toBe(true);
  });

  it('rejects a genuine proof when checked against a mismatched trusted height', async () => {
    const pk = new Uint8Array(32).fill(7);
    for (let i = 0; i < 4; i++) await submit(`e${i}`, pk);
    const proof = await ledger.getProof(2);
    const trustedHead = Buffer.from((await ledger.getLatest())!.hash).toString('hex');
    // Correct head hash but wrong expected height → reject.
    expect(SharedLedger.verifyProof(proof!, trustedHead, 99)).toBe(false);
    expect(SharedLedger.verifyProof(proof!, trustedHead, 4)).toBe(true);
  });
});
