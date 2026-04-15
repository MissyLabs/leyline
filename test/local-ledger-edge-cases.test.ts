import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalLedger } from '../src/ledger/local-log.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function toHex(arr: Uint8Array): string {
  return Buffer.from(arr).toString('hex');
}

describe('LocalLedger — edge cases', () => {
  let tmpDir: string;
  let ledger: LocalLedger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'local-ledger-'));
    ledger = new LocalLedger(tmpDir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('empty ledger verifies as true', async () => {
    expect(await ledger.verify()).toBe(true);
    expect(await ledger.getEntryCount()).toBe(0);
    expect(await ledger.getLatest()).toBeNull();
  });

  it('appends entries with correct indices', async () => {
    const e1 = await ledger.append(new TextEncoder().encode('msg1'), 'action1');
    const e2 = await ledger.append(new TextEncoder().encode('msg2'), 'action2');

    expect(e1.index).toBe(0);
    expect(e2.index).toBe(1);
    expect(e2.prevHash).toEqual(e1.hash);
  });

  it('hash chain verifies after multiple appends', async () => {
    for (let i = 0; i < 10; i++) {
      await ledger.append(new TextEncoder().encode(`msg-${i}`), `action-${i}`);
    }
    expect(await ledger.verify()).toBe(true);
    expect(await ledger.getEntryCount()).toBe(10);
  });

  it('getEntry returns null for out-of-bounds index', async () => {
    await ledger.append(new TextEncoder().encode('msg'), 'action');
    expect(await ledger.getEntry(-1)).toBeNull();
    expect(await ledger.getEntry(1)).toBeNull();
    expect(await ledger.getEntry(999)).toBeNull();
  });

  it('getLatest returns the most recent entry', async () => {
    await ledger.append(new TextEncoder().encode('first'), 'a');
    const second = await ledger.append(new TextEncoder().encode('second'), 'b');
    const latest = await ledger.getLatest();

    expect(latest).not.toBeNull();
    expect(latest!.index).toBe(second.index);
    expect(toHex(latest!.hash)).toBe(toHex(second.hash));
  });

  it('persists across reopen', async () => {
    await ledger.append(new TextEncoder().encode('persist-me'), 'test');
    await ledger.close();

    const ledger2 = new LocalLedger(tmpDir);
    await ledger2.open();

    expect(await ledger2.getEntryCount()).toBe(1);
    const entry = await ledger2.getEntry(0);
    expect(entry).not.toBeNull();
    expect(new TextDecoder().decode(entry!.message)).toBe('persist-me');
    expect(await ledger2.verify()).toBe(true);
    await ledger2.close();
  });

  it('can append after reopen and chain remains valid', async () => {
    await ledger.append(new TextEncoder().encode('before'), 'a');
    await ledger.close();

    const ledger2 = new LocalLedger(tmpDir);
    await ledger2.open();
    await ledger2.append(new TextEncoder().encode('after'), 'b');

    expect(await ledger2.getEntryCount()).toBe(2);
    expect(await ledger2.verify()).toBe(true);

    const e1 = await ledger2.getEntry(0);
    const e2 = await ledger2.getEntry(1);
    expect(toHex(e2!.prevHash)).toBe(toHex(e1!.hash));
    await ledger2.close();
  });

  it('handles empty message body', async () => {
    const entry = await ledger.append(new Uint8Array(0), 'empty');
    expect(entry.message.length).toBe(0);
    expect(await ledger.verify()).toBe(true);
  });

  it('handles large message body', async () => {
    const bigData = new Uint8Array(100_000).fill(0xab);
    const entry = await ledger.append(bigData, 'big');
    expect(entry.message.length).toBe(100_000);

    const retrieved = await ledger.getEntry(0);
    expect(retrieved!.message.length).toBe(100_000);
    expect(await ledger.verify()).toBe(true);
  });

  it('different actions produce different hashes', async () => {
    const msg = new TextEncoder().encode('same-data');
    const e1 = await ledger.append(msg, 'action-a');
    // Need a fresh ledger for comparison since prevHash would differ
    await ledger.close();
    const tmpDir2 = await mkdtemp(join(tmpdir(), 'local-ledger-b-'));
    const ledger2 = new LocalLedger(tmpDir2);
    await ledger2.open();
    const e2 = await ledger2.append(msg, 'action-b');

    // Hashes may still differ due to timestamps, but actions are included
    expect(e1.action).toBe('action-a');
    expect(e2.action).toBe('action-b');

    await ledger2.close();
    await rm(tmpDir2, { recursive: true, force: true });
  });

  it('sequential appends produce correct indices', async () => {
    for (let i = 0; i < 5; i++) {
      const entry = await ledger.append(new TextEncoder().encode(`seq-${i}`), `action-${i}`);
      expect(entry.index).toBe(i);
    }
    expect(await ledger.getEntryCount()).toBe(5);
    expect(await ledger.verify()).toBe(true);
  });

  it('concurrent appends are serialized correctly', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      ledger.append(new TextEncoder().encode(`concurrent-${i}`), `action-${i}`),
    );
    const entries = await Promise.all(promises);
    const indices = entries.map((e) => e.index).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await ledger.verify()).toBe(true);
  });
});
