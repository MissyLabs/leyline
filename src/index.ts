// Core node
export { MagicNode, type MagicNodeEvents } from './node/magic-node.js';
export { SeedNode } from './node/seed-node.js';

// Identity
export {
  generateKeypair,
  sign,
  verify,
  publicKeyToHex,
  hexToPublicKey,
  getFingerprint,
} from './identity/keypair.js';
export { IdentityStore } from './identity/store.js';

// Messages
export {
  type MagicMessage,
  MessageType,
  type SerializationFormat,
  createMessage,
  serializeMessage,
  serializeMessageJson,
  deserializeMessage,
  deserializeMessageJson,
  validateMessage,
  verifyMessageSignature,
  MAX_PAYLOAD_SIZE,
} from './messages/message.js';
export { initProto } from './messages/proto.js';

// Pub/Sub
export { TagPubSub } from './pubsub/tag-pubsub.js';

// Trust
export { TrustPolicy, SpamFilter } from './trust/policy.js';
export { PersistentTrustPolicy, PersistentSpamFilter } from './trust/persistent-policy.js';
export { PeerReputation, type PeerReputationRecord, type PeerReputationConfig } from './trust/peer-reputation.js';

// Ledgers
export { LocalLedger } from './ledger/local-log.js';
export { SharedLedger } from './ledger/shared-ledger.js';
export { LedgerSync } from './ledger/ledger-sync.js';
export {
  LedgerConsensus,
  type ConsensusConfig,
  type EntryProposal,
} from './ledger/consensus.js';
export { ForkResolver, type ForkInfo, type PeerChainQuerier } from './ledger/fork-resolver.js';

// Peer Exchange
export { PeerExchange, type PeerRecord } from './node/peer-exchange.js';

// Direct Messaging
export {
  DirectMessageProtocol,
  type DirectEnvelope,
  type DirectMessageOptions,
  type DirectMessageTrustChecker,
  DIRECT_MESSAGE_PROTOCOL,
} from './node/direct-message.js';

// Config
export {
  type MagicConfig,
  DEFAULT_CONFIG,
  DEFAULT_SEED_NODES,
  DEFAULT_SEED_NODES_IP,
  DEFAULT_SEED_PORT,
  mergeConfig,
} from './config/config.js';

// Discovery
export {
  ServiceRegistry,
  type ServiceDescriptor,
  type DiscoveryQuery,
  type DiscoveryResult,
  DEFAULT_SERVICE_TTL,
} from './discovery/service-registry.js';
export { PersistentServiceRegistry } from './discovery/persistent-registry.js';
export {
  DiscoveryProtocol,
  type DiscoveryTrustChecker,
  type DiscoveryRateLimitConfig,
  DISCOVERY_PROTOCOL,
} from './discovery/discovery-protocol.js';

// Version Compatibility
export {
  LEYLINE_VERSION,
  COMPAT,
  checkCompat,
  semverGte,
  semverLt,
  type CompatMatrix,
  type CompatResult,
} from './config/compat.js';
export {
  HandshakeProtocol,
  HANDSHAKE_PROTOCOL,
  type HandshakeEvents,
} from './node/handshake-protocol.js';

// Health Check
export { HealthCheckServer, type HealthStatus, type HealthCheckDeps } from './node/health-check.js';

// Store-and-Forward
export { MessageBuffer, type BufferedMessage, type MessageBufferConfig } from './node/message-buffer.js';
export { InboxServer, InboxClient, INBOX_PROTOCOL } from './node/inbox-protocol.js';

// Utilities
export { withTimeout, STREAM_TIMEOUT_MS, StreamAbortedError } from './utils/stream-timeout.js';
export { compressMessage, decompressMessage, isCompressedMessage } from './utils/compression.js';
export { NodeMetrics, type MetricEvent, type MetricsSnapshot } from './utils/metrics.js';

// Crypto
export {
  encryptPayload,
  decryptPayload,
  ed25519PubToX25519,
  ed25519PrivToX25519,
  computeSharedSecret,
} from './crypto/envelope.js';
