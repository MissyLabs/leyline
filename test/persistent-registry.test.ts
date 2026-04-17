import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentServiceRegistry } from '../src/discovery/persistent-registry.js';
import { DEFAULT_SERVICE_TTL, type ServiceDescriptor } from '../src/discovery/service-registry.js';

function makeDescriptor(overrides: Partial<ServiceDescriptor> = {}): Omit<ServiceDescriptor, 'id' | 'advertisedAt'> {
  return {
    name: overrides.name ?? 'test-service',
    tags: overrides.tags ?? ['tag:test'],
    description: overrides.description ?? 'A test service',
    providerPubkey: overrides.providerPubkey ?? 'aabbcc',
    providerPeerId: overrides.providerPeerId ?? 'peer-1',
    multiaddrs: overrides.multiaddrs ?? ['/ip4/127.0.0.1/tcp/9000'],
    ttl: overrides.ttl ?? DEFAULT_SERVICE_TTL,
    metadata: overrides.metadata ?? {},
    signature: overrides.signature,
  };
}

function makeRemote(overrides: Partial<ServiceDescriptor> = {}): ServiceDescriptor {
  return {
    id: overrides.id ?? `remote-${Math.random().toString(36).slice(2, 10)}`,
    advertisedAt: overrides.advertisedAt ?? Date.now(),
    name: overrides.name ?? 'remote-service',
    tags: overrides.tags ?? ['tag:remote'],
    description: overrides.description ?? 'A remote service',
    providerPubkey: overrides.providerPubkey ?? `pub-${Math.random().toString(36).slice(2, 10)}`,
    providerPeerId: overrides.providerPeerId ?? `peer-${Math.random().toString(36).slice(2, 10)}`,
    multiaddrs: overrides.multiaddrs ?? ['/ip4/10.0.0.1/tcp/9000'],
    ttl: overrides.ttl ?? DEFAULT_SERVICE_TTL,
    metadata: overrides.metadata ?? {},
  };
}

