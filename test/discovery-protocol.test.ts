import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { generateKeypair, publicKeyToHex } from '../src/identity/keypair.js';
import { ServiceRegistry } from '../src/discovery/service-registry.js';
import { DiscoveryProtocol } from '../src/discovery/discovery-protocol.js';

async function createTestNode() {
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

describe('DiscoveryProtocol', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let kpA: Awaited<ReturnType<typeof generateKeypair>>;
  let kpB: Awaited<ReturnType<typeof generateKeypair>>;
  let registryA: ServiceRegistry;
  let registryB: ServiceRegistry;
  let discA: DiscoveryProtocol;
  let discB: DiscoveryProtocol;

  beforeAll(async () => {
    kpA = await generateKeypair();
    kpB = await generateKeypair();
    nodeA = await createTestNode();
    nodeB = await createTestNode();

    await nodeB.dial(nodeA.getMultiaddrs()[0]);
    await sleep(500);

    registryA = new ServiceRegistry();
    registryB = new ServiceRegistry();

    discA = new DiscoveryProtocol(
      nodeA,
      registryA,
      publicKeyToHex(kpA.publicKey),
      nodeA.peerId.toString(),
      kpA.privateKey,
    );
    discB = new DiscoveryProtocol(
      nodeB,
      registryB,
      publicKeyToHex(kpB.publicKey),
      nodeB.peerId.toString(),
      kpB.privateKey,
    );

    await discA.start();
    await discB.start();
  }, 15000);

  afterAll(async () => {
    await discA?.stop();
    await discB?.stop();
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('queries a peer and receives matching services', async () => {
    // Register a signed service on node A
    const descriptor = registryA.register({
      name: 'TestService',
      tags: ['ai', 'image'],
      description: 'An image generation service',
      ttl: 300_000,
      metadata: {},
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
      multiaddrs: nodeA.getMultiaddrs().map((a) => a.toString()),
    });
    // Sign it
    const signed = await discA.signDescriptor(descriptor);
    registryA.updateDescriptor(signed);

    // Node B queries node A
    const results = await discB.queryPeer(
      nodeA.peerId.toString(),
      { tags: ['ai'] },
    );

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('TestService');
    expect(results[0].signature).toBeDefined();
  }, 10000);

  it('rejects unsigned service advertisements', async () => {
    // Register an unsigned service on node A
    const unsigned = registryA.register({
      name: 'UnsignedService',
      tags: ['unsigned'],
      description: 'No signature',
      ttl: 300_000,
      metadata: {},
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
      multiaddrs: [],
    });
    // Don't sign it — leave signature undefined

    // Broadcast to node B
    await discA.broadcastAdvertisement(unsigned);
    await sleep(500);

    // Node B should NOT have accepted it
    const inB = registryB.query({ tags: ['unsigned'] });
    expect(inB.length).toBe(0);
  }, 10000);

  it('accepts signed service advertisements', async () => {
    const descriptor = registryA.register({
      name: 'SignedAd',
      tags: ['signed-test'],
      description: 'Properly signed',
      ttl: 300_000,
      metadata: {},
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
      multiaddrs: [],
    });
    const signed = await discA.signDescriptor(descriptor);
    registryA.updateDescriptor(signed);

    await discA.broadcastAdvertisement(signed);
    await sleep(500);

    const inB = registryB.query({ tags: ['signed-test'] });
    expect(inB.length).toBe(1);
    expect(inB[0].name).toBe('SignedAd');
  }, 10000);

  it('verifyDescriptor rejects forged signatures', async () => {
    const descriptor = registryA.register({
      name: 'Forged',
      tags: ['forged'],
      description: '',
      ttl: 300_000,
      metadata: {},
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
      multiaddrs: [],
    });
    const signed = await discA.signDescriptor(descriptor);

    // Tamper with the name
    const forged = { ...signed, name: 'TamperedName' };
    const valid = await DiscoveryProtocol.verifyDescriptor(forged);
    expect(valid).toBe(false);
  });
});
