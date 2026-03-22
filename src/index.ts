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

// Ledgers
export { LocalLedger } from './ledger/local-log.js';
export { SharedLedger } from './ledger/shared-ledger.js';
export { LedgerSync } from './ledger/ledger-sync.js';

// Peer Exchange
export { PeerExchange, type PeerRecord } from './node/peer-exchange.js';

// Config
export { type MagicConfig, DEFAULT_CONFIG, mergeConfig } from './config/config.js';
