import { Level } from 'level';
import {
  ServiceRegistry,
  type ServiceDescriptor,
  type DiscoveryQuery,
} from './service-registry.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('PersistentServiceRegistry');

interface StoredDescriptor {
  descriptor: ServiceDescriptor;
  isLocal: boolean;
}

/**
 * LevelDB-backed wrapper around {@link ServiceRegistry}.
 *
 * Lifecycle: construct → open() → use → close().
 *
 * Storage layout:
 * ```
 * svc:{id}  →  JSON<StoredDescriptor>
 * ```
 *
 * On {@link open}, the database is scanned, expired entries are pruned,
 * and surviving descriptors are replayed into a fresh ServiceRegistry.
 */
export class PersistentServiceRegistry {
  readonly #dataDir: string;
  #db: Level<string, string> | undefined;
  #registry: ServiceRegistry = new ServiceRegistry();
  readonly #persistedLocalIds = new Set<string>();

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  #assertDb(): Level<string, string> {
    if (!this.#db) throw new Error('PersistentServiceRegistry is not open');
    return this.#db;
  }

  async open(): Promise<void> {
    this.#db = new Level<string, string>(this.#dataDir, { valueEncoding: 'utf8' });
    await this.#db.open();

    this.#registry = new ServiceRegistry();
    this.#persistedLocalIds.clear();

    const now = Date.now();
    const batch = this.#db.batch();
    let pruned = 0;

    for await (const [key, raw] of this.#db.iterator({ gt: 'svc:', lt: 'svc:~' })) {
      try {
        const record: StoredDescriptor = JSON.parse(raw) as StoredDescriptor;
        const d = record.descriptor;

        if (now - d.advertisedAt > d.ttl) {
          batch.del(key);
          pruned++;
          continue;
        }

        // Hydrate all descriptors via addRemote (handles validation + dedup).
        // Local tracking is maintained separately via #persistedLocalIds.
        this.#registry.addRemote(d);
        if (record.isLocal) {
          this.#persistedLocalIds.add(d.id);
        }
      } catch {
        log.warn('Skipping corrupted record', { key });
        batch.del(key);
      }
    }

    if (pruned > 0) await batch.write();
  }

  async close(): Promise<void> {
    await this.#assertDb().close();
    this.#db = undefined;
  }

  async register(
    descriptor: Omit<ServiceDescriptor, 'id' | 'advertisedAt'>,
  ): Promise<ServiceDescriptor> {
    const full = this.#registry.register(descriptor);
    this.#persistedLocalIds.add(full.id);
    const record: StoredDescriptor = { descriptor: full, isLocal: true };
    await this.#assertDb().put(`svc:${full.id}`, JSON.stringify(record));
    return full;
  }

  async unregister(id: string): Promise<boolean> {
    const existed = this.#registry.unregister(id);
    if (existed) {
      this.#persistedLocalIds.delete(id);
      await this.#assertDb().del(`svc:${id}`);
    }
    return existed;
  }

  async addRemote(descriptor: ServiceDescriptor): Promise<boolean> {
    const accepted = this.#registry.addRemote(descriptor);
    if (accepted) {
      const record: StoredDescriptor = { descriptor, isLocal: false };
      await this.#assertDb().put(`svc:${descriptor.id}`, JSON.stringify(record));
    }
    return accepted;
  }

  updateDescriptor(descriptor: ServiceDescriptor): void {
    this.#registry.updateDescriptor(descriptor);
    const db = this.#assertDb();
    const isLocal = this.#persistedLocalIds.has(descriptor.id);
    const record: StoredDescriptor = { descriptor, isLocal };
    db.put(`svc:${descriptor.id}`, JSON.stringify(record)).catch((err: unknown) => {
      log.warn('Failed to persist update', { error: String(err) });
    });
  }

  getLocal(): ServiceDescriptor[] {
    return this.#registry.getAll().filter((d) => this.#persistedLocalIds.has(d.id));
  }

  getAll(): ServiceDescriptor[] {
    return this.#registry.getAll();
  }

  query(query: DiscoveryQuery): ServiceDescriptor[] {
    return this.#registry.query(query);
  }

  async pruneExpired(): Promise<number> {
    const allBefore = new Set(this.#registry.getAll().map((d) => d.id));
    const pruned = this.#registry.pruneExpired();
    if (pruned > 0) {
      const allAfter = new Set(this.#registry.getAll().map((d) => d.id));
      const batch = this.#assertDb().batch();
      for (const id of allBefore) {
        if (!allAfter.has(id)) {
          batch.del(`svc:${id}`);
          this.#persistedLocalIds.delete(id);
        }
      }
      await batch.write();
    }
    return pruned;
  }
}
