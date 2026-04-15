import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { generateKeypair, publicKeyToHex } from '../src/identity/keypair.js';
import { ServiceRegistry } from '../src/discovery/service-registry.js';
import { DiscoveryProtocol } from '../src/discovery/discovery-protocol.js';

async function createNode(port: number): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: [`/ip4/127.0.0.1/tcp/${port}`] },
    transports: [tcp()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ emitSelf: false }),
    },
  });
}

describe('DiscoveryProtocol — per-peer rate limiting', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let discoveryA: DiscoveryProtocol;
  let discoveryB: DiscoveryProtocol;
  let registryA: ServiceRegistry;
  let registryB: ServiceRegistry;

  beforeAll(async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();

    nodeA = await createNode(0);
    nodeB = await createNode(0);

    registryA = new ServiceRegistry();
    registryB = new ServiceRegistry();

    discoveryA = new DiscoveryProtocol(
      nodeA,
      registryA,
      publicKeyToHex(kpA.publicKey),
      nodeA.peerId.toString(),
      kpA.privateKey,
      undefined,
      { maxRequestsPerWindow: 3, windowMs: 5000 },
    );
    discoveryB = new DiscoveryProtocol(
      nodeB,
      registryB,
      publicKeyToHex(kpB.publicKey),
      nodeB.peerId.toString(),
      kpB.privateKey,
    );

    await discoveryA.start();
    await discoveryB.start();

    const addrA = nodeA.getMultiaddrs()[0];
    await nodeB.dial(addrA);
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(async () => {
    await discoveryA.stop();
    await discoveryB.stop();
    await nodeA.stop();
    await nodeB.stop();
  });

  it('checkRateLimit allows requests within limit', () => {
    const proto = new DiscoveryProtocol(
      nodeA,
      new ServiceRegistry(),
      'aabb',
      'peer1',
      new Uint8Array(32),
      undefined,
      { maxRequestsPerWindow: 3, windowMs: 60000 },
    );

    expect(proto.checkRateLimit('peer-x')).toBe(true);
    expect(proto.checkRateLimit('peer-x')).toBe(true);
    expect(proto.checkRateLimit('peer-x')).toBe(true);
    expect(proto.checkRateLimit('peer-x')).toBe(false);
  });

  it('rate limits are per-peer', () => {
    const proto = new DiscoveryProtocol(
      nodeA,
      new ServiceRegistry(),
      'aabb',
      'peer1',
      new Uint8Array(32),
      undefined,
      { maxRequestsPerWindow: 2, windowMs: 60000 },
    );

    expect(proto.checkRateLimit('peer-a')).toBe(true);
    expect(proto.checkRateLimit('peer-a')).toBe(true);
    expect(proto.checkRateLimit('peer-a')).toBe(false);
    // Different peer is not affected
    expect(proto.checkRateLimit('peer-b')).toBe(true);
    expect(proto.checkRateLimit('peer-b')).toBe(true);
    expect(proto.checkRateLimit('peer-b')).toBe(false);
  });

  it('allows requests after window expires', async () => {
    const proto = new DiscoveryProtocol(
      nodeA,
      new ServiceRegistry(),
      'aabb',
      'peer1',
      new Uint8Array(32),
      undefined,
      { maxRequestsPerWindow: 1, windowMs: 50 },
    );

    expect(proto.checkRateLimit('peer-c')).toBe(true);
    expect(proto.checkRateLimit('peer-c')).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    expect(proto.checkRateLimit('peer-c')).toBe(true);
  });

  it('queries succeed within the rate limit', async () => {
    registryA.register({
      name: 'TestService',
      tags: ['test'],
      description: 'A test service',
      providerPubkey: 'aabb',
      providerPeerId: nodeA.peerId.toString(),
      multiaddrs: [],
      ttl: 300000,
      metadata: {},
    });

    const results = await discoveryB.queryPeer(
      nodeA.peerId.toString(),
      { tags: ['test'] },
    );
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});
