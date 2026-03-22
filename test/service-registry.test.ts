import { describe, it, expect, beforeEach } from 'vitest';
import { ServiceRegistry, DEFAULT_SERVICE_TTL } from '../src/discovery/service-registry.js';
import type { ServiceDescriptor } from '../src/discovery/service-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the minimum required fields for register(), merging any overrides. */
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

/** Build a fully-specified remote ServiceDescriptor (all fields present). */
function makeRemote(overrides: Partial<ServiceDescriptor> = {}): ServiceDescriptor {
  return {
    id: 'remote-id-1',
    advertisedAt: Date.now(),
    name: 'remote-service',
    tags: ['tag:remote'],
    description: 'A remote service',
    providerPubkey: 'eeff0011',
    providerPeerId: 'peer-remote',
    multiaddrs: ['/ip4/10.0.0.1/tcp/4001'],
    ttl: DEFAULT_SERVICE_TTL,
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  // -------------------------------------------------------------------------
  // register / getLocal
  // -------------------------------------------------------------------------

  describe('register', () => {
    it('assigns a unique id and records advertisedAt', () => {
      const before = Date.now();
      const svc = registry.register(makeDescriptor());
      const after = Date.now();

      expect(typeof svc.id).toBe('string');
      expect(svc.id.length).toBe(32); // 16 random bytes as hex
      expect(svc.advertisedAt).toBeGreaterThanOrEqual(before);
      expect(svc.advertisedAt).toBeLessThanOrEqual(after);
    });

    it('returns the registered service from getLocal()', () => {
      const svc = registry.register(makeDescriptor({ name: 'my-svc' }));
      const local = registry.getLocal();

      expect(local).toHaveLength(1);
      expect(local[0].id).toBe(svc.id);
      expect(local[0].name).toBe('my-svc');
    });

    it('stores multiple locally-registered services', () => {
      registry.register(makeDescriptor({ name: 'svc-a', tags: ['tag:a'] }));
      registry.register(makeDescriptor({ name: 'svc-b', tags: ['tag:b'] }));

      const local = registry.getLocal();
      expect(local).toHaveLength(2);
      const names = local.map((s) => s.name).sort();
      expect(names).toEqual(['svc-a', 'svc-b']);
    });

    it('uses DEFAULT_SERVICE_TTL when ttl is not specified', () => {
      // Omit ttl from the descriptor so the registry fills in the default.
      const { ttl: _ignored, ...withoutTtl } = makeDescriptor();
      // TypeScript: cast so the compiler accepts the missing optional field.
      const svc = registry.register(withoutTtl as Omit<ServiceDescriptor, 'id' | 'advertisedAt'>);
      expect(svc.ttl).toBe(DEFAULT_SERVICE_TTL);
    });
  });

  // -------------------------------------------------------------------------
  // unregister
  // -------------------------------------------------------------------------

  describe('unregister', () => {
    it('removes a local service and returns true', () => {
      const svc = registry.register(makeDescriptor());
      expect(registry.unregister(svc.id)).toBe(true);
      expect(registry.getLocal()).toHaveLength(0);
    });

    it('removes the service from getAll()', () => {
      const svc = registry.register(makeDescriptor());
      registry.unregister(svc.id);
      expect(registry.getAll()).toHaveLength(0);
    });

    it('returns false for an unknown id', () => {
      expect(registry.unregister('does-not-exist')).toBe(false);
    });

    it('removes a remote service', () => {
      const remote = makeRemote({ id: 'remote-abc' });
      registry.addRemote(remote);
      expect(registry.unregister('remote-abc')).toBe(true);
      expect(registry.getAll()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // addRemote / getAll
  // -------------------------------------------------------------------------

  describe('addRemote', () => {
    it('adds a remote service visible in getAll() but not getLocal()', () => {
      const remote = makeRemote();
      registry.addRemote(remote);

      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getLocal()).toHaveLength(0);
    });

    it('replaces an existing entry when the same id is added again', () => {
      registry.addRemote(makeRemote({ id: 'dup', name: 'original' }));
      registry.addRemote(makeRemote({ id: 'dup', name: 'updated' }));

      const all = registry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('updated');
    });
  });

  describe('getAll', () => {
    it('returns both local and remote services', () => {
      registry.register(makeDescriptor({ name: 'local-svc' }));
      registry.addRemote(makeRemote({ id: 'r1' }));
      registry.addRemote(makeRemote({ id: 'r2', name: 'another-remote' }));

      expect(registry.getAll()).toHaveLength(3);
    });

    it('returns an empty array when nothing is registered', () => {
      expect(registry.getAll()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // query — tag filter
  // -------------------------------------------------------------------------

  describe('query — tag filter', () => {
    it('returns services that share at least one of the queried tags', () => {
      registry.register(makeDescriptor({ name: 'alpha', tags: ['cat:a', 'cat:b'] }));
      registry.register(makeDescriptor({ name: 'beta', tags: ['cat:b', 'cat:c'] }));
      registry.register(makeDescriptor({ name: 'gamma', tags: ['cat:z'] }));

      const results = registry.query({ tags: ['cat:a'] });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('alpha');
    });

    it('any-match: includes service if it has at least one matching tag', () => {
      registry.register(makeDescriptor({ name: 'multi', tags: ['cat:a', 'cat:b'] }));

      // Query for cat:b only — multi should match.
      const results = registry.query({ tags: ['cat:b'] });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('multi');
    });

    it('returns services across local and remote when tag matches', () => {
      registry.register(makeDescriptor({ name: 'local', tags: ['shared:tag'] }));
      registry.addRemote(makeRemote({ id: 'r1', tags: ['shared:tag'] }));
      registry.addRemote(makeRemote({ id: 'r2', tags: ['other:tag'] }));

      const results = registry.query({ tags: ['shared:tag'] });
      expect(results).toHaveLength(2);
    });

    it('returns nothing when no services match the tag', () => {
      registry.register(makeDescriptor({ tags: ['cat:a'] }));
      expect(registry.query({ tags: ['cat:zzz'] })).toHaveLength(0);
    });

    it('returns all services when no tags filter is provided', () => {
      registry.register(makeDescriptor({ tags: ['cat:a'] }));
      registry.register(makeDescriptor({ tags: ['cat:b'] }));
      expect(registry.query({})).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // query — name filter
  // -------------------------------------------------------------------------

  describe('query — name filter', () => {
    it('matches a substring case-insensitively', () => {
      registry.register(makeDescriptor({ name: 'FooBarBaz' }));
      registry.register(makeDescriptor({ name: 'Unrelated' }));

      const results = registry.query({ name: 'bar' });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('FooBarBaz');
    });

    it('returns nothing when no name matches', () => {
      registry.register(makeDescriptor({ name: 'hello-world' }));
      expect(registry.query({ name: 'xyz' })).toHaveLength(0);
    });

    it('can combine tag and name filters (AND semantics)', () => {
      registry.register(makeDescriptor({ name: 'Foo Service', tags: ['cat:a'] }));
      registry.register(makeDescriptor({ name: 'Bar Service', tags: ['cat:a'] }));
      registry.register(makeDescriptor({ name: 'Foo Service', tags: ['cat:b'] }));

      // Only cat:a AND name contains 'foo' should match.
      const results = registry.query({ tags: ['cat:a'], name: 'foo' });
      expect(results).toHaveLength(1);
      expect(results[0].tags).toContain('cat:a');
      expect(results[0].name.toLowerCase()).toContain('foo');
    });
  });

  // -------------------------------------------------------------------------
  // query — limit
  // -------------------------------------------------------------------------

  describe('query — limit', () => {
    it('truncates results to the specified limit', () => {
      for (let i = 0; i < 5; i++) {
        registry.register(makeDescriptor({ name: `svc-${i}` }));
      }

      const results = registry.query({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('returns all results when limit exceeds the total count', () => {
      registry.register(makeDescriptor({ name: 'only-one' }));

      const results = registry.query({ limit: 100 });
      expect(results).toHaveLength(1);
    });

    it('limit: 1 returns exactly one result even when more match', () => {
      for (let i = 0; i < 4; i++) {
        registry.register(makeDescriptor({ name: `svc-limit-${i}` }));
      }
      // The break fires after the first push, so exactly 1 entry is returned.
      const results = registry.query({ limit: 1 });
      expect(results).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // pruneExpired
  // -------------------------------------------------------------------------

  describe('pruneExpired', () => {
    it('returns 0 when nothing has expired', () => {
      registry.register(makeDescriptor({ ttl: DEFAULT_SERVICE_TTL }));
      expect(registry.pruneExpired()).toBe(0);
    });

    it('evicts services whose TTL has elapsed', async () => {
      // Register with ttl=1ms so it expires almost immediately.
      registry.register(makeDescriptor({ name: 'fresh', ttl: DEFAULT_SERVICE_TTL }));
      const expiring = registry.register(makeDescriptor({ name: 'stale', ttl: 1 }));

      // Wait just long enough for the 1ms TTL to elapse.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const pruned = registry.pruneExpired();
      expect(pruned).toBe(1);

      const remaining = registry.getAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('fresh');
      // The expired entry must be gone.
      expect(remaining.find((s) => s.id === expiring.id)).toBeUndefined();
    });

    it('prunes a remote service when its TTL elapses', async () => {
      registry.addRemote(
        makeRemote({ id: 'r-stale', advertisedAt: Date.now() - 10, ttl: 1 }),
      );
      registry.register(makeDescriptor({ name: 'local-ok', ttl: DEFAULT_SERVICE_TTL }));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(registry.pruneExpired()).toBe(1);
      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getLocal()).toHaveLength(1);
    });

    it('removes pruned local services from getLocal()', async () => {
      registry.register(makeDescriptor({ name: 'stale-local', ttl: 1 }));

      await new Promise((resolve) => setTimeout(resolve, 10));

      registry.pruneExpired();
      expect(registry.getLocal()).toHaveLength(0);
    });
  });
});
