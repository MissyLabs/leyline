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

/** Build a cryptographically valid divergent peer chain with real confirmer sigs. */
async function makeSignedChain(
  specs: Array<{ index: number; data: string; confirmations?: number; submitter?: { publicKey: Uint8Array; privateKey: Uint8Array } }>,
  prevHash: Uint8Array,
): Promise<SharedLedgerEntry[]> {
  const defaultSubmitter = await generateKeypair();
  const result: SharedLedgerEntry[] = [];
  let prev = prevHash;
  for (const spec of specs) {
    const submitter = spec.submitter ?? defaultSubmitter;
    const data = enc.encode(spec.data);
    const timestamp = Date.now();
    const submitterPubkey = submitter.publicKey;
    const hash = computeEntryHash({ index: spec.index, prevHash: prev, data, submitterPubkey, timestamp });
    const signature = await sign(submitter.privateKey, data);
    const confirmerPubkeys: Uint8Array[] = [];
    const confirmerSignatures: Uint8Array[] = [];
    const confirmData = enc.encode(`confirm:${toHex(hash)}`);
    for (let c = 0; c < (spec.confirmations ?? 0); c++) {
      const ckp = await generateKeypair();
      confirmerPubkeys.push(ckp.publicKey);
      confirmerSignatures.push(await sign(ckp.privateKey, confirmData));
    }
    result.push({
      index: spec.index, prevHash: prev, hash, data, submitterPubkey, signature,
      timestamp, confirmations: confirmerPubkeys.length, confirmerPubkeys, confirmerSignatures,
    });
    prev = hash;
  }
  return result;
}

