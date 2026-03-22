import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { generateKeypair, sign, publicKeyToHex } from '../src/identity/keypair.js';
import { TrustPolicy, SpamFilter } from '../src/trust/policy.js';
import { LocalLedger } from '../src/ledger/local-log.js';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { initProto } from '../src/messages/proto.js';
import {
  createMessage,
  serializeMessage,
  deserializeMessage,
  validateMessage,
  verifyMessageSignature,
  MessageType,
} from '../src/messages/message.js';
import { TagPubSub } from '../src/pubsub/tag-pubsub.js';
import { PeerExchange, type PeerRecord } from '../src/node/peer-exchange.js';
import { IdentityStore } from '../src/identity/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Helper to create a minimal libp2p node for testing
async function createTestNode(port: number) {
  const node = await createLibp2p({
    addresses: { listen: [`/ip4/127.0.0.1/tcp/${port}`] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        fallbackToFloodsub: true,
      }),
    },
  } as Parameters<typeof createLibp2p>[0]);

  return node;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Integration: Multi-node networking', () => {
  let node1: Libp2p;
  let node2: Libp2p;
  let node3: Libp2p;
  let tmpDir: string;

  beforeAll(async () => {
    await initProto();
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-test-'));

    // Create three test nodes
    node1 = await createTestNode(0); // Port 0 = random available port
    node2 = await createTestNode(0);
    node3 = await createTestNode(0);
  }, 30000);

  afterAll(async () => {
    await node1?.stop();
    await node2?.stop();
    await node3?.stop();
    await rm(tmpDir, { recursive: true, force: true });
  }, 15000);

  it('nodes can connect to each other', async () => {
    const node1Addrs = node1.getMultiaddrs();
    expect(node1Addrs.length).toBeGreaterThan(0);

    // Node2 dials node1
    await node2.dial(node1Addrs[0]);
    await sleep(500);

    const node2Peers = node2.getPeers();
    expect(node2Peers.length).toBeGreaterThanOrEqual(1);
  }, 10000);

  it('nodes exchange messages via GossipSub tags', async () => {
    const gs1 = (node1.services as Record<string, unknown>).pubsub as import('@chainsafe/libp2p-gossipsub').GossipSub;
    const gs2 = (node2.services as Record<string, unknown>).pubsub as import('@chainsafe/libp2p-gossipsub').GossipSub;

    const topic = 'magic/tag/test:integration';

    // Both subscribe to the raw GossipSub topic
    gs1.subscribe(topic);
    gs2.subscribe(topic);

    await sleep(2000); // Allow GossipSub mesh to form (heartbeat interval)

    // Set up receiver on gs2 via the native event
    const received: Uint8Array[] = [];
    gs2.addEventListener('gossipsub:message', (evt: CustomEvent) => {
      const { msg: m } = evt.detail;
      if (m.topic === topic) {
        received.push(m.data);
      }
    });

    // Create and send a signed message from node1
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['test:integration'],
      payload: new TextEncoder().encode('hello from node1'),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    const serialized = serializeMessage(msg, 'protobuf');
    await gs1.publish(topic, serialized);

    await sleep(2000); // Allow propagation

    // Verify node2 received the message
    expect(received.length).toBeGreaterThanOrEqual(1);
    if (received.length > 0) {
      const restored = deserializeMessage(received[0], 'protobuf');
      expect(restored.tags).toEqual(['test:integration']);
      expect(new TextDecoder().decode(restored.payload)).toBe('hello from node1');

      // Verify signature
      const valid = await verifyMessageSignature(restored);
      expect(valid).toBe(true);
    }
  }, 15000);

  it('three nodes form a mesh and propagate messages', async () => {
    // Connect node3 to node1 (node2 already connected to node1)
    const node1Addrs = node1.getMultiaddrs();
    await node3.dial(node1Addrs[0]);
    await sleep(500);

    const gs1 = (node1.services as Record<string, unknown>).pubsub as import('@chainsafe/libp2p-gossipsub').GossipSub;
    const gs3 = (node3.services as Record<string, unknown>).pubsub as import('@chainsafe/libp2p-gossipsub').GossipSub;

    const meshTopic = 'magic/tag/mesh:test';
    gs1.subscribe(meshTopic);
    gs3.subscribe(meshTopic);

    await sleep(2000);

    const received: Uint8Array[] = [];
    gs3.addEventListener('gossipsub:message', (evt: CustomEvent) => {
      const { msg: m } = evt.detail;
      if (m.topic === meshTopic) {
        received.push(m.data);
      }
    });

    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['mesh:test'],
      payload: new TextEncoder().encode('mesh broadcast'),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    await gs1.publish(meshTopic, serializeMessage(msg, 'protobuf'));
    await sleep(2000);

    // Node3 should receive the message via the mesh
    expect(received.length).toBeGreaterThanOrEqual(1);
  }, 15000);
});

