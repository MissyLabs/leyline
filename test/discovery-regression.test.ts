/**
 * Deep regression tests for service discovery.
 *
 * Covers edge cases, resource limits, TTL boundaries, trust integration,
 * malformed input handling, validation gaps, and protocol-level scenarios
 * that the existing test suites do not exercise.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { generateKeypair, publicKeyToHex } from '../src/identity/keypair.js';
import {
  ServiceRegistry,
  DEFAULT_SERVICE_TTL,
  type ServiceDescriptor,
} from '../src/discovery/service-registry.js';
import {
  DiscoveryProtocol,
  type DiscoveryTrustChecker,
} from '../src/discovery/discovery-protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRemote(overrides: Partial<ServiceDescriptor> = {}): ServiceDescriptor {
  return {
    id: `remote-${Math.random().toString(36).slice(2, 10)}`,
    advertisedAt: Date.now(),
    name: 'remote-service',
    tags: ['tag:remote'],
    description: 'A remote service',
    providerPubkey: 'aabbccdd',
    providerPeerId: 'peer-remote',
    multiaddrs: ['/ip4/10.0.0.1/tcp/4001'],
    ttl: DEFAULT_SERVICE_TTL,
    metadata: {},
    ...overrides,
  };
}

function makeDescriptor(
  overrides: Partial<Omit<ServiceDescriptor, 'id' | 'advertisedAt'>> = {},
): Omit<ServiceDescriptor, 'id' | 'advertisedAt'> {
  return {
    name: 'test-service',
    tags: ['tag:default'],
    description: 'A test service',
    providerPubkey: 'aabbccdd',
    providerPeerId: 'peer-1',
    multiaddrs: ['/ip4/127.0.0.1/tcp/4001'],
    ttl: DEFAULT_SERVICE_TTL,
    metadata: {},
    ...overrides,
  };
}

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

// =========================================================================
// ServiceRegistry — Edge Cases & Validation
// =========================================================================

describe('ServiceRegistry — edge cases', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  // -----------------------------------------------------------------------
  // TTL boundary conditions
  // -----------------------------------------------------------------------

  describe('TTL edge cases', () => {
    it('ttl=0 service expires immediately on prune', async () => {
      registry.addRemote(makeRemote({ id: 'zero-ttl', ttl: 0 }));
      // Even without delay, advertisedAt === now, so now - advertisedAt = 0,
      // and 0 > 0 is false. Need at least 1ms.
      await sleep(2);
      const pruned = registry.pruneExpired();
      expect(pruned).toBe(1);
      expect(registry.getAll()).toHaveLength(0);
    });

    it('negative ttl service is immediately expired', async () => {
      registry.addRemote(makeRemote({ id: 'neg-ttl', ttl: -1000 }));
      const pruned = registry.pruneExpired();
      // now - advertisedAt ≈ 0 > -1000? Yes — so it should be pruned.
      expect(pruned).toBe(1);
    });

    it('ttl=1 service expires after a few ms', async () => {
      registry.addRemote(makeRemote({ id: 'ttl-1', ttl: 1 }));
      await sleep(5);
      expect(registry.pruneExpired()).toBe(1);
    });

    it('service with advertisedAt far in the past expires immediately', () => {
      registry.addRemote(makeRemote({
        id: 'old-ad',
        advertisedAt: Date.now() - 1_000_000,
        ttl: 300_000,
      }));
      expect(registry.pruneExpired()).toBe(1);
    });

    it('service with advertisedAt in the future does not expire prematurely', () => {
      registry.addRemote(makeRemote({
        id: 'future-ad',
        advertisedAt: Date.now() + 60_000,
        ttl: 300_000,
      }));
      expect(registry.pruneExpired()).toBe(0);
      expect(registry.getAll()).toHaveLength(1);
    });

    it('very large ttl does not cause overflow or expiry', () => {
      registry.addRemote(makeRemote({
        id: 'huge-ttl',
        ttl: Number.MAX_SAFE_INTEGER,
      }));
      expect(registry.pruneExpired()).toBe(0);
      expect(registry.getAll()).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Descriptor validation (addRemote rejection)
  // -----------------------------------------------------------------------

  describe('addRemote validation', () => {
    it('rejects descriptor with empty id', () => {
      const result = registry.addRemote(makeRemote({ id: '' }));
      expect(result).toBe(false);
      expect(registry.getAll()).toHaveLength(0);
    });

    it('rejects descriptor with name exceeding 256 chars', () => {
      const result = registry.addRemote(makeRemote({ name: 'x'.repeat(257) }));
      expect(result).toBe(false);
    });

    it('accepts descriptor with name exactly 256 chars', () => {
      const result = registry.addRemote(makeRemote({ name: 'x'.repeat(256) }));
      expect(result).toBe(true);
    });

    it('rejects descriptor with description exceeding 2048 chars', () => {
      const result = registry.addRemote(makeRemote({ description: 'x'.repeat(2049) }));
      expect(result).toBe(false);
    });

    it('rejects descriptor with more than 100 tags', () => {
      const tags = Array.from({ length: 101 }, (_, i) => `tag:${i}`);
      const result = registry.addRemote(makeRemote({ tags }));
      expect(result).toBe(false);
    });

    it('accepts descriptor with exactly 100 tags', () => {
      const tags = Array.from({ length: 100 }, (_, i) => `tag:${i}`);
      const result = registry.addRemote(makeRemote({ tags }));
      expect(result).toBe(true);
    });

    it('rejects descriptor with more than 20 multiaddrs', () => {
      const multiaddrs = Array.from({ length: 21 }, (_, i) => `/ip4/10.0.0.${i}/tcp/4001`);
      const result = registry.addRemote(makeRemote({ multiaddrs }));
      expect(result).toBe(false);
    });

    it('rejects descriptor with more than 50 metadata keys', () => {
      const metadata: Record<string, string> = {};
      for (let i = 0; i < 51; i++) metadata[`key${i}`] = 'val';
      const result = registry.addRemote(makeRemote({ metadata }));
      expect(result).toBe(false);
    });

    it('rejects descriptor with metadata value exceeding 1024 chars', () => {
      const result = registry.addRemote(makeRemote({
        metadata: { key: 'x'.repeat(1025) },
      }));
      expect(result).toBe(false);
    });

    it('rejects descriptor with metadata key exceeding 1024 chars', () => {
      const result = registry.addRemote(makeRemote({
        metadata: { ['k'.repeat(1025)]: 'val' },
      }));
      expect(result).toBe(false);
    });

    it('rejects descriptor with non-string metadata value', () => {
      const result = registry.addRemote(makeRemote({
        metadata: { key: 123 as unknown as string },
      }));
      expect(result).toBe(false);
    });

    it('rejects descriptor with non-array tags', () => {
      const result = registry.addRemote(makeRemote({
        tags: 'not-an-array' as unknown as string[],
      }));
      expect(result).toBe(false);
    });

    it('rejects descriptor with non-string name', () => {
      const result = registry.addRemote(makeRemote({
        name: 42 as unknown as string,
      }));
      expect(result).toBe(false);
    });

    it('rejects descriptor with non-string description', () => {
      const result = registry.addRemote(makeRemote({
        description: null as unknown as string,
      }));
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // MAX_REMOTE_SERVICES cap
  // -----------------------------------------------------------------------

  describe('remote service cap', () => {
    it('stops accepting new remotes at MAX_REMOTE_SERVICES', () => {
      const cap = ServiceRegistry.MAX_REMOTE_SERVICES;

      // Fill to capacity
      for (let i = 0; i < cap; i++) {
        const ok = registry.addRemote(makeRemote({ id: `r-${i}` }));
        expect(ok).toBe(true);
      }

      // One more should be rejected
      const rejected = registry.addRemote(makeRemote({ id: 'over-limit' }));
      expect(rejected).toBe(false);
      expect(registry.getAll()).toHaveLength(cap);
    });

    it('allows replacing an existing remote at the cap', () => {
      const cap = ServiceRegistry.MAX_REMOTE_SERVICES;
      for (let i = 0; i < cap; i++) {
        registry.addRemote(makeRemote({ id: `r-${i}`, name: 'original' }));
      }

      // Replace existing id — should succeed
      const ok = registry.addRemote(makeRemote({ id: 'r-0', name: 'updated' }));
      expect(ok).toBe(true);
      const updated = registry.getAll().find(s => s.id === 'r-0');
      expect(updated?.name).toBe('updated');
    });

    it('local services do not count toward the remote cap', () => {
      // Register a local service first
      registry.register(makeDescriptor());

      const cap = ServiceRegistry.MAX_REMOTE_SERVICES;
      for (let i = 0; i < cap; i++) {
        registry.addRemote(makeRemote({ id: `r-${i}` }));
      }

      // Total is cap + 1 (local), but remote count is exactly cap
      expect(registry.getAll()).toHaveLength(cap + 1);

      // New remote should be rejected (at remote cap)
      expect(registry.addRemote(makeRemote({ id: 'extra' }))).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Query edge cases
  // -----------------------------------------------------------------------

  describe('query edge cases', () => {
    it('empty tags array matches all services (no tag filter)', () => {
      registry.register(makeDescriptor({ tags: ['cat:a'] }));
      registry.register(makeDescriptor({ tags: ['cat:b'] }));
      const results = registry.query({ tags: [] });
      expect(results).toHaveLength(2);
    });

    it('limit: 0 returns no results', () => {
      registry.register(makeDescriptor());
      const results = registry.query({ limit: 0 });
      expect(results).toHaveLength(0);
    });

    it('negative limit returns no results', () => {
      registry.register(makeDescriptor());
      const results = registry.query({ limit: -1 });
      expect(results).toHaveLength(0);
    });

    it('name filter with empty string matches all', () => {
      registry.register(makeDescriptor({ name: 'anything' }));
      const results = registry.query({ name: '' });
      expect(results).toHaveLength(1);
    });

    it('query on empty registry returns empty array', () => {
      expect(registry.query({ tags: ['cat:a'] })).toHaveLength(0);
      expect(registry.query({})).toHaveLength(0);
    });

    it('services with empty tags array never match a tag query', () => {
      registry.register(makeDescriptor({ tags: [] }));
      expect(registry.query({ tags: ['cat:a'] })).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // updateDescriptor
  // -----------------------------------------------------------------------

  describe('updateDescriptor', () => {
    it('updates an existing descriptor in place', () => {
      const svc = registry.register(makeDescriptor({ name: 'original' }));
      registry.updateDescriptor({ ...svc, name: 'updated' });
      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('updated');
    });

    it('creates a new entry if id does not exist', () => {
      registry.updateDescriptor(makeRemote({ id: 'new-entry', name: 'created' }));
      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getAll()[0].name).toBe('created');
    });
  });

  // -----------------------------------------------------------------------
  // pruneExpired — concurrent modification safety
  // -----------------------------------------------------------------------

  describe('pruneExpired consistency', () => {
    it('prunes multiple expired services in one pass', async () => {
      for (let i = 0; i < 10; i++) {
        registry.addRemote(makeRemote({ id: `expired-${i}`, ttl: 1 }));
      }
      registry.addRemote(makeRemote({ id: 'fresh', ttl: 300_000 }));
      await sleep(5);

      const pruned = registry.pruneExpired();
      expect(pruned).toBe(10);
      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getAll()[0].id).toBe('fresh');
    });

    it('prune then query returns consistent state', async () => {
      registry.addRemote(makeRemote({ id: 'stale', ttl: 1, tags: ['cat:a'] }));
      registry.addRemote(makeRemote({ id: 'alive', ttl: 300_000, tags: ['cat:a'] }));
      await sleep(5);

      registry.pruneExpired();
      const results = registry.query({ tags: ['cat:a'] });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('alive');
    });
  });
});

// =========================================================================
// DiscoveryProtocol — Signature & Verification
// =========================================================================

describe('DiscoveryProtocol — signatures', () => {
  it('computeSignableBytes is deterministic regardless of field order', () => {
    const desc: ServiceDescriptor = {
      id: 'test-id',
      name: 'test',
      tags: ['a'],
      description: 'desc',
      providerPubkey: 'aabb',
      providerPeerId: 'peer-1',
      multiaddrs: [],
      advertisedAt: 1000,
      ttl: 300_000,
      metadata: {},
      signature: 'should-be-excluded',
    };

    const bytes1 = DiscoveryProtocol.computeSignableBytes(desc);

    // Same content, different source order (JS preserves insertion order)
    const desc2 = {
      signature: 'different-sig',
      ttl: 300_000,
      name: 'test',
      id: 'test-id',
      tags: ['a'],
      description: 'desc',
      providerPubkey: 'aabb',
      providerPeerId: 'peer-1',
      multiaddrs: [],
      advertisedAt: 1000,
      metadata: {},
    } as ServiceDescriptor;

    const bytes2 = DiscoveryProtocol.computeSignableBytes(desc2);
    expect(Buffer.from(bytes1).toString()).toBe(Buffer.from(bytes2).toString());
  });

  it('signature excludes the signature field itself', () => {
    const desc: ServiceDescriptor = {
      id: 'test-id',
      name: 'test',
      tags: [],
      description: '',
      providerPubkey: 'aabb',
      providerPeerId: 'peer-1',
      multiaddrs: [],
      advertisedAt: 1000,
      ttl: 300_000,
      metadata: {},
      signature: 'some-sig',
    };

    const json = new TextDecoder().decode(DiscoveryProtocol.computeSignableBytes(desc));
    const parsed = JSON.parse(json);
    expect(parsed).not.toHaveProperty('signature');
  });

  it('verifyDescriptor returns false for undefined signature', async () => {
    const desc = makeRemote({ signature: undefined });
    expect(await DiscoveryProtocol.verifyDescriptor(desc)).toBe(false);
  });

  it('verifyDescriptor returns false for empty string signature', async () => {
    const desc = makeRemote({ signature: '' });
    expect(await DiscoveryProtocol.verifyDescriptor(desc)).toBe(false);
  });

  it('verifyDescriptor returns false for invalid hex signature', async () => {
    const desc = makeRemote({ signature: 'not-valid-hex-!@#$' });
    expect(await DiscoveryProtocol.verifyDescriptor(desc)).toBe(false);
  });

  it('verifyDescriptor returns false for truncated signature', async () => {
    const kp = await generateKeypair();
    const registry = new ServiceRegistry();
    const desc = registry.register({
      ...makeDescriptor(),
      providerPubkey: publicKeyToHex(kp.publicKey),
    });

    const node = await createTestNode();
    const disc = new DiscoveryProtocol(
      node, registry,
      publicKeyToHex(kp.publicKey),
      node.peerId.toString(),
      kp.privateKey,
    );
    const signed = await disc.signDescriptor(desc);
    // Truncate signature
    const truncated = { ...signed, signature: signed.signature!.slice(0, 32) };
    expect(await DiscoveryProtocol.verifyDescriptor(truncated)).toBe(false);
    await node.stop();
  });

  it('verifyDescriptor returns false when pubkey does not match signer', async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const registry = new ServiceRegistry();
    const desc = registry.register({
      ...makeDescriptor(),
      providerPubkey: publicKeyToHex(kpA.publicKey),
    });

    const node = await createTestNode();
    // Sign with kpA but set providerPubkey to kpB
    const disc = new DiscoveryProtocol(
      node, registry,
      publicKeyToHex(kpA.publicKey),
      node.peerId.toString(),
      kpA.privateKey,
    );
    const signed = await disc.signDescriptor(desc);
    const swapped = { ...signed, providerPubkey: publicKeyToHex(kpB.publicKey) };
    expect(await DiscoveryProtocol.verifyDescriptor(swapped)).toBe(false);
    await node.stop();
  });
});

// =========================================================================
// DiscoveryProtocol — Trust Integration
// =========================================================================

describe('DiscoveryProtocol — trust integration', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let kpA: Awaited<ReturnType<typeof generateKeypair>>;
  let kpB: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    kpA = await generateKeypair();
    kpB = await generateKeypair();
    nodeA = await createTestNode();
    nodeB = await createTestNode();
    await nodeB.dial(nodeA.getMultiaddrs()[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('trust checker blocks advertisements from denied providers', async () => {
    const blockedPubkey = publicKeyToHex(kpA.publicKey);
    const trustChecker: DiscoveryTrustChecker = {
      isAllowed: (pubkey: string) => pubkey !== blockedPubkey,
    };

    const registryA = new ServiceRegistry();
    const registryB = new ServiceRegistry();

    const discA = new DiscoveryProtocol(
      nodeA, registryA,
      publicKeyToHex(kpA.publicKey),
      nodeA.peerId.toString(),
      kpA.privateKey,
    );
    const discB = new DiscoveryProtocol(
      nodeB, registryB,
      publicKeyToHex(kpB.publicKey),
      nodeB.peerId.toString(),
      kpB.privateKey,
      trustChecker,
    );

    await discA.start();
    await discB.start();

    // Register + sign a service on A
    const desc = registryA.register({
      ...makeDescriptor(),
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
    });
    const signed = await discA.signDescriptor(desc);
    registryA.updateDescriptor(signed);

    // Broadcast to B — should be blocked by trust
    await discA.broadcastAdvertisement(signed);
    await sleep(500);

    expect(registryB.query({ tags: ['tag:default'] })).toHaveLength(0);

    await discA.stop();
    await discB.stop();
  }, 15000);

  it('trust checker blocks query results from denied providers', async () => {
    const blockedPubkey = publicKeyToHex(kpA.publicKey);
    const trustChecker: DiscoveryTrustChecker = {
      isAllowed: (pubkey: string) => pubkey !== blockedPubkey,
    };

    const registryA = new ServiceRegistry();
    const registryB = new ServiceRegistry();

    const discA = new DiscoveryProtocol(
      nodeA, registryA,
      publicKeyToHex(kpA.publicKey),
      nodeA.peerId.toString(),
      kpA.privateKey,
    );
    const discB = new DiscoveryProtocol(
      nodeB, registryB,
      publicKeyToHex(kpB.publicKey),
      nodeB.peerId.toString(),
      kpB.privateKey,
      trustChecker,
    );

    await discA.start();
    await discB.start();

    // Register a signed service on A from the blocked pubkey
    const desc = registryA.register({
      ...makeDescriptor({ tags: ['trust-query-test'] }),
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
    });
    const signed = await discA.signDescriptor(desc);
    registryA.updateDescriptor(signed);

    // B queries A — results from blocked pubkey should be filtered
    const results = await discB.queryPeer(
      nodeA.peerId.toString(),
      { tags: ['trust-query-test'] },
    );

    expect(results).toHaveLength(0);

    await discA.stop();
    await discB.stop();
  }, 15000);

  it('allow-all trust checker accepts services', async () => {
    const trustChecker: DiscoveryTrustChecker = {
      isAllowed: () => true,
    };

    const registryA = new ServiceRegistry();
    const registryB = new ServiceRegistry();

    const discA = new DiscoveryProtocol(
      nodeA, registryA,
      publicKeyToHex(kpA.publicKey),
      nodeA.peerId.toString(),
      kpA.privateKey,
    );
    const discB = new DiscoveryProtocol(
      nodeB, registryB,
      publicKeyToHex(kpB.publicKey),
      nodeB.peerId.toString(),
      kpB.privateKey,
      trustChecker,
    );

    await discA.start();
    await discB.start();

    const desc = registryA.register({
      ...makeDescriptor({ tags: ['trust-allow-test'] }),
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
    });
    const signed = await discA.signDescriptor(desc);
    registryA.updateDescriptor(signed);

    await discA.broadcastAdvertisement(signed);
    await sleep(500);

    expect(registryB.query({ tags: ['trust-allow-test'] })).toHaveLength(1);

    await discA.stop();
    await discB.stop();
  }, 15000);
});

// =========================================================================
// DiscoveryProtocol — Query behavior
// =========================================================================

describe('DiscoveryProtocol — query edge cases', () => {
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
      nodeA, registryA,
      publicKeyToHex(kpA.publicKey),
      nodeA.peerId.toString(),
      kpA.privateKey,
    );
    discB = new DiscoveryProtocol(
      nodeB, registryB,
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

  it('query with no matching tags returns empty', async () => {
    const desc = registryA.register({
      ...makeDescriptor({ tags: ['cat:alpha'] }),
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
    });
    const signed = await discA.signDescriptor(desc);
    registryA.updateDescriptor(signed);

    const results = await discB.queryPeer(
      nodeA.peerId.toString(),
      { tags: ['cat:nonexistent'] },
    );
    expect(results).toHaveLength(0);
  }, 10000);

  it('query to non-existent peer returns empty array', async () => {
    const results = await discB.queryPeer(
      '12D3KooWFakeIDthatDoesNotExist',
      { tags: ['cat:a'] },
    );
    expect(results).toHaveLength(0);
  });

  it('queryAllPeers deduplicates identical service ids', async () => {
    // Register same service on A — B will see it via query
    const desc = registryA.register({
      ...makeDescriptor({ tags: ['dedup-test'] }),
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
    });
    const signed = await discA.signDescriptor(desc);
    registryA.updateDescriptor(signed);

    const results = await discB.queryAllPeers({ tags: ['dedup-test'] });
    // Even though only one peer, verify no duplicates
    const ids = results.map(r => r.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  }, 10000);

  it('query result limit is capped at 100 on the responder', async () => {
    // Register 110 services on A
    for (let i = 0; i < 110; i++) {
      const desc = registryA.register({
        ...makeDescriptor({ name: `bulk-${i}`, tags: ['bulk-test'] }),
        providerPubkey: publicKeyToHex(kpA.publicKey),
        providerPeerId: nodeA.peerId.toString(),
      });
      const signed = await discA.signDescriptor(desc);
      registryA.updateDescriptor(signed);
    }

    const results = await discB.queryPeer(
      nodeA.peerId.toString(),
      { tags: ['bulk-test'], limit: 200 },
    );

    // Server caps at 100 regardless of client request
    expect(results.length).toBeLessThanOrEqual(100);
  }, 15000);

  it('query with name filter works over the wire', async () => {
    const desc = registryA.register({
      ...makeDescriptor({ name: 'UniqueNameForWireTest', tags: ['wire-name-test'] }),
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
    });
    const signed = await discA.signDescriptor(desc);
    registryA.updateDescriptor(signed);

    const results = await discB.queryPeer(
      nodeA.peerId.toString(),
      { name: 'uniquename', tags: ['wire-name-test'] },
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('UniqueNameForWireTest');
  }, 10000);

  it('unsigned services on the responder are sent but rejected by querier', async () => {
    // Register unsigned service on A
    registryA.register({
      ...makeDescriptor({ tags: ['unsigned-wire-test'] }),
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
    });
    // No signing — leave signature undefined

    const results = await discB.queryPeer(
      nodeA.peerId.toString(),
      { tags: ['unsigned-wire-test'] },
    );

    // Querier verifies signatures and should reject unsigned ones
    expect(results).toHaveLength(0);
  }, 10000);
});

// =========================================================================
// DiscoveryProtocol — Advertisement edge cases
// =========================================================================

describe('DiscoveryProtocol — advertisement edge cases', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let kpA: Awaited<ReturnType<typeof generateKeypair>>;
  let kpB: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    kpA = await generateKeypair();
    kpB = await generateKeypair();
    nodeA = await createTestNode();
    nodeB = await createTestNode();
    await nodeB.dial(nodeA.getMultiaddrs()[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('re-advertising updates the descriptor on the remote', async () => {
    const registryA = new ServiceRegistry();
    const registryB = new ServiceRegistry();

    const discA = new DiscoveryProtocol(
      nodeA, registryA,
      publicKeyToHex(kpA.publicKey),
      nodeA.peerId.toString(),
      kpA.privateKey,
    );
    const discB = new DiscoveryProtocol(
      nodeB, registryB,
      publicKeyToHex(kpB.publicKey),
      nodeB.peerId.toString(),
      kpB.privateKey,
    );

    await discA.start();
    await discB.start();

    // First advertisement
    const desc = registryA.register({
      ...makeDescriptor({ name: 'v1', tags: ['readvertise-test'] }),
      providerPubkey: publicKeyToHex(kpA.publicKey),
      providerPeerId: nodeA.peerId.toString(),
    });
    let signed = await discA.signDescriptor(desc);
    registryA.updateDescriptor(signed);
    await discA.broadcastAdvertisement(signed);
    await sleep(500);

    let results = registryB.query({ tags: ['readvertise-test'] });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('v1');

    // Re-advertise with updated name (same id)
    const updated = { ...desc, name: 'v2' };
    signed = await discA.signDescriptor(updated);
    registryA.updateDescriptor(signed);
    await discA.broadcastAdvertisement(signed);
    await sleep(500);

    results = registryB.query({ tags: ['readvertise-test'] });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('v2');

    await discA.stop();
    await discB.stop();
  }, 15000);

  it('broadcastAdvertisement does not throw when no peers connected', async () => {
    const isolatedNode = await createTestNode();
    const kp = await generateKeypair();
    const registry = new ServiceRegistry();
    const disc = new DiscoveryProtocol(
      isolatedNode, registry,
      publicKeyToHex(kp.publicKey),
      isolatedNode.peerId.toString(),
      kp.privateKey,
    );
    await disc.start();

    const desc = registry.register({
      ...makeDescriptor(),
      providerPubkey: publicKeyToHex(kp.publicKey),
      providerPeerId: isolatedNode.peerId.toString(),
    });
    const signed = await disc.signDescriptor(desc);

    // Should not throw
    await expect(disc.broadcastAdvertisement(signed)).resolves.toBeUndefined();

    await disc.stop();
    await isolatedNode.stop();
  }, 15000);
});

// =========================================================================
// DiscoveryProtocol — Sign + Verify round-trip
// =========================================================================

describe('DiscoveryProtocol — sign/verify round-trip', () => {
  it('sign then verify succeeds for valid descriptor', async () => {
    const kp = await generateKeypair();
    const node = await createTestNode();
    const registry = new ServiceRegistry();
    const disc = new DiscoveryProtocol(
      node, registry,
      publicKeyToHex(kp.publicKey),
      node.peerId.toString(),
      kp.privateKey,
    );

    const desc = registry.register({
      ...makeDescriptor(),
      providerPubkey: publicKeyToHex(kp.publicKey),
      providerPeerId: node.peerId.toString(),
    });
    const signed = await disc.signDescriptor(desc);

    expect(signed.signature).toBeDefined();
    expect(signed.signature!.length).toBeGreaterThan(0);
    expect(await DiscoveryProtocol.verifyDescriptor(signed)).toBe(true);

    await node.stop();
  });

  it('modifying any field after signing invalidates signature', async () => {
    const kp = await generateKeypair();
    const node = await createTestNode();
    const registry = new ServiceRegistry();
    const disc = new DiscoveryProtocol(
      node, registry,
      publicKeyToHex(kp.publicKey),
      node.peerId.toString(),
      kp.privateKey,
    );

    const desc = registry.register({
      ...makeDescriptor(),
      providerPubkey: publicKeyToHex(kp.publicKey),
      providerPeerId: node.peerId.toString(),
    });
    const signed = await disc.signDescriptor(desc);

    // Tamper with each field and verify signature fails
    const tampers: Array<Partial<ServiceDescriptor>> = [
      { name: 'tampered-name' },
      { description: 'tampered-desc' },
      { tags: ['tampered:tag'] },
      { ttl: 1 },
      { metadata: { evil: 'true' } },
      { multiaddrs: ['/ip4/666.666.666.666/tcp/1'] },
    ];

    for (const tamper of tampers) {
      const forged = { ...signed, ...tamper };
      expect(await DiscoveryProtocol.verifyDescriptor(forged)).toBe(false);
    }

    await node.stop();
  });

  it('descriptor with special characters in name/description verifies correctly', async () => {
    const kp = await generateKeypair();
    const node = await createTestNode();
    const registry = new ServiceRegistry();
    const disc = new DiscoveryProtocol(
      node, registry,
      publicKeyToHex(kp.publicKey),
      node.peerId.toString(),
      kp.privateKey,
    );

    const desc = registry.register({
      ...makeDescriptor({
        name: 'Test "Service" with <html> & special chars \n\t',
        description: 'Unicode: \u00e9\u00e8\u00ea \u2603 \ud83d\ude80',
        metadata: { key: 'value with "quotes" and \\backslash' },
      }),
      providerPubkey: publicKeyToHex(kp.publicKey),
      providerPeerId: node.peerId.toString(),
    });
    const signed = await disc.signDescriptor(desc);
    expect(await DiscoveryProtocol.verifyDescriptor(signed)).toBe(true);

    await node.stop();
  });
});
