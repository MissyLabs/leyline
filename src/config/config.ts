import { Logger } from '../utils/logger.js';

const log = new Logger('Config');

/** Default seed node port for the Leyline network. */
export const DEFAULT_SEED_PORT = 9876;

/**
 * Stable PeerIds for the default seed nodes.
 * These are derived from each node's persistent Ed25519 identity and
 * will not change unless the node's identity.json is deleted.
 */
const SEED_PEER_IDS = {
  node1: '12D3KooWLWdsbESqd6KH153Lr3WiSaQJ8Y8YVbSihuh7fqHczwFe',
  node2: '12D3KooWFtHDt1cMdBDT61mHJfXsWcz8rVugRowzN4RwJqqExch4',
  node3: '12D3KooWFaNRpkuReQKnoiT4AQ8y6zs4sHBYZ6mSWbWapYa92XeU',
  node4: '12D3KooWCUfkcULbQpypdm8qsDU8dmhgV7Sa3pY7HghTbnzUKwTp',
} as const;

/**
 * Hardcoded bootstrap seed nodes for the Leyline network.
 * These are operator-run nodes at missylabs.com that serve as initial
 * entry points for peer discovery. Users can override with `seedNodes`
 * in their config or `--seeds` on the CLI.
 *
 * Each multiaddr includes the node's stable PeerId — required by
 * libp2p's bootstrap module to establish connections.
 */
export const DEFAULT_SEED_NODES: readonly string[] = [
  `/dns4/node1.missylabs.com/tcp/${DEFAULT_SEED_PORT}/p2p/${SEED_PEER_IDS.node1}`,
  `/dns4/node2.missylabs.com/tcp/${DEFAULT_SEED_PORT}/p2p/${SEED_PEER_IDS.node2}`,
  `/dns4/node3.missylabs.com/tcp/${DEFAULT_SEED_PORT}/p2p/${SEED_PEER_IDS.node3}`,
  `/dns4/node4.missylabs.com/tcp/${DEFAULT_SEED_PORT}/p2p/${SEED_PEER_IDS.node4}`,
];

/**
 * Fallback seed nodes using raw IP addresses, in case DNS resolution fails.
 */
export const DEFAULT_SEED_NODES_IP: readonly string[] = [
  `/ip4/107.152.39.241/tcp/${DEFAULT_SEED_PORT}/p2p/${SEED_PEER_IDS.node1}`,
  `/ip4/162.212.158.73/tcp/${DEFAULT_SEED_PORT}/p2p/${SEED_PEER_IDS.node2}`,
  `/ip4/107.152.33.193/tcp/${DEFAULT_SEED_PORT}/p2p/${SEED_PEER_IDS.node3}`,
  `/ip4/130.51.20.39/tcp/${DEFAULT_SEED_PORT}/p2p/${SEED_PEER_IDS.node4}`,
];

export interface MagicConfig {
  /** Port to listen on */
  listenPort: number;

  /** Addresses to listen on */
  listenAddresses: string[];

  /** Bootstrap/seed node multiaddrs. Defaults to the Leyline network seeds. */
  seedNodes: string[];

  /** Whether this node operates as a seed node */
  isSeedNode: boolean;

  /** Directory for persistent data (ledger, keys, etc.) */
  dataDir: string;

  /** Maximum message payload size in bytes */
  maxPayloadSize: number;

  /** Default TTL for outgoing messages */
  defaultTtl: number;

  /** Max messages per minute per sender before rate limiting */
  rateLimitPerMinute: number;

  /**
   * Global inbound message delivery cap per minute (across ALL senders).
   * Messages exceeding this are silently dropped before reaching handlers.
   * This is the primary defense against token burn from chatty networks.
   * Set to 0 to disable (not recommended for bot nodes).
   * @defaultValue 200
   */
  maxInboundPerMinute: number;

