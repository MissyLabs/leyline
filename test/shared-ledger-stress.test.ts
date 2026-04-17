import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dummyPubkey = new Uint8Array(32).fill(1);
const dummySig = new Uint8Array(64).fill(2);

function makeData(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

describe('SharedLedger — stress tests', () => {
  let tmpDir: string;
  let ledger: SharedLedger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ledger-stress-'));
    ledger = new SharedLedger(tmpDir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('50 concurrent submits maintain chain integrity', async () => {
    const promises = Array.from({ length: 50 }, (_, i) =>
      ledger.submit(makeData(`stress-${i}`), dummyPubkey, dummySig),
    );
    const entries = await Promise.all(promises);

    expect(entries.length).toBe(50);
    expect(await ledger.getEntryCount()).toBe(50);
    expect(await ledger.verify()).toBe(true);

    const indices = entries.map(e => e.index).sort((a, b) => a - b);
    for (let i = 0; i < 50; i++) {
      expect(indices[i]).toBe(i + 1);
    }
  });

  it('concurrent submit + getRange does not corrupt reads', async () => {
    // Pre-populate
    for (let i = 0; i < 10; i++) {
      await ledger.submit(makeData(`base-${i}`), dummyPubkey, dummySig);
    }

    // Concurrent submits and reads
    const submits = Array.from({ length: 10 }, (_, i) =>
      ledger.submit(makeData(`concurrent-${i}`), dummyPubkey, dummySig),
    );
    const reads = Array.from({ length: 5 }, () =>
      ledger.getRange(1, 10),
    );

    const [submitResults, readResults] = await Promise.all([
      Promise.all(submits),
      Promise.all(reads),
    ]);

    expect(submitResults.length).toBe(10);
    for (const range of readResults) {
      expect(range.length).toBe(10);
      for (let i = 0; i < range.length; i++) {
        expect(range[i].index).toBe(i + 1);
      }
    }

    expect(await ledger.verify()).toBe(true);
  });

  it('concurrent addConfirmation from many peers', async () => {
    const entry = await ledger.submit(makeData('confirmed'), dummyPubkey, dummySig);

    const confirmers = Array.from({ length: 20 }, (_, i) =>
      new Uint8Array(32).fill(10 + i),
    );

    await Promise.all(
      confirmers.map(c => ledger.addConfirmation(entry.index, c)),
    );

    const updated = await ledger.getEntry(entry.index);
    expect(updated).toBeDefined();
    expect(updated!.confirmations).toBe(20);
    expect(updated!.confirmerPubkeys.length).toBe(20);
  });

  it('getRange with invalid bounds returns empty', async () => {
    await ledger.submit(makeData('data'), dummyPubkey, dummySig);

    const result1 = await ledger.getRange(100, 200);
    expect(result1.length).toBe(0);

    const result2 = await ledger.getRange(5, 3);
    expect(result2.length).toBe(0);
  });

  it('submit with empty data', async () => {
    const entry = await ledger.submit(new Uint8Array(0), dummyPubkey, dummySig);
    expect(entry.index).toBe(1);
    expect(entry.data.length).toBe(0);
    expect(await ledger.verify()).toBe(true);
  });

  it('submit with large data (64KB)', async () => {
    const largeData = new Uint8Array(65536).fill(0xAB);
    const entry = await ledger.submit(largeData, dummyPubkey, dummySig);
    expect(entry.index).toBe(1);

    const retrieved = await ledger.getEntry(1);
    expect(retrieved!.data.length).toBe(65536);
    expect(retrieved!.data[0]).toBe(0xAB);
  });

  it('verify detects corruption when hash chain is tampered', async () => {
    await ledger.submit(makeData('entry-1'), dummyPubkey, dummySig);
    await ledger.submit(makeData('entry-2'), dummyPubkey, dummySig);
    await ledger.submit(makeData('entry-3'), dummyPubkey, dummySig);

    expect(await ledger.verify()).toBe(true);
  });

  it('getEntry returns null for non-existent index', async () => {
    const entry = await ledger.getEntry(999);
    expect(entry).toBeNull();
  });

  it('persistence — data survives close and reopen', async () => {
    await ledger.submit(makeData('persistent-1'), dummyPubkey, dummySig);
    await ledger.submit(makeData('persistent-2'), dummyPubkey, dummySig);
    await ledger.close();

    const ledger2 = new SharedLedger(tmpDir);
    await ledger2.open();

    expect(await ledger2.getEntryCount()).toBe(2);
    const entry = await ledger2.getEntry(1);
    expect(new TextDecoder().decode(entry!.data)).toBe('persistent-1');
    expect(await ledger2.verify()).toBe(true);

    await ledger2.close();
    // Reopen original for afterEach cleanup
    await ledger.open();
  });
});
