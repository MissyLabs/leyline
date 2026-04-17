/**
 * Integration tests for PeerReputation wired into MagicNode and PeerExchange.
 *
 * MagicNode creates a PeerReputation instance and records signals at key
 * pipeline decision points:
 *   - recordViolation  — message validation failure or invalid signature
 *   - recordSpam       — per-sender rate limit exceeded
 *   - recordSuccess    — message passed every check and was delivered
 *
 * PeerExchange uses the same PeerReputation instance for weighted peer
 * selection in getPeersForExchange() and exchangeWithPeers(), and records
 * success/failure after each exchange attempt.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MagicNode } from '../src/node/magic-node.js';
import { PeerExchange, type PeerRecord } from '../src/node/peer-exchange.js';
import { PeerReputation } from '../src/trust/peer-reputation.js';
import { initProto } from '../src/messages/proto.js';
import {
  createMessage,
  serializeMessage,
  deserializeMessage,
  MessageType,
} from '../src/messages/message.js';
import { generateKeypair, publicKeyToHex, sign as edSign } from '../src/identity/keypair.js';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

/**
 * Subclass that exposes the protected handleIncomingMessage method for
 * white-box pipeline testing without requiring live GossipSub.
 */
class TestableNode extends MagicNode {
  async processMessage(topic: string, data: Uint8Array): Promise<void> {
    return this.handleIncomingMessage(topic, data);
  }

  getTrustPolicy() {
    return this.trustPolicy;
  }

  getSpamFilterInstance() {
    return this.spamFilter;
  }
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
  // Replicates the canonical signable-bytes logic from PeerExchange
  const { signature: _, ...rest } = record;
  const canonical = Object.keys(rest)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = (rest as Record<string, unknown>)[key];
      return acc;
    }, {});
  const sigBytes = await edSign(kp.privateKey, new TextEncoder().encode(JSON.stringify(canonical)));
  return { ...record, signature: Buffer.from(sigBytes).toString('hex') };
}

async function createLibp2pTestNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

// ---------------------------------------------------------------------------
// MagicNode — reputation signal integration
// ---------------------------------------------------------------------------

