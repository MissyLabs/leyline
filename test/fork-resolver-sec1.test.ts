import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedLedger, computeEntryHash, type SharedLedgerEntry } from '../src/ledger/shared-ledger.js';
import { ForkResolver, type PeerChainQuerier } from '../src/ledger/fork-resolver.js';
import { generateKeypair, sign } from '../src/identity/keypair.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGlobalLogLevel, LogLevel } from '../src/utils/logger.js';

setGlobalLogLevel(LogLevel.SILENT);

const enc = new TextEncoder();
const toHex = (a: Uint8Array) => Buffer.from(a).toString('hex');

function makeMockPeer(common: SharedLedgerEntry[], divergent: SharedLedgerEntry[]): PeerChainQuerier {
  const all = [...common, ...divergent];
  return {
    async getEntryHash(index) { const e = all.find((x) => x.index === index); return e ? toHex(e.hash) : null; },
    async getRange(s, e) { return all.filter((x) => x.index >= s && x.index <= e); },
    async getEntryCount() { return all.length; },
  };
}

// SEC-1: the fork resolver must not adopt a peer chain on the strength of
// fabricated confirmation counts, fabricated hashes, or invalid signatures.
describe('ForkResolver — SEC-1 confirmation forgery resistance', () => {
  let tmpDir: string;
  let ledger: SharedLedger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fork-sec1-'));
    ledger = new SharedLedger(tmpDir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const submit = (label: string) => ledger.submit(enc.encode(label), new Uint8Array(32).fill(9), new Uint8Array(64).fill(2));

  it('refuses a reorg when the peer inflates confirmations with no signatures', async () => {
    const common = await submit('common-0');
    await submit('local-1');
    await submit('local-2');

    // Peer serves a chain claiming a huge confirmation count but supplies NO
    // confirmer signatures (confirmerSignatures empty) — must not win.
    const kp = await generateKeypair();
    let prev = common.hash;
    const peerDivergent: SharedLedgerEntry[] = [];
    for (const [i, label] of ['peer-1', 'peer-2'].entries()) {
      const idx = 2 + i;
      const data = enc.encode(label);
      const ts = Date.now();
      const hash = computeEntryHash({ index: idx, prevHash: prev, data, submitterPubkey: kp.publicKey, timestamp: ts });
      peerDivergent.push({
        index: idx, prevHash: prev, hash, data,
        submitterPubkey: kp.publicKey, signature: await sign(kp.privateKey, data),
        timestamp: ts,
        confirmations: 9999,
        confirmerPubkeys: Array.from({ length: 9999 }, (_, k) => new Uint8Array(32).fill(k % 255)),
        confirmerSignatures: [], // no proofs!
      });
      prev = hash;
    }

    const fork = await new ForkResolver(ledger).resolve(makeMockPeer([common], peerDivergent));
    expect(fork!.peerConfirmations).toBe(0); // unproven confirmations don't count
    expect(fork!.winner).toBe('local');
    // Local chain preserved.
    expect(new TextDecoder().decode((await ledger.getEntry(2))!.data)).toBe('local-1');
  });

  it('refuses a reorg when a peer entry has an invalid submitter signature', async () => {
    const common = await submit('common-0');
    await submit('local-1');

    // Longer peer chain (would win by length) but entries are not validly signed.
    const badPub = new Uint8Array(32).fill(3);
    const badSig = new Uint8Array(64).fill(4);
    let prev = common.hash;
    const peerDivergent: SharedLedgerEntry[] = [];
    for (const [i, label] of ['p1', 'p2', 'p3'].entries()) {
      const idx = 1 + i;
      // index starts at divergence (2)? common is index 1, so divergence at 2.
      const realIdx = 2 + i;
      const data = enc.encode(label);
      const ts = Date.now();
      const hash = computeEntryHash({ index: realIdx, prevHash: prev, data, submitterPubkey: badPub, timestamp: ts });
      peerDivergent.push({
        index: realIdx, prevHash: prev, hash, data,
        submitterPubkey: badPub, signature: badSig, // invalid signature
        timestamp: ts, confirmations: 0, confirmerPubkeys: [], confirmerSignatures: [],
      });
      prev = hash;
      void i; void label;
    }

    const fork = await new ForkResolver(ledger).resolve(makeMockPeer([common], peerDivergent));
    expect(fork!.winner).toBe('local'); // invalid signatures block adoption
    expect(await ledger.getEntryCount()).toBe(2);
  });

  it('accepts a reorg backed by genuine confirmer signatures', async () => {
    const common = await submit('common-0');
    await submit('local-1');

    const kp = await generateKeypair();
    const data = enc.encode('peer-1');
    const ts = Date.now();
    const hash = computeEntryHash({ index: 2, prevHash: common.hash, data, submitterPubkey: kp.publicKey, timestamp: ts });
    const confirmData = enc.encode(`confirm:${toHex(hash)}`);
    const confirmerPubkeys: Uint8Array[] = [];
    const confirmerSignatures: Uint8Array[] = [];
    for (let c = 0; c < 3; c++) {
      const ckp = await generateKeypair();
      confirmerPubkeys.push(ckp.publicKey);
      confirmerSignatures.push(await sign(ckp.privateKey, confirmData));
    }
    const peerDivergent: SharedLedgerEntry[] = [{
      index: 2, prevHash: common.hash, hash, data,
      submitterPubkey: kp.publicKey, signature: await sign(kp.privateKey, data),
      timestamp: ts, confirmations: 3, confirmerPubkeys, confirmerSignatures,
    }];

    const fork = await new ForkResolver(ledger).resolve(makeMockPeer([common], peerDivergent));
    expect(fork!.peerConfirmations).toBe(3);
    expect(fork!.winner).toBe('peer');
    expect(new TextDecoder().decode((await ledger.getEntry(2))!.data)).toBe('peer-1');
  });
});
