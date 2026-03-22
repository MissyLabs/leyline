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
}

export const DEFAULT_CONFIG: MagicConfig = {
  listenPort: 9876,
  listenAddresses: ['/ip4/0.0.0.0/tcp/9876'],
  seedNodes: [],
  isSeedNode: false,
  dataDir: './data',
  maxPayloadSize: 262144, // 256KB
  defaultTtl: 7,
  rateLimitPerMinute: 60,
  maxSeenMessages: 100000,
  subscribedTags: [],
  advertisedTags: [],
};

export function mergeConfig(partial: Partial<MagicConfig>): MagicConfig {
  return { ...DEFAULT_CONFIG, ...partial };
}
