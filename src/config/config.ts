export interface MagicConfig {
  /** Port to listen on */
  listenPort: number;

  /** Addresses to listen on */
  listenAddresses: string[];

  /** Bootstrap/seed node multiaddrs */
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
  seedNodes: [],
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
  return { ...DEFAULT_CONFIG, ...partial };
}
