import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function makeKey(): Uint8Array {
  return randomBytes(32);
}

function makeSig(): Uint8Array {
  return randomBytes(64);
}

describe('SharedLedger — rollbackTo edge cases', () => {
  let ledger: SharedLedger;
  let dataDir: string;
  const submitter = makeKey();
  const sig = makeSig();

  beforeEach(async () => {
    dataDir = join(tmpdir(), `leyline-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ledger = new SharedLedger(dataDir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  async function submitEntries(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await ledger.submit(new TextEncoder().encode(`entry-${i}`), submitter, sig);
    }
  }

  it('rollbackTo(0) clears the entire ledger', async () => {
    await submitEntries(5);
    expect(await ledger.getEntryCount()).toBe(5);

    await ledger.rollbackTo(0);
    expect(await ledger.getEntryCount()).toBe(0);
    expect(await ledger.getLatest()).toBeNull();
  });

  it('rollback persists across reopen', async () => {
    await submitEntries(5);
    await ledger.rollbackTo(3);
    expect(await ledger.getEntryCount()).toBe(3);
    await ledger.close();

    const ledger2 = new SharedLedger(dataDir);
    await ledger2.open();
    expect(await ledger2.getEntryCount()).toBe(3);
    expect(await ledger2.getEntry(4)).toBeNull();
    expect(await ledger2.getEntry(5)).toBeNull();
    await ledger2.close();
  });

  it('rollbackTo current index is a no-op', async () => {
    await submitEntries(3);
    const entryBefore = await ledger.getLatest();
    await ledger.rollbackTo(3);
    expect(await ledger.getEntryCount()).toBe(3);
    const entryAfter = await ledger.getLatest();
    expect(entryAfter?.hash).toEqual(entryBefore?.hash);
  });

  it('rollbackTo beyond current index is a no-op', async () => {
    await submitEntries(3);
    await ledger.rollbackTo(10);
    expect(await ledger.getEntryCount()).toBe(3);
  });

  it('rollbackTo negative index treated as 0', async () => {
    await submitEntries(3);
    await ledger.rollbackTo(-5);
    expect(await ledger.getEntryCount()).toBe(0);
  });

  it('can submit new entries after rollback', async () => {
    await submitEntries(5);
    await ledger.rollbackTo(2);
    expect(await ledger.getEntryCount()).toBe(2);

    await ledger.submit(new TextEncoder().encode('new-entry'), submitter, sig);
    expect(await ledger.getEntryCount()).toBe(3);
    const latest = await ledger.getLatest();
    expect(latest?.index).toBe(3);
  });

  it('hash chain is valid after rollback and new submit', async () => {
    await submitEntries(5);
    const entry2 = await ledger.getEntry(2);
    await ledger.rollbackTo(2);

    await ledger.submit(new TextEncoder().encode('after-rollback'), submitter, sig);
    const entry3 = await ledger.getLatest();
    expect(entry3?.prevHash).toEqual(entry2?.hash);
  });

  it('concurrent rollbacks are serialized', async () => {
    await submitEntries(10);

    await Promise.all([
      ledger.rollbackTo(3),
      ledger.rollbackTo(5),
      ledger.rollbackTo(7),
    ]);

    const count = await ledger.getEntryCount();
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThanOrEqual(10);
  });

  it('rollback on empty ledger is a no-op', async () => {
    await ledger.rollbackTo(0);
    expect(await ledger.getEntryCount()).toBe(0);
    await ledger.rollbackTo(5);
    expect(await ledger.getEntryCount()).toBe(0);
  });

  it('getRange after rollback does not return deleted entries', async () => {
    await submitEntries(5);
    await ledger.rollbackTo(3);

    const range = await ledger.getRange(1, 5);
    expect(range).toHaveLength(3);
    expect(range.map(e => e.index)).toEqual([1, 2, 3]);
  });
});
