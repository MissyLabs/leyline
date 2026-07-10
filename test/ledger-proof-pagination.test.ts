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
    expect(SharedLedger.verifyProof(proof!)).toBe(true);
    expect(proof!.index).toBe(2);
    expect(proof!.latestIndex).toBe(5);
  });

  it('rejects a proof whose target entry data has been tampered', async () => {
    const pk = new Uint8Array(32).fill(7);
    for (let i = 0; i < 4; i++) await submit(`e${i}`, pk);

    const proof = await ledger.getProof(1);
    expect(proof).not.toBeNull();
    // Tamper with the target entry's data — the recomputed hash chain must break.
    proof!.steps[0].data = Buffer.from(enc.encode('forged')).toString('hex');
    expect(SharedLedger.verifyProof(proof!)).toBe(false);
  });

  it('rejects a proof whose latestHash was swapped', async () => {
    const pk = new Uint8Array(32).fill(7);
    for (let i = 0; i < 3; i++) await submit(`e${i}`, pk);
    const proof = await ledger.getProof(1);
    proof!.latestHash = 'deadbeef'.repeat(8);
    expect(SharedLedger.verifyProof(proof!)).toBe(false);
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
    expect(SharedLedger.verifyProof(proof!)).toBe(true);
  });
});