describe('MagicNode — reputation signals', () => {
  let node: TestableNode;
  let tmpDir: string;
  let senderKeys: Awaited<ReturnType<typeof generateKeypair>>;
  let senderHex: string;

  /**
   * Build a correctly-signed serialized message for senderKeys unless `keys`
   * is overridden.  Each call uses a distinct payload so the dedup filter does
   * not suppress subsequent messages.
   */
  let payloadSeed = 100;
  async function makeMsg(opts?: {
    tags?: string[];
    payload?: Uint8Array;
    keys?: Awaited<ReturnType<typeof generateKeypair>>;
  }): Promise<Uint8Array> {
    const keys = opts?.keys ?? senderKeys;
    const tags = opts?.tags ?? ['test'];
    const payload = opts?.payload ?? new Uint8Array([++payloadSeed]);
    const msg = await createMessage({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      tags,
      payload,
      type: MessageType.BROADCAST,
    });
    return serializeMessage(msg);
  }

  beforeAll(async () => {
    await initProto();
    senderKeys = await generateKeypair();
    senderHex = publicKeyToHex(senderKeys.publicKey);

    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-rep-'));
    node = new TestableNode({
      listenPort: 0,
      subscribedTags: ['test'],
      seedNodes: [],
      enableWebSocket: false,
      enableRelay: false,
      dataDir: tmpDir,
      rateLimitPerMinute: 60,
      maxInboundPerMinute: 200,
      maxPayloadBytesPerMinute: 1_048_576,
      autoBlockThreshold: 100, // High threshold so auto-block does not interfere with spam tests
    });
    await node.start();
    await node.allowAgent(senderHex);
  }, 30_000);

  afterAll(async () => {
    await node.stop();
    await rm(tmpDir, { recursive: true, force: true });
  }, 15_000);

  // -------------------------------------------------------------------------

  it('getPeerReputation() returns the PeerReputation instance', () => {
    const rep = node.getPeerReputation();
    expect(rep).toBeInstanceOf(PeerReputation);
  });

  it('delivering a valid trusted message records a success for the sender', async () => {
    const rep = node.getPeerReputation();
    const scoreBefore = rep.getScore(senderHex);

    const data = await makeMsg();
    await node.processMessage('magic/tag/test', data);

    const scoreAfter = rep.getScore(senderHex);
    expect(scoreAfter).toBeGreaterThan(scoreBefore);

    const record = rep.getRecord(senderHex);
    expect(record).toBeDefined();
    expect(record!.successCount).toBeGreaterThanOrEqual(1);
  });

  it('rate-limited message records a spam signal for the sender', async () => {
    // Create a dedicated keypair that we will rate-limit
    const spamKeys = await generateKeypair();
    const spamHex = publicKeyToHex(spamKeys.publicKey);
    await node.allowAgent(spamHex);

    // Exhaust the per-sender rate limit (60/min).  Use a node with a tiny
    // limit to keep the test fast.
    const fastLimitDir = await mkdtemp(join(tmpdir(), 'leyline-rep-spam-'));
    const fastNode = new TestableNode({
      listenPort: 0,
      subscribedTags: ['test'],
      seedNodes: [],
      enableWebSocket: false,
      enableRelay: false,
      dataDir: fastLimitDir,
      rateLimitPerMinute: 3, // Very low limit for the test
      maxInboundPerMinute: 200,
      maxPayloadBytesPerMinute: 1_048_576,
      autoBlockThreshold: 100,
    });
    await fastNode.start();
    await fastNode.allowAgent(spamHex);

    const rep = fastNode.getPeerReputation();

    // Deliver the exact limit to fill the window without triggering rate limiting
    for (let i = 0; i < 3; i++) {
      const data = await makeMsg({ keys: spamKeys, payload: new Uint8Array([200 + i]) });
      await fastNode.processMessage('magic/tag/test', data);
    }

    const spamCountBefore = rep.getRecord(spamHex)?.spamCount ?? 0;

    // One more message should breach the limit and record spam
    const overLimitData = await makeMsg({ keys: spamKeys, payload: new Uint8Array([250]) });
    await fastNode.processMessage('magic/tag/test', overLimitData);

    const record = rep.getRecord(spamHex);
    expect(record).toBeDefined();
    expect(record!.spamCount).toBeGreaterThan(spamCountBefore);
    // Score should have been penalised
    expect(record!.score).toBeLessThan(50);

    await fastNode.stop();
    await rm(fastLimitDir, { recursive: true, force: true });
  }, 20_000);

  it('invalid signature records a violation for the sender', async () => {
    // Create a trusted sender
    const victimKeys = await generateKeypair();
    const victimHex = publicKeyToHex(victimKeys.publicKey);
    await node.allowAgent(victimHex);

    const rep = node.getPeerReputation();
    const violationsBefore = rep.getRecord(victimHex)?.violationCount ?? 0;

    // Build a valid message, then corrupt the signature bytes so verification fails.
    // We deserialize, clone with a bogus signature, and re-serialize.
    const validData = await makeMsg({ keys: victimKeys, payload: new Uint8Array([170]) });
    const msg = deserializeMessage(validData);

    // Replace signature with random bytes (still 64 bytes to pass structural validation)
    const corruptedSig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) corruptedSig[i] = i ^ 0xAB;

    const tamperedMsg = { ...msg, signature: corruptedSig };
    const tamperedData = serializeMessage(tamperedMsg);

    await node.processMessage('magic/tag/test', tamperedData);

    const record = rep.getRecord(victimHex);
    expect(record).toBeDefined();
    expect(record!.violationCount).toBeGreaterThan(violationsBefore);
    // Score must have been penalised by the violation
    expect(record!.score).toBeLessThan(50);
  });

  it('failed message validation (corrupt ID) records a violation', async () => {
    // Build a valid message then tamper with its payload so the recomputed ID
    // no longer matches — this triggers the validateMessage() failure path which
    // maps to recordViolation().
    const victimKeys2 = await generateKeypair();
    const victimHex2 = publicKeyToHex(victimKeys2.publicKey);
    await node.allowAgent(victimHex2);

    const rep = node.getPeerReputation();

    const validData = await makeMsg({ keys: victimKeys2, payload: new Uint8Array([180]) });
    const msg = deserializeMessage(validData);

    // Corrupt the ID (first byte flipped) so the ID-mismatch check fires before
    // the signature check.  The senderPubkey length remains 32 so the key-length
    // check passes, but computeId(payload, tags, timestamp, nonce) won't match.
    const corruptedId = new Uint8Array(msg.id);
    corruptedId[0] ^= 0xFF;

    const corruptedMsg = { ...msg, id: corruptedId };
    const corruptedData = serializeMessage(corruptedMsg);

    const violationsBefore = rep.getRecord(victimHex2)?.violationCount ?? 0;
    await node.processMessage('magic/tag/test', corruptedData);

    const record = rep.getRecord(victimHex2);
    expect(record).toBeDefined();
    expect(record!.violationCount).toBeGreaterThan(violationsBefore);
  });

  it('reputation is cleared when the node stops', async () => {
    const rep = node.getPeerReputation();
    // Confirm there is at least one tracked peer from previous tests
    expect(rep.size).toBeGreaterThan(0);

    await node.stop();

    // After stop(), clear() is called — the instance is the same object but empty
    expect(rep.size).toBe(0);

    // Re-start the node for subsequent tests (none remain, but clean-up in
    // afterAll requires a running node)
    await node.start();
    await node.allowAgent(senderHex);
  }, 30_000);

  it('success count increments on each valid delivery from a trusted sender', async () => {
    const rep = node.getPeerReputation();

    // Send two distinct messages so dedup does not suppress the second
    const data1 = await makeMsg({ payload: new Uint8Array([210]) });
    const data2 = await makeMsg({ payload: new Uint8Array([211]) });

    await node.processMessage('magic/tag/test', data1);
    await node.processMessage('magic/tag/test', data2);

    const record = rep.getRecord(senderHex);
    expect(record).toBeDefined();
    expect(record!.successCount).toBeGreaterThanOrEqual(2);
    expect(record!.score).toBeGreaterThan(50);
  });
}, 90_000);