describe('PersistentServiceRegistry', () => {
  let dataDir: string;
  let registry: PersistentServiceRegistry;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'leyline-persistent-registry-'));
    registry = new PersistentServiceRegistry(dataDir);
    await registry.open();
  });

  afterEach(async () => {
    try { await registry.close(); } catch { /* already closed */ }
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('basic operations', () => {
    it('register returns a complete descriptor', async () => {
      const d = await registry.register(makeDescriptor());
      expect(d.id).toBeTruthy();
      expect(d.advertisedAt).toBeGreaterThan(0);
      expect(d.name).toBe('test-service');
    });

    it('registered service appears in getLocal and getAll', async () => {
      const d = await registry.register(makeDescriptor());
      expect(registry.getLocal()).toHaveLength(1);
      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getLocal()[0].id).toBe(d.id);
    });

    it('unregister removes the service', async () => {
      const d = await registry.register(makeDescriptor());
      const removed = await registry.unregister(d.id);
      expect(removed).toBe(true);
      expect(registry.getAll()).toHaveLength(0);
    });

    it('unregister returns false for unknown id', async () => {
      expect(await registry.unregister('nonexistent')).toBe(false);
    });

    it('addRemote stores a remote descriptor', async () => {
      const remote = makeRemote();
      expect(await registry.addRemote(remote)).toBe(true);
      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getLocal()).toHaveLength(0);
    });

    it('query filters by tag', async () => {
      await registry.register(makeDescriptor({ tags: ['skill:code'] }));
      await registry.register(makeDescriptor({ tags: ['skill:art'] }));
      const results = registry.query({ tags: ['skill:code'] });
      expect(results).toHaveLength(1);
      expect(results[0].tags).toContain('skill:code');
    });

    it('query filters by name', async () => {
      await registry.register(makeDescriptor({ name: 'alpha-service' }));
      await registry.register(makeDescriptor({ name: 'beta-service' }));
      const results = registry.query({ name: 'alpha' });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('alpha-service');
    });
  });

  describe('persistence across restart', () => {
    it('local services survive close/reopen', async () => {
      const d = await registry.register(makeDescriptor({ name: 'persisted-local' }));
      await registry.close();

      const registry2 = new PersistentServiceRegistry(dataDir);
      await registry2.open();
      try {
        const all = registry2.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('persisted-local');
        expect(all[0].id).toBe(d.id);

        const locals = registry2.getLocal();
        expect(locals).toHaveLength(1);
        expect(locals[0].id).toBe(d.id);
      } finally {
        await registry2.close();
      }
    });

    it('remote services survive close/reopen', async () => {
      const remote = makeRemote({ name: 'persisted-remote' });
      await registry.addRemote(remote);
      await registry.close();

      const registry2 = new PersistentServiceRegistry(dataDir);
      await registry2.open();
      try {
        const all = registry2.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('persisted-remote');
        expect(registry2.getLocal()).toHaveLength(0);
      } finally {
        await registry2.close();
      }
    });

    it('unregistered services do not reappear after restart', async () => {
      const d = await registry.register(makeDescriptor());
      await registry.unregister(d.id);
      await registry.close();

      const registry2 = new PersistentServiceRegistry(dataDir);
      await registry2.open();
      try {
        expect(registry2.getAll()).toHaveLength(0);
      } finally {
        await registry2.close();
      }
    });

    it('expired services are pruned on open', async () => {
      const remote = makeRemote({ ttl: 1, advertisedAt: Date.now() - 1000 });
      await registry.addRemote(remote);
      await registry.close();

      const registry2 = new PersistentServiceRegistry(dataDir);
      await registry2.open();
      try {
        expect(registry2.getAll()).toHaveLength(0);
      } finally {
        await registry2.close();
      }
    });

    it('multiple services of different types persist correctly', async () => {
      await registry.register(makeDescriptor({ name: 'local-1', tags: ['a'] }));
      await registry.register(makeDescriptor({ name: 'local-2', tags: ['b'] }));
      await registry.addRemote(makeRemote({ name: 'remote-1' }));
      await registry.addRemote(makeRemote({ name: 'remote-2' }));
      await registry.close();

      const registry2 = new PersistentServiceRegistry(dataDir);
      await registry2.open();
      try {
        expect(registry2.getAll()).toHaveLength(4);
        expect(registry2.getLocal()).toHaveLength(2);
      } finally {
        await registry2.close();
      }
    });
  });

  describe('updateDescriptor', () => {
    it('updates are reflected in queries', async () => {
      const d = await registry.register(makeDescriptor({ name: 'original' }));
      registry.updateDescriptor({ ...d, name: 'updated' });
      const results = registry.query({ name: 'updated' });
      expect(results).toHaveLength(1);
    });

    it('updates persist across restart', async () => {
      const d = await registry.register(makeDescriptor({ name: 'original' }));
      registry.updateDescriptor({ ...d, name: 'updated' });
      // Give the fire-and-forget put time to complete
      await new Promise((r) => setTimeout(r, 50));
      await registry.close();

      const registry2 = new PersistentServiceRegistry(dataDir);
      await registry2.open();
      try {
        const all = registry2.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('updated');
      } finally {
        await registry2.close();
      }
    });
  });

  describe('pruneExpired', () => {
    it('removes expired entries from DB', async () => {
      const remote = makeRemote({ ttl: 1, advertisedAt: Date.now() - 1000 });
      await registry.addRemote(remote);
      expect(registry.getAll()).toHaveLength(1);

      const pruned = await registry.pruneExpired();
      expect(pruned).toBe(1);
      expect(registry.getAll()).toHaveLength(0);

      // Verify DB is also cleaned
      await registry.close();
      const registry2 = new PersistentServiceRegistry(dataDir);
      await registry2.open();
      try {
        expect(registry2.getAll()).toHaveLength(0);
      } finally {
        await registry2.close();
      }
    });

    it('does not prune non-expired entries', async () => {
      await registry.register(makeDescriptor({ ttl: 300_000 }));
      const pruned = await registry.pruneExpired();
      expect(pruned).toBe(0);
      expect(registry.getAll()).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('throws when not open', async () => {
      const closed = new PersistentServiceRegistry(dataDir + '-closed');
      expect(() => closed.getAll()).not.toThrow(); // reads from in-memory
      await expect(closed.register(makeDescriptor())).rejects.toThrow('not open');
    });

    it('corrupted records are skipped on open', async () => {
      // Write a valid service then corrupt another key
      await registry.register(makeDescriptor({ name: 'valid' }));
      const db = (registry as unknown as { '#db': unknown })['#db'];
      // Access internal db via the data dir
      await registry.close();

      // Reopen db directly to inject corruption
      const { Level } = await import('level');
      const rawDb = new Level<string, string>(dataDir, { valueEncoding: 'utf8' });
      await rawDb.open();
      await rawDb.put('svc:corrupted-id', '{{{not json');
      await rawDb.close();

      const registry2 = new PersistentServiceRegistry(dataDir);
      await registry2.open();
      try {
        // Valid entry survives, corrupted is skipped
        expect(registry2.getAll()).toHaveLength(1);
        expect(registry2.getAll()[0].name).toBe('valid');
      } finally {
        await registry2.close();
      }
    });
  });
});