describe('Integration: Trust policy enforcement', () => {
  it('deny-first blocks unknown senders, allows whitelisted', async () => {
    const policy = new TrustPolicy();
    const filter = new SpamFilter();

    const sender1 = await generateKeypair();
    const sender2 = await generateKeypair();
    const sender1Hex = publicKeyToHex(sender1.publicKey);
    const sender2Hex = publicKeyToHex(sender2.publicKey);

    // Create messages from both senders
    const msg1 = await createMessage({
      tags: ['test'],
      payload: new TextEncoder().encode('from sender1'),
      type: MessageType.BROADCAST,
      privateKey: sender1.privateKey,
      publicKey: sender1.publicKey,
    });

    const msg2 = await createMessage({
      tags: ['test'],
      payload: new TextEncoder().encode('from sender2'),
      type: MessageType.BROADCAST,
      privateKey: sender2.privateKey,
      publicKey: sender2.publicKey,
    });

    // Both should be blocked initially (deny-first)
    expect(policy.isAllowed(sender1Hex, msg1.tags)).toBe(false);
    expect(policy.isAllowed(sender2Hex, msg2.tags)).toBe(false);

    // Allow sender1
    policy.allowAgent(sender1Hex);
    expect(policy.isAllowed(sender1Hex, msg1.tags)).toBe(true);
    expect(policy.isAllowed(sender2Hex, msg2.tags)).toBe(false);

    // Verify signatures are valid
    expect(await verifyMessageSignature(msg1)).toBe(true);
    expect(await verifyMessageSignature(msg2)).toBe(true);

    // Dedup works
    const id1 = Buffer.from(msg1.id).toString('hex');
    expect(filter.isDuplicate(id1)).toBe(false);
    expect(filter.isDuplicate(id1)).toBe(true); // Second time = duplicate
  });
});

describe('Integration: Persistent identity', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-identity-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('generates identity on first load and persists across restarts', async () => {
    const store = new IdentityStore(tmpDir);

    // First load — should generate new keypair
    expect(await store.exists()).toBe(false);
    const kp1 = await store.load();
    expect(kp1.publicKey.length).toBe(32);
    expect(kp1.privateKey.length).toBe(32);
    expect(await store.exists()).toBe(true);

    // Second load — should return same keypair
    const store2 = new IdentityStore(tmpDir);
    const kp2 = await store2.load();
    expect(Buffer.from(kp2.publicKey).toString('hex')).toBe(
      Buffer.from(kp1.publicKey).toString('hex'),
    );
    expect(Buffer.from(kp2.privateKey).toString('hex')).toBe(
      Buffer.from(kp1.privateKey).toString('hex'),
    );
  });
});

describe('Integration: Peer exchange protocol', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;

  beforeAll(async () => {
    nodeA = await createTestNode(0);
    nodeB = await createTestNode(0);

    // Connect them
    const addrs = nodeA.getMultiaddrs();
    await nodeB.dial(addrs[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('peers exchange peer records via the protocol', async () => {
    const pexA = new PeerExchange(nodeA, { exchangeIntervalMs: 60000 }); // Disable auto
    const pexB = new PeerExchange(nodeB, { exchangeIntervalMs: 60000 });

    await pexA.start();
    await pexB.start();

    // Add some peer records to A
    pexA.addPeer({
      peerId: 'fake-peer-1',
      multiaddrs: ['/ip4/10.0.0.1/tcp/9876'],
      pubkeyHex: 'aabbccdd',
      offeredTags: ['skill:code'],
      lastSeen: Date.now(),
    });

    pexA.addPeer({
      peerId: 'fake-peer-2',
      multiaddrs: ['/ip4/10.0.0.2/tcp/9876'],
      pubkeyHex: 'eeff0011',
      offeredTags: ['compute:gpu'],
      lastSeen: Date.now(),
    });

    expect(pexA.getPeerCount()).toBe(2);
    expect(pexB.getPeerCount()).toBe(0);

    // B requests exchange from A
    const received = await pexB.exchangeWithPeer(nodeA.peerId.toString());

    // B should now have A's peers
    expect(pexB.getPeerCount()).toBeGreaterThanOrEqual(1);

    await pexA.stop();
    await pexB.stop();
  }, 10000);
});

describe('Integration: Ledger integrity', () => {
  let tmpDir: string;
  let ledger: LocalLedger;

  beforeAll(async () => {
    await initProto();
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-ledger-'));
    ledger = new LocalLedger(join(tmpDir, 'test-ledger'));
    await ledger.open();
  });

  afterAll(async () => {
    await ledger.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('append-only chain maintains hash integrity', async () => {
    // Append several entries
    const kp = await generateKeypair();
    for (let i = 0; i < 5; i++) {
      const msg = await createMessage({
        tags: ['ledger:test'],
        payload: new TextEncoder().encode(`message ${i}`),
        type: MessageType.BROADCAST,
        privateKey: kp.privateKey,
        publicKey: kp.publicKey,
      });
      const data = serializeMessage(msg, 'protobuf');
      await ledger.append(data, i % 2 === 0 ? 'sent' : 'received');
    }

    expect(await ledger.getEntryCount()).toBe(5);

    // Verify chain integrity
    const valid = await ledger.verify();
    expect(valid).toBe(true);

    // Check entries are linked
    const entry0 = await ledger.getEntry(0);
    const entry1 = await ledger.getEntry(1);
    expect(entry0).not.toBeNull();
    expect(entry1).not.toBeNull();
    expect(entry0!.prevHash.length).toBe(0); // Genesis has no prev
    expect(Buffer.from(entry1!.prevHash).toString('hex')).toBe(
      Buffer.from(entry0!.hash).toString('hex'),
    ); // Chain linkage
  });

  it('shared ledger records provable entries', async () => {
    const sharedLedger = new SharedLedger(join(tmpDir, 'shared-test'));
    await sharedLedger.open();

    const kp = await generateKeypair();
    const data = new TextEncoder().encode('provable record');
    const signature = await sign(kp.privateKey, data);

    const entry = await sharedLedger.submit(data, kp.publicKey, signature);
    expect(entry.index).toBe(1);
    expect(entry.confirmations).toBe(0);

    // Add a confirmation
    const confirmer = await generateKeypair();
    const confirmed = await sharedLedger.addConfirmation(1, confirmer.publicKey);
    expect(confirmed!.confirmations).toBe(1);

    // Verify chain
    expect(await sharedLedger.verify()).toBe(true);

    await sharedLedger.close();
  });
});
