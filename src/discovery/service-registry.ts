/**
 * @module service-registry
 *
 * In-memory registry for structured service advertisements on the Leyline P2P
 * network. Maintains a unified map of {@link ServiceDescriptor} records sourced
 * both from local registrations and remote peer advertisements.
 *
 * Typical lifecycle:
 *  1. Call {@link ServiceRegistry.register} to publish a local service.
 *  2. Receive remote advertisements via {@link ServiceRegistry.addRemote}.
 *  3. Search with {@link ServiceRegistry.query}.
 *  4. Call {@link ServiceRegistry.pruneExpired} periodically to evict stale records.
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * A fully-described advertisement for a single service offered by a peer on
 * the Leyline network.
 */
export interface ServiceDescriptor {
  /** Unique service ID (randomly generated at registration time). */
  id: string;

  /** Human-readable service name. */
  name: string;

  /** Tags describing the service capabilities. Used as the primary search key. */
  tags: string[];

  /** Human-readable description of what the service does. */
  description: string;

  /** Ed25519 public key of the advertising peer, hex-encoded. */
  providerPubkey: string;

  /** libp2p PeerId of the advertising peer. */
  providerPeerId: string;

  /** Multiaddrs (as strings) where the provider can be dialled. */
  multiaddrs: string[];

  /** Unix millisecond timestamp recorded when this advertisement was created. */
  advertisedAt: number;

  /**
   * Time-to-live for this advertisement in milliseconds.
   * @defaultValue 300_000 (5 minutes)
   */
  ttl: number;

  /** Arbitrary string key/value metadata attached to the advertisement. */
  metadata: Record<string, string>;
}

/**
 * Predicate used to search the registry.
 * All specified fields are ANDed together; within {@link DiscoveryQuery.tags}
 * a match on any single tag is sufficient.
 */
export interface DiscoveryQuery {
  /** Tags to match — a descriptor is included if it shares at least one tag. */
  tags?: string[];

  /** Case-insensitive substring matched against {@link ServiceDescriptor.name}. */
  name?: string;

  /** Maximum number of results to return. Unlimited when omitted. */
  limit?: number;
}

/**
 * Container returned by the {@link DiscoveryProtocol} when a remote peer
 * answers a query.
 */
export interface DiscoveryResult {
  /** The matching service descriptors returned by the remote peer. */
  services: ServiceDescriptor[];

  /** libp2p PeerId of the peer that produced this result. */
  responderId: string;

  /** Unix millisecond timestamp recorded by the responder. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Default TTL constant
// ---------------------------------------------------------------------------

/** Default advertisement TTL: 5 minutes in milliseconds. */
export const DEFAULT_SERVICE_TTL = 5 * 60 * 1_000;

// ---------------------------------------------------------------------------
// ServiceRegistry
// ---------------------------------------------------------------------------

/**
 * Maintains an in-memory map of {@link ServiceDescriptor} objects, partitioned
 * into locally-registered services and remotely-discovered services.
 *
 * All query, registration, and pruning operations are synchronous and O(n) in
 * the number of known services. For deployments with a large number of services
 * the caller should consider sharding or delegating storage.
 */
export class ServiceRegistry {
  /** All known services keyed by their {@link ServiceDescriptor.id}. */
  private readonly services = new Map<string, ServiceDescriptor>();

  /**
   * IDs of services that were registered on this node (as opposed to
   * discovered from remote peers).
   */
  private readonly localIds = new Set<string>();

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a service provided by this node.
   *
   * A random 16-byte hex ID and the current timestamp are generated
   * automatically. The returned descriptor is the canonical record stored in
   * the registry.
   *
   * @param descriptor - All fields except `id` and `advertisedAt`.
   * @returns The complete {@link ServiceDescriptor} now held in the registry.
   */
  register(
    descriptor: Omit<ServiceDescriptor, 'id' | 'advertisedAt'>,
  ): ServiceDescriptor {
    const id = randomBytes(16).toString('hex');
    const advertisedAt = Date.now();

    const full: ServiceDescriptor = {
      ...descriptor,
      id,
      advertisedAt,
      ttl: descriptor.ttl ?? DEFAULT_SERVICE_TTL,
    };

    this.services.set(id, full);
    this.localIds.add(id);

    return full;
  }

  /**
   * Remove a locally-registered or remotely-discovered service by ID.
   *
   * @param id - The {@link ServiceDescriptor.id} to remove.
   * @returns `true` if the service existed and was removed, `false` otherwise.
   */
  unregister(id: string): boolean {
    const existed = this.services.has(id);
    this.services.delete(id);
    this.localIds.delete(id);
    return existed;
  }

  // ---------------------------------------------------------------------------
  // Remote ingestion
  // ---------------------------------------------------------------------------

  /**
   * Merge a service advertisement received from a remote peer into the
   * registry.
   *
   * If a descriptor with the same ID already exists the incoming record
   * replaces it unconditionally (callers should pre-validate TTL before
   * calling this if deduplication is desired).
   *
   * @param descriptor - The remote {@link ServiceDescriptor} to store.
   */
  addRemote(descriptor: ServiceDescriptor): void {
    this.services.set(descriptor.id, descriptor);
    // Intentionally not added to localIds — it originated remotely.
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Return all services registered on this node (excludes remote-only
   * advertisements).
   */
  getLocal(): ServiceDescriptor[] {
    return [...this.localIds]
      .map((id) => this.services.get(id))
      .filter((d): d is ServiceDescriptor => d !== undefined);
  }

  /**
   * Return every service known to the registry — both local and remote.
   */
  getAll(): ServiceDescriptor[] {
    return [...this.services.values()];
  }

  /**
   * Search local and remote services.
   *
   * Filter rules (all active filters must pass):
   * - `tags`: at least one of the query tags appears in the descriptor's tags.
   * - `name`: the query string appears as a case-insensitive substring of the
   *   descriptor's name.
   * - `limit`: the result set is truncated to at most this many entries.
   *
   * @param query - Search predicate.
   * @returns Matching {@link ServiceDescriptor} records, up to `limit` entries.
   */
  query(query: DiscoveryQuery): ServiceDescriptor[] {
    const { tags, name, limit } = query;

    // Normalise tag set for O(1) membership tests.
    const tagSet = tags && tags.length > 0 ? new Set(tags) : null;
    const nameLower = name !== undefined ? name.toLowerCase() : null;

    const results: ServiceDescriptor[] = [];

    for (const descriptor of this.services.values()) {
      // Tag filter: any tag in the query must appear in the descriptor.
      if (tagSet !== null) {
        const hasTag = descriptor.tags.some((t) => tagSet.has(t));
        if (!hasTag) continue;
      }

      // Name filter: case-insensitive substring match.
      if (nameLower !== null) {
        if (!descriptor.name.toLowerCase().includes(nameLower)) continue;
      }

      results.push(descriptor);

      if (limit !== undefined && results.length >= limit) break;
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /**
   * Remove all services whose TTL has elapsed since `advertisedAt`.
   *
   * @returns The number of descriptors that were evicted.
   */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [id, descriptor] of this.services) {
      if (now - descriptor.advertisedAt > descriptor.ttl) {
        this.services.delete(id);
        this.localIds.delete(id);
        pruned++;
      }
    }

    return pruned;
  }
}
