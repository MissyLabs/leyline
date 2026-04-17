import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function latestIndex(ledger: SharedLedger): Promise<number> {
  const entry = await ledger.getLatest();
  return entry?.index ?? 0;
}

describe('SharedLedger — concurrent submit + rollback', () => {
  let ledger: SharedLedger;
  let dir: string;

  const key = new Uint8Array(32).fill(1);
  const sig = new Uint8Array(64).fill(2);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ledger-conc-'));
    ledger = new SharedLedger(dir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('concurrent submits produce sequential indices', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        ledger.submit(new Uint8Array([i]), key, sig),
      ),
    );
    const indices = results.map((r) => r.index).sort((a, b) => a - b);
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('hash chain is valid after concurrent submits', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        ledger.submit(new Uint8Array([i]), key, sig),
      ),
    );

    const valid = await ledger.verify();
    expect(valid).toBe(true);
  });

  it('rollback during concurrent submits does not corrupt chain', async () => {
    for (let i = 0; i < 5; i++) {
      await ledger.submit(new Uint8Array([i]), key, sig);
    }

    await Promise.all([
      ledger.rollbackTo(3),
      ledger.submit(new Uint8Array([99]), key, sig),
    ]);

    const valid = await ledger.verify();
    expect(valid).toBe(true);
    const idx = await latestIndex(ledger);
    expect(idx).toBeGreaterThanOrEqual(3);
  });

  it('rollback to 0 then submit starts fresh chain', async () => {
    await ledger.submit(new Uint8Array([1]), key, sig);
    await ledger.submit(new Uint8Array([2]), key, sig);
    await ledger.rollbackTo(0);

    const entry = await ledger.submit(new Uint8Array([3]), key, sig);
    expect(entry.index).toBe(1);
    expect(entry.prevHash).toEqual(new Uint8Array(0));
    const valid = await ledger.verify();
    expect(valid).toBe(true);
  });

  it('rollback to current index is a no-op', async () => {
    await ledger.submit(new Uint8Array([1]), key, sig);
    await ledger.submit(new Uint8Array([2]), key, sig);
    const idx = await latestIndex(ledger);
    await ledger.rollbackTo(idx);
    expect(await latestIndex(ledger)).toBe(idx);
  });

  it('rollback to future index is a no-op', async () => {
    await ledger.submit(new Uint8Array([1]), key, sig);
    const idx = await latestIndex(ledger);
    await ledger.rollbackTo(idx + 100);
    expect(await latestIndex(ledger)).toBe(idx);
  });

  it('addConfirmation after rollback returns null for rolled-back entry', async () => {
    await ledger.submit(new Uint8Array([1]), key, sig);
    const e2 = await ledger.submit(new Uint8Array([2]), key, sig);
    await ledger.rollbackTo(1);

    const confirmerKey = new Uint8Array(32).fill(3);
    const result = await ledger.addConfirmation(e2.index, confirmerKey);
    expect(result).toBeNull();
    expect(await latestIndex(ledger)).toBe(1);
  });

  it('survives rapid submit-rollback-submit cycles', async () => {
    for (let cycle = 0; cycle < 5; cycle++) {
      await ledger.submit(new Uint8Array([cycle * 2]), key, sig);
      await ledger.submit(new Uint8Array([cycle * 2 + 1]), key, sig);
      const idx = await latestIndex(ledger);
      await ledger.rollbackTo(idx - 1);
    }

    const valid = await ledger.verify();
    expect(valid).toBe(true);
    expect(await latestIndex(ledger)).toBeGreaterThan(0);
  });

  it('getRange returns empty for rolled-back range', async () => {
    for (let i = 0; i < 5; i++) {
      await ledger.submit(new Uint8Array([i]), key, sig);
    }
    await ledger.rollbackTo(2);

    const range = await ledger.getRange(3, 5);
    expect(range).toEqual([]);
  });

  it('persistence survives rollback and reopen', async () => {
    for (let i = 0; i < 5; i++) {
      await ledger.submit(new Uint8Array([i]), key, sig);
    }
    await ledger.rollbackTo(3);
    await ledger.close();

    const ledger2 = new SharedLedger(dir);
    await ledger2.open();
    expect(await latestIndex(ledger2)).toBe(3);
    const valid = await ledger2.verify();
    expect(valid).toBe(true);
    await ledger2.close();
  });
});
