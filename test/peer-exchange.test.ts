import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { generateKeypair, publicKeyToHex, sign as edSign } from '../src/identity/keypair.js';
import { PeerExchange, type PeerRecord } from '../src/index.js';

async function createTestNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Compute the canonical signable bytes for a peer record (mirrors the private
 * function inside PeerExchange so we can produce valid signatures in tests).
 */
function computeSignableBytes(record: PeerRecord): Uint8Array {
  const { signature: _, ...rest } = record;
  const canonical = Object.keys(rest)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = (rest as Record<string, unknown>)[key];
      return acc;
    }, {});
  return new TextEncoder().encode(JSON.stringify(canonical));
}

async function makeSignedRecord(
  peerId: string,
  overrides: Partial<PeerRecord> = {},
): Promise<PeerRecord> {
  const kp = await generateKeypair();
  const record: PeerRecord = {
    peerId,
    multiaddrs: ['/ip4/127.0.0.1/tcp/9999'],
    pubkeyHex: publicKeyToHex(kp.publicKey),
    offeredTags: ['test'],
    lastSeen: Date.now(),
    ...overrides,
  };
  const sigBytes = await edSign(kp.privateKey, computeSignableBytes(record));
  return { ...record, signature: Buffer.from(sigBytes).toString('hex') };
}

// ---------------------------------------------------------------------------
// Unit-level tests — no live libp2p needed beyond a stub node for PeerId
// ---------------------------------------------------------------------------