describe('ForkResolver — adoption correctness & anti-inflation (regression)', () => {
  let tmpDir: string;
  let ledger: SharedLedger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fork-regress-'));
    ledger = new SharedLedger(tmpDir);
    await ledger.open();
  });

  afterEach(async () => {
    await ledger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const submit = (label: string) =>
    ledger.submit(enc.encode(label), new Uint8Array(32).fill(9), new Uint8Array(64).fill(2));

  // FINDING 1: adoption must PRESERVE the peer entry's hash (no re-timestamp /
  // re-hash), so the adopted local head equals the peer head and a re-run
  // detects NO fork.
  it('adopts a peer chain and converges to the exact peer head hash', async () => {
    const common = await submit('common-0'); // index 1
    await submit('local-1');                  // index 2
    await submit('local-2');                  // index 3 (local suffix length 2)

    // Peer suffix (3 entries, more confirmations) wins.
    const peerDivergent = await makeSignedChain([
      { index: 2, data: 'peer-2', confirmations: 3 },
      { index: 3, data: 'peer-3', confirmations: 3 },
      { index: 4, data: 'peer-4', confirmations: 3 },
    ], common.hash);
    const peer = makeMockPeer([common], peerDivergent);

    const fork = await new ForkResolver(ledger).resolve(peer);
    expect(fork!.winner).toBe('peer');
    expect(fork!.resolved).toBe(true);

    const peerHead = peerDivergent[peerDivergent.length - 1];
    const localHead = await ledger.getLatest();
    // The crux: adopted head hash must EQUAL the validated peer head hash.
    expect(toHex(localHead!.hash)).toBe(toHex(peerHead.hash));
    expect(await ledger.getEntryCount()).toBe(4);

    // Re-running resolution against the same peer must now see NO fork.
    const second = await new ForkResolver(ledger).resolve(peer);
    expect(second).toBeNull();
  });

  // FINDING 2: a single confirmer key repeated N times must count as weight 1,
  // so it cannot force a reorg it should lose.
  it('counts a confirmer repeated N times as weight 1 (no inflated reorg)', async () => {
    const common = await submit('common-0'); // index 1
    const local1 = await submit('local-1');  // index 2 (local suffix length 1)

    // Give the LOCAL entry 2 genuine, distinct confirmations → localConfs = 2.
    const localConfData = enc.encode(`confirm:${toHex(local1.hash)}`);
    for (let c = 0; c < 2; c++) {
      const ckp = await generateKeypair();
      await ledger.addConfirmation(local1.index, ckp.publicKey, await sign(ckp.privateKey, localConfData));
    }

    // Peer suffix: ONE entry, one valid confirmer repeated 3 times.
    const submitterKp = await generateKeypair();
    const data = enc.encode('peer-2');
    const timestamp = Date.now();
    const hash = computeEntryHash({ index: 2, prevHash: common.hash, data, submitterPubkey: submitterKp.publicKey, timestamp });
    const confirmerKp = await generateKeypair();
    const confSig = await sign(confirmerKp.privateKey, enc.encode(`confirm:${toHex(hash)}`));
    const peerEntry: SharedLedgerEntry = {
      index: 2, prevHash: common.hash, hash, data,
      submitterPubkey: submitterKp.publicKey, signature: await sign(submitterKp.privateKey, data),
      timestamp,
      confirmations: 3,
      confirmerPubkeys: [confirmerKp.publicKey, confirmerKp.publicKey, confirmerKp.publicKey],
      confirmerSignatures: [confSig, confSig, confSig],
    };

    const fork = await new ForkResolver(ledger).resolve(makeMockPeer([common], [peerEntry]));
    // Deduped: peer weight is 1, not 3.
    expect(fork!.peerConfirmations).toBe(1);
    expect(fork!.localConfirmations).toBe(2);
    expect(fork!.winner).toBe('local');
    // Local entry preserved.
    expect(new TextDecoder().decode((await ledger.getEntry(2))!.data)).toBe('local-1');
  });

  // FINDING 3: a peer suffix containing an unauthorized submitter must be
  // refused even when it would otherwise win the reorg.
  it('refuses a winning reorg whose suffix contains an unauthorized submitter', async () => {
    const common = await submit('common-0'); // index 1
    await submit('local-1');                  // index 2 (local suffix length 1)

    const authorized = await generateKeypair();
    const unauthorized = await generateKeypair();

    // Peer suffix would win (longer + more confirmations) but one entry's
    // submitter is not on the allow-list.
    const peerDivergent = await makeSignedChain([
      { index: 2, data: 'peer-2', confirmations: 5, submitter: authorized },
      { index: 3, data: 'peer-3', confirmations: 5, submitter: unauthorized },
    ], common.hash);
    const peer = makeMockPeer([common], peerDivergent);

    const authorizedHex = toHex(authorized.publicKey);
    const resolver = new ForkResolver(ledger, {
      isSubmitterAuthorized: (hex) => hex === authorizedHex,
    });
    const fork = await resolver.resolve(peer);

    expect(fork!.winner).toBe('local'); // refused despite otherwise winning
    expect(await ledger.getEntryCount()).toBe(2);
    expect(new TextDecoder().decode((await ledger.getEntry(2))!.data)).toBe('local-1');
  });

  // Control: an authorized-only winning suffix still adopts under the same gate.
  it('adopts a winning suffix when every submitter is authorized', async () => {
    const common = await submit('common-0'); // index 1
    await submit('local-1');                  // index 2

    const authorized = await generateKeypair();
    const peerDivergent = await makeSignedChain([
      { index: 2, data: 'peer-2', confirmations: 5, submitter: authorized },
      { index: 3, data: 'peer-3', confirmations: 5, submitter: authorized },
    ], common.hash);

    const authorizedHex = toHex(authorized.publicKey);
    const resolver = new ForkResolver(ledger, {
      isSubmitterAuthorized: (hex) => hex === authorizedHex,
    });
    const fork = await resolver.resolve(makeMockPeer([common], peerDivergent));
    expect(fork!.winner).toBe('peer');
    expect(await ledger.getEntryCount()).toBe(3);
  });
});