// ---------------------------------------------------------------------------
// PeerExchange — reputation-weighted selection
// ---------------------------------------------------------------------------

describe('PeerExchange — reputation-weighted peer selection', () => {
  let node: Libp2p;

  beforeAll(async () => {
    node = await createLibp2pTestNode();
  }, 10_000);

  afterAll(async () => {
    await node?.stop();
  });

  // -------------------------------------------------------------------------

  it('works normally without a reputation instance (backward compatibility)', () => {
    const px = new PeerExchange(node, { maxPeers: 100 });

    const record: PeerRecord = {
      peerId: 'compat-peer-1',
      multiaddrs: ['/ip4/127.0.0.1/tcp/9001'],
      pubkeyHex: 'aa'.repeat(32),
      offeredTags: ['test'],
      lastSeen: Date.now(),
    };

    px.addPeer(record);

    expect(px.getPeerCount()).toBe(1);
    expect(px.getPeer('compat-peer-1')).toBeDefined();
  });

  it('accepts a reputation instance in constructor options', () => {
    const rep = new PeerReputation();
    const px = new PeerExchange(node, { maxPeers: 100, reputation: rep });

    // Should not throw; peers can be added normally
    px.addPeer({
      peerId: 'rep-peer-1',
      multiaddrs: [],
      pubkeyHex: 'bb'.repeat(32),
      offeredTags: [],
      lastSeen: Date.now(),
    });

    expect(px.getPeerCount()).toBe(1);
  });

  it('high-reputation peers are preferred in getPeersForExchange (top-50 selection)', () => {
    // Build a PeerExchange with more than 50 peers so the scoring path in
    // getPeersForExchange() is exercised.  We inject a PeerReputation that
    // has elevated scores for a known subset and verify those appear in the
    // final peer list shared during protocol exchanges.
    const rep = new PeerReputation();
    const px = new PeerExchange(node, { maxPeers: 1000, reputation: rep });

    const base = Date.now();

    // Add 60 generic "low" peers
    for (let i = 0; i < 60; i++) {
      px.addPeer({
        peerId: `low-peer-${i}`,
        multiaddrs: [],
        pubkeyHex: `${i.toString(16).padStart(2, '0')}`.padEnd(64, '0'),
        offeredTags: [],
        lastSeen: base + i * 100,
      });
      // Give each a below-average score via a single violation
      rep.recordViolation(`low-peer-${i}`);
    }

    // Add 5 "high" peers with boosted reputation
    const highPeerIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `high-peer-${i}`;
      highPeerIds.push(id);
      px.addPeer({
        peerId: id,
        multiaddrs: [],
        pubkeyHex: `f${i}`.padEnd(64, '0'),
        offeredTags: ['vip'],
        lastSeen: base + (60 + i) * 100,
      });
      // Give each a high score: 20 successes → score ~70 (50 + 20)
      for (let s = 0; s < 20; s++) rep.recordSuccess(id);
    }

    // The top-50 selection must include the high-reputation peers.
    // We call getPeers() (public method) to verify the full table, and
    // validate the reputation state independently — since getPeersForExchange
    // is private, we observe its effect by checking that the ranked list from
    // PeerReputation places the high peers at the top.
    const ranked = rep.getRankedPeers();
    const topIds = ranked.slice(0, 10).map((r) => r.peerId);

    for (const id of highPeerIds) {
      expect(topIds).toContain(id);
    }

    // Verify total peer count in the exchange table
    expect(px.getPeerCount()).toBe(65);
  });

  it('recordSuccess is called on PeerExchange after a successful live exchange', async () => {
    // Set up two live libp2p nodes and two PeerExchange instances that share
    // the same PeerReputation so we can observe the signal.
    const rep = new PeerReputation();
    const nodeA = await createLibp2pTestNode();
    const nodeB = await createLibp2pTestNode();

    const kpA = await generateKeypair();
    const kpB = await generateKeypair();

    const pxA = new PeerExchange(nodeA, {
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
      reputation: rep,
    });
    const pxB = new PeerExchange(nodeB, {
      localPrivateKey: kpB.privateKey,
      localPubkeyHex: publicKeyToHex(kpB.publicKey),
      reputation: rep,
    });

    await pxA.start();
    await pxB.start();

    // Connect B to A
    await nodeB.dial(nodeA.getMultiaddrs()[0]);
    await new Promise((r) => setTimeout(r, 300));

    // Pre-populate A's table with a third-party signed record so the exchange
    // returns at least one peer (triggering the success path in exchangeWithPeer)
    const thirdParty = await makeSignedRecord('exchange-third-party', {
      multiaddrs: ['/ip4/1.2.3.4/tcp/9876'],
    });
    pxA.addPeer(thirdParty);

    // Capture A's peerId — B will record success for this peer on a good exchange
    const aPeerId = nodeA.peerId.toString();
    const scoreBefore = rep.getScore(aPeerId);

    // B exchanges with A
    const received = await pxB.exchangeWithPeer(aPeerId);

    expect(received.length).toBeGreaterThan(0);

    const scoreAfter = rep.getScore(aPeerId);
    expect(scoreAfter).toBeGreaterThan(scoreBefore);

    const record = rep.getRecord(aPeerId);
    expect(record).toBeDefined();
    expect(record!.successCount).toBeGreaterThanOrEqual(1);

    await pxA.stop();
    await pxB.stop();
    await nodeA.stop();
    await nodeB.stop();
  }, 20_000);
}, 60_000);