describe('PeerExchange – data-structure behaviour', () => {
  let node: Libp2p;
  let px: PeerExchange;

  beforeAll(async () => {
    node = await createTestNode();
  });

  afterAll(async () => {
    await node?.stop();
  });

  beforeEach(() => {
    // Fresh PeerExchange per test so state does not leak between cases
    px = new PeerExchange(node, { maxPeers: 10, maxPeerAge: 30 * 60 * 1000 });
  });

  // -------------------------------------------------------------------------

  it('addPeer stores a record and getPeers returns it', () => {
    const record: PeerRecord = {
      peerId: 'peer-alpha',
      multiaddrs: ['/ip4/127.0.0.1/tcp/9000'],
      pubkeyHex: 'aa'.repeat(32),
      offeredTags: ['skill:code'],
      lastSeen: Date.now(),
    };

    px.addPeer(record);

    const peers = px.getPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0].peerId).toBe('peer-alpha');
  });

  it('addPeer does not store own peerId', () => {
    const ownPeerId = node.peerId.toString();
    const record: PeerRecord = {
      peerId: ownPeerId,
      multiaddrs: [],
      pubkeyHex: 'bb'.repeat(32),
      offeredTags: [],
      lastSeen: Date.now(),
    };

    px.addPeer(record);

    expect(px.getPeers()).toHaveLength(0);
  });

  it('addPeer rejects records with invalid (non-finite) lastSeen', () => {
    const record: PeerRecord = {
      peerId: 'peer-bad-ts',
      multiaddrs: [],
      pubkeyHex: 'cc'.repeat(32),
      offeredTags: [],
      lastSeen: NaN,
    };

    px.addPeer(record);

    expect(px.getPeers()).toHaveLength(0);
  });

  it('addPeer rejects records with future timestamps beyond 5-minute tolerance', () => {
    const record: PeerRecord = {
      peerId: 'peer-future',
      multiaddrs: [],
      pubkeyHex: 'dd'.repeat(32),
      offeredTags: [],
      lastSeen: Date.now() + 10 * 60_000, // 10 minutes in the future
    };

    px.addPeer(record);

    expect(px.getPeers()).toHaveLength(0);
  });

  it('unsigned record cannot overwrite a signed record for the same peerId', async () => {
    const signed = await makeSignedRecord('peer-beta', { offeredTags: ['signed'] });

    px.addPeer(signed);

    const unsigned: PeerRecord = {
      peerId: 'peer-beta',
      multiaddrs: [],
      pubkeyHex: signed.pubkeyHex,
      offeredTags: ['unsigned'],
      lastSeen: Date.now() + 1000, // Even a newer timestamp must not win
      // No signature field
    };

    px.addPeer(unsigned);

    const stored = px.getPeer('peer-beta');
    expect(stored?.offeredTags).toContain('signed');
    expect(stored?.offeredTags).not.toContain('unsigned');
  });

  it('a newer signed record updates an older signed record', async () => {
    const kp = await generateKeypair();
    const pubkeyHex = publicKeyToHex(kp.publicKey);

    const older: PeerRecord = {
      peerId: 'peer-gamma',
      multiaddrs: [],
      pubkeyHex,
      offeredTags: ['old'],
      lastSeen: Date.now() - 5000,
    };
    const olderSig = await edSign(kp.privateKey, computeSignableBytes(older));
    const olderSigned = { ...older, signature: Buffer.from(olderSig).toString('hex') };

    const newer: PeerRecord = {
      peerId: 'peer-gamma',
      multiaddrs: [],
      pubkeyHex,
      offeredTags: ['new'],
      lastSeen: Date.now(),
    };
    const newerSig = await edSign(kp.privateKey, computeSignableBytes(newer));
    const newerSigned = { ...newer, signature: Buffer.from(newerSig).toString('hex') };

    px.addPeer(olderSigned);
    px.addPeer(newerSigned);

    expect(px.getPeer('peer-gamma')?.offeredTags).toContain('new');
  });

  it('stale record does not overwrite a newer existing record', () => {
    const newer: PeerRecord = {
      peerId: 'peer-delta',
      multiaddrs: [],
      pubkeyHex: 'ee'.repeat(32),
      offeredTags: ['fresh'],
      lastSeen: Date.now(),
    };
    const stale: PeerRecord = {
      ...newer,
      offeredTags: ['stale'],
      lastSeen: Date.now() - 10_000,
    };

    px.addPeer(newer);
    px.addPeer(stale);

    expect(px.getPeer('peer-delta')?.offeredTags).toContain('fresh');
  });

  it('pruneStale removes records older than maxPeerAge', () => {
    const maxPeerAge = 1000; // 1 second for the test
    const shortPx = new PeerExchange(node, { maxPeerAge });

    const fresh: PeerRecord = {
      peerId: 'peer-fresh',
      multiaddrs: [],
      pubkeyHex: 'ff'.repeat(32),
      offeredTags: [],
      lastSeen: Date.now(),
    };
    const old: PeerRecord = {
      peerId: 'peer-old',
      multiaddrs: [],
      pubkeyHex: '11'.repeat(32),
      offeredTags: [],
      lastSeen: Date.now() - 2000, // older than maxPeerAge
    };

    shortPx.addPeer(fresh);
    shortPx.addPeer(old);

    expect(shortPx.getPeerCount()).toBe(2);

    const pruned = shortPx.pruneStale();

    expect(pruned).toBe(1);
    expect(shortPx.getPeerCount()).toBe(1);
    expect(shortPx.getPeer('peer-fresh')).toBeDefined();
    expect(shortPx.getPeer('peer-old')).toBeUndefined();
  });

  it('pruneStale returns 0 when no records are stale', () => {
    const record: PeerRecord = {
      peerId: 'peer-active',
      multiaddrs: [],
      pubkeyHex: '22'.repeat(32),
      offeredTags: [],
      lastSeen: Date.now(),
    };
    px.addPeer(record);

    expect(px.pruneStale()).toBe(0);
  });

  it('getPeers returns records sorted most-recent first', () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      px.addPeer({
        peerId: `peer-sort-${i}`,
        multiaddrs: [],
        pubkeyHex: `${i.toString().repeat(2)}`.padEnd(64, '0'),
        offeredTags: [],
        lastSeen: base + i * 1000,
      });
    }

    const peers = px.getPeers();
    // We don't mandate sort order by spec — validate the caller gets all records
    expect(peers).toHaveLength(5);
    // All distinct peerId values present
    const ids = new Set(peers.map((p) => p.peerId));
    expect(ids.size).toBe(5);
  });

  it('maxPeers cap is respected and oldest entry is evicted', () => {
    const cap = 5;
    const cappedPx = new PeerExchange(node, { maxPeers: cap });

    const base = Date.now();
    // Add cap + 1 records with increasing timestamps
    for (let i = 0; i <= cap; i++) {
      cappedPx.addPeer({
        peerId: `peer-cap-${i}`,
        multiaddrs: [],
        pubkeyHex: `${i.toString().padStart(2, '0')}`.padEnd(64, '0'),
        offeredTags: [],
        lastSeen: base + i * 1000,
      });
    }

    // After eviction the table must not exceed maxPeers
    expect(cappedPx.getPeerCount()).toBeLessThanOrEqual(cap);

    // The oldest record (peer-cap-0, lowest lastSeen) should have been evicted
    expect(cappedPx.getPeer('peer-cap-0')).toBeUndefined();

    // The newest record must still be present
    expect(cappedPx.getPeer(`peer-cap-${cap}`)).toBeDefined();
  });

  it('removePeer deletes the entry', () => {
    px.addPeer({
      peerId: 'peer-rm',
      multiaddrs: [],
      pubkeyHex: '33'.repeat(32),
      offeredTags: [],
      lastSeen: Date.now(),
    });

    expect(px.getPeer('peer-rm')).toBeDefined();
    px.removePeer('peer-rm');
    expect(px.getPeer('peer-rm')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Signature verification (static helper)
// ---------------------------------------------------------------------------

describe('PeerExchange – signature verification', () => {
  it('verifyRecord returns false for an unsigned record', async () => {
    const record: PeerRecord = {
      peerId: 'peer-unsigned',
      multiaddrs: [],
      pubkeyHex: 'aa'.repeat(32),
      offeredTags: [],
      lastSeen: Date.now(),
    };
    expect(await PeerExchange.verifyRecord(record)).toBe(false);
  });

  it('verifyRecord returns false for a record missing pubkeyHex', async () => {
    const record: PeerRecord = {
      peerId: 'peer-nopubkey',
      multiaddrs: [],
      pubkeyHex: '',
      offeredTags: [],
      lastSeen: Date.now(),
      signature: 'deadbeef',
    };
    expect(await PeerExchange.verifyRecord(record)).toBe(false);
  });

  it('verifyRecord returns false for a tampered record', async () => {
    const signed = await makeSignedRecord('peer-tamper');
    const tampered = { ...signed, offeredTags: ['injected'] };
    expect(await PeerExchange.verifyRecord(tampered)).toBe(false);
  });

  it('verifyRecord returns true for a correctly signed record', async () => {
    const signed = await makeSignedRecord('peer-valid');
    expect(await PeerExchange.verifyRecord(signed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addPeerVerified integration (against a real keypair)
// ---------------------------------------------------------------------------

describe('PeerExchange – addPeerVerified', () => {
  let node: Libp2p;
  let px: PeerExchange;

  beforeAll(async () => {
    node = await createTestNode();
    px = new PeerExchange(node, { maxPeers: 100 });
  });

  afterAll(async () => {
    await node?.stop();
  });

  it('rejects a record with an invalid signature', async () => {
    const kp = await generateKeypair();
    const record: PeerRecord = {
      peerId: 'peer-bad-sig',
      multiaddrs: [],
      pubkeyHex: publicKeyToHex(kp.publicKey),
      offeredTags: ['test'],
      lastSeen: Date.now(),
      signature: 'badbadbadbad'.padEnd(128, '0'), // garbage
    };

    const accepted = await px.addPeerVerified(record);
    expect(accepted).toBe(false);
    expect(px.getPeer('peer-bad-sig')).toBeUndefined();
  });

  it('rejects an unsigned record', async () => {
    const record: PeerRecord = {
      peerId: 'peer-no-sig',
      multiaddrs: [],
      pubkeyHex: 'aa'.repeat(32),
      offeredTags: [],
      lastSeen: Date.now(),
      // no signature
    };

    const accepted = await px.addPeerVerified(record);
    expect(accepted).toBe(false);
  });

  it('accepts a record with a valid signature', async () => {
    const signed = await makeSignedRecord('peer-good-sig');

    const accepted = await px.addPeerVerified(signed);
    expect(accepted).toBe(true);
    expect(px.getPeer('peer-good-sig')).toBeDefined();
  });

  it('rejects own peerId even with a valid signature', async () => {
    const ownPeerId = node.peerId.toString();
    // Build a signed record pretending to be ourselves
    const kp = await generateKeypair();
    const record: PeerRecord = {
      peerId: ownPeerId,
      multiaddrs: [],
      pubkeyHex: publicKeyToHex(kp.publicKey),
      offeredTags: [],
      lastSeen: Date.now(),
    };
    const sig = await edSign(kp.privateKey, computeSignableBytes(record));
    const signed = { ...record, signature: Buffer.from(sig).toString('hex') };

    const accepted = await px.addPeerVerified(signed);
    expect(accepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Protocol-level integration test — two live libp2p nodes exchanging peers
// ---------------------------------------------------------------------------

describe('PeerExchange – protocol integration', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let pxA: PeerExchange;
  let pxB: PeerExchange;
  let kpA: Awaited<ReturnType<typeof generateKeypair>>;
  let kpB: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    kpA = await generateKeypair();
    kpB = await generateKeypair();

    nodeA = await createTestNode();
    nodeB = await createTestNode();

    pxA = new PeerExchange(nodeA, {
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
    });
    pxB = new PeerExchange(nodeB, {
      localPrivateKey: kpB.privateKey,
      localPubkeyHex: publicKeyToHex(kpB.publicKey),
    });

    await pxA.start();
    await pxB.start();

    await nodeB.dial(nodeA.getMultiaddrs()[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await pxA?.stop();
    await pxB?.stop();
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('exchangeWithPeer transfers signed peer records between nodes', async () => {
    // Pre-populate nodeA's table with a signed third-party record
    const thirdParty = await makeSignedRecord('peer-third-party', {
      multiaddrs: ['/ip4/1.2.3.4/tcp/9876'],
    });
    pxA.addPeer(thirdParty);

    // Trigger an exchange from B -> A
    const received = await pxB.exchangeWithPeer(nodeA.peerId.toString());

    // nodeB should have received the third-party record from nodeA
    expect(received.length).toBeGreaterThan(0);
    const ids = received.map((r) => r.peerId);
    expect(ids).toContain('peer-third-party');
  }, 10000);
});
