/** Default seed node port for the Leyline network. */
export const DEFAULT_SEED_PORT = 9876;

/**
 * Hardcoded bootstrap seed nodes for the Leyline network.
 * These are operator-run nodes at missylabs.com that serve as initial
 * entry points for peer discovery. Users can override with `seedNodes`
 * in their config or `--seeds` on the CLI.
 */
export const DEFAULT_SEED_NODES: readonly string[] = [
  `/dns4/node1.missylabs.com/tcp/${DEFAULT_SEED_PORT}`,
  `/dns4/node2.missylabs.com/tcp/${DEFAULT_SEED_PORT}`,
  `/dns4/node3.missylabs.com/tcp/${DEFAULT_SEED_PORT}`,
  `/dns4/node4.missylabs.com/tcp/${DEFAULT_SEED_PORT}`,
];

/**
 * Fallback seed nodes using raw IP addresses, in case DNS resolution fails.
 */
export const DEFAULT_SEED_NODES_IP: readonly string[] = [
  `/ip4/107.152.39.241/tcp/${DEFAULT_SEED_PORT}`,
  `/ip4/162.212.158.73/tcp/${DEFAULT_SEED_PORT}`,
  `/ip4/107.152.33.193/tcp/${DEFAULT_SEED_PORT}`,
  `/ip4/130.51.20.39/tcp/${DEFAULT_SEED_PORT}`,
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
  maxSeenMessages: 100000,
  subscribedTags: [],
  advertisedTags: [],
  enableWebSocket: true,
  enableRelay: true,
  webSocketPort: 9877,
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

  // Seed nodes themselves don't bootstrap to the default seeds (they ARE the seeds)
  if (partial.isSeedNode && !partial.seedNodes) {
    merged.seedNodes = [];
  }

  // Warn about isSeedNode — should only be set via SeedNode constructor
  if (partial.isSeedNode) {
    console.warn('[Config] isSeedNode is set — use the SeedNode class instead of MagicNode to avoid misconfiguration');
  }

  return merged;
}