  /**
   * Maximum total payload bytes accepted per sender per minute.
   * Prevents a single agent from burning bandwidth/tokens with large payloads
   * even within the per-message rate limit.
   * Set to 0 to disable.
   * @defaultValue 1048576 (1MB)
   */
  maxPayloadBytesPerMinute: number;

  /**
   * Spam count threshold that triggers automatic blocking.
   * When a sender accumulates this many spam reports, they are automatically
   * blocked (no manual intervention required). Set to 0 to disable.
   * @defaultValue 10
   */
  autoBlockThreshold: number;

  /** Max seen message IDs to track for deduplication */
  maxSeenMessages: number;

  /** Tags this node subscribes to */
  subscribedTags: string[];

  /** Tags this node advertises */
  advertisedTags: string[];

  /** Enable WebSocket transport */
  enableWebSocket: boolean;

  /** Enable circuit relay transport (NAT traversal) */
  enableRelay: boolean;

  /** Port for the WebSocket listener */
  webSocketPort: number;

  /** Port for the seed node HTTP health check endpoint. 0 to disable. */
  healthCheckPort: number;

  /** Enable mDNS for automatic local network peer discovery. */
  enableMdns: boolean;

  /**
   * Maximum number of peer connections this node will maintain.
   * Once reached, new inbound connections are rejected.
   * Set to 0 for unlimited (not recommended for production).
   * @defaultValue 100
   */
  maxConnections: number;

  /**
   * Per-tag message rate limits (messages per minute per sender).
   *
   * Tags not listed here use the global {@link rateLimitPerMinute} value.
   * When a sender exceeds the per-tag limit for any tag carried by an
   * inbound message, the message is dropped before the global check runs.
   *
   * Example: `{ 'system:alert': 500, 'chat:general': 30 }`
   *
   * @defaultValue {} (empty — all tags use the global limit)
   */
  tagRateLimits: Record<string, number>;
}

export const DEFAULT_CONFIG: MagicConfig = {
  listenPort: 9876,
  listenAddresses: ['/ip4/0.0.0.0/tcp/9876', '/ip4/0.0.0.0/tcp/9877/ws'],
  seedNodes: [...DEFAULT_SEED_NODES],
  isSeedNode: false,
  dataDir: './data',
  maxPayloadSize: 262144, // 256KB
  defaultTtl: 7,
  rateLimitPerMinute: 60,
  maxInboundPerMinute: 200,
  maxPayloadBytesPerMinute: 1_048_576,
  autoBlockThreshold: 10,
  maxSeenMessages: 100000,
  subscribedTags: [],
  advertisedTags: [],
  enableWebSocket: true,
  enableRelay: true,
  webSocketPort: 9877,
  healthCheckPort: 0,
  enableMdns: false,
  maxConnections: 100,
  tagRateLimits: {},
};

export function mergeConfig(partial: Partial<MagicConfig>): MagicConfig {
  const merged = { ...DEFAULT_CONFIG, ...partial };

  // If the user provided listenPort or webSocketPort but not custom listenAddresses,
  // rebuild the default listen addresses from the port values.
  if (!partial.listenAddresses) {
    merged.listenAddresses = [`/ip4/0.0.0.0/tcp/${merged.listenPort}`];
    if (merged.enableWebSocket) {
      merged.listenAddresses.push(`/ip4/0.0.0.0/tcp/${merged.webSocketPort}/ws`);
    }
  }

  // Seed nodes bootstrap to the OTHER default seeds so they form a mesh.
  // libp2p ignores its own addresses, so including yourself is harmless.
  // Only clear seeds if the user explicitly passed an empty array.
  if (partial.isSeedNode && partial.seedNodes !== undefined && partial.seedNodes.length === 0) {
    merged.seedNodes = [];
  }

  // Warn about isSeedNode — should only be set via SeedNode constructor
  if (partial.isSeedNode) {
    log.warn('isSeedNode is set — use the SeedNode class instead of MagicNode to avoid misconfiguration');
  }

  return merged;
}
