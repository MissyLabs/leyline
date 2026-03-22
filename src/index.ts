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

// Messages
export {
  type MagicMessage,
  MessageType,
  createMessage,
  serializeMessage,
  deserializeMessage,
  validateMessage,
  verifyMessageSignature,
  MAX_PAYLOAD_SIZE,
} from './messages/message.js';

// Pub/Sub
export { TagPubSub } from './pubsub/tag-pubsub.js';

// Trust
export { TrustPolicy, SpamFilter } from './trust/policy.js';

// Ledgers
export { LocalLedger } from './ledger/local-log.js';
export { SharedLedger } from './ledger/shared-ledger.js';

// Config
export { type MagicConfig, DEFAULT_CONFIG, mergeConfig } from './config/config.js';
