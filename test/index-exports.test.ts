import { describe, it, expect } from 'vitest';
import * as leyline from '../src/index.js';

describe('Index — public API exports', () => {
  it('exports core node classes', () => {
    expect(leyline.MagicNode).toBeDefined();
    expect(leyline.SeedNode).toBeDefined();
  });

  it('exports identity functions', () => {
    expect(typeof leyline.generateKeypair).toBe('function');
    expect(typeof leyline.sign).toBe('function');
    expect(typeof leyline.verify).toBe('function');
    expect(typeof leyline.publicKeyToHex).toBe('function');
    expect(typeof leyline.hexToPublicKey).toBe('function');
    expect(typeof leyline.getFingerprint).toBe('function');
    expect(leyline.IdentityStore).toBeDefined();
  });

  it('exports message types and functions', () => {
    expect(leyline.MessageType).toBeDefined();
    expect(leyline.MessageType.BROADCAST).toBe(1);
    expect(leyline.MessageType.DIRECT).toBe(2);
    expect(typeof leyline.createMessage).toBe('function');
    expect(typeof leyline.serializeMessage).toBe('function');
    expect(typeof leyline.serializeMessageJson).toBe('function');
    expect(typeof leyline.deserializeMessage).toBe('function');
    expect(typeof leyline.deserializeMessageJson).toBe('function');
    expect(typeof leyline.validateMessage).toBe('function');
    expect(typeof leyline.verifyMessageSignature).toBe('function');
    expect(leyline.MAX_PAYLOAD_SIZE).toBe(262144);
    expect(typeof leyline.initProto).toBe('function');
  });

  it('exports pubsub', () => {
    expect(leyline.TagPubSub).toBeDefined();
  });

  it('exports trust classes', () => {
    expect(leyline.TrustPolicy).toBeDefined();
    expect(leyline.SpamFilter).toBeDefined();
    expect(leyline.PersistentTrustPolicy).toBeDefined();
    expect(leyline.PersistentSpamFilter).toBeDefined();
    expect(leyline.PeerReputation).toBeDefined();
  });

  it('exports ledger classes', () => {
    expect(leyline.LocalLedger).toBeDefined();
    expect(leyline.SharedLedger).toBeDefined();
    expect(leyline.LedgerSync).toBeDefined();
    expect(leyline.LedgerConsensus).toBeDefined();
    expect(leyline.ForkResolver).toBeDefined();
  });

  it('exports peer exchange', () => {
    expect(leyline.PeerExchange).toBeDefined();
  });

  it('exports direct messaging', () => {
    expect(leyline.DirectMessageProtocol).toBeDefined();
    expect(leyline.DIRECT_MESSAGE_PROTOCOL).toBeDefined();
  });

  it('exports config', () => {
    expect(leyline.DEFAULT_CONFIG).toBeDefined();
    expect(leyline.DEFAULT_SEED_NODES).toBeDefined();
    expect(typeof leyline.mergeConfig).toBe('function');
  });

  it('exports discovery', () => {
    expect(leyline.ServiceRegistry).toBeDefined();
    expect(leyline.PersistentServiceRegistry).toBeDefined();
    expect(leyline.DiscoveryProtocol).toBeDefined();
    expect(leyline.DISCOVERY_PROTOCOL).toBeDefined();
    expect(leyline.DEFAULT_SERVICE_TTL).toBeDefined();
  });

  it('exports version compatibility', () => {
    expect(typeof leyline.LEYLINE_VERSION).toBe('string');
    expect(leyline.COMPAT).toBeDefined();
    expect(typeof leyline.checkCompat).toBe('function');
    expect(typeof leyline.semverGte).toBe('function');
    expect(typeof leyline.semverLt).toBe('function');
    expect(leyline.HandshakeProtocol).toBeDefined();
    expect(leyline.HANDSHAKE_PROTOCOL).toBeDefined();
  });

  it('exports health check', () => {
    expect(leyline.HealthCheckServer).toBeDefined();
  });

  it('exports store-and-forward', () => {
    expect(leyline.MessageBuffer).toBeDefined();
    expect(leyline.InboxServer).toBeDefined();
    expect(leyline.InboxClient).toBeDefined();
    expect(leyline.INBOX_PROTOCOL).toBeDefined();
  });

  it('exports utilities', () => {
    expect(typeof leyline.withTimeout).toBe('function');
    expect(leyline.STREAM_TIMEOUT_MS).toBeDefined();
    expect(leyline.StreamAbortedError).toBeDefined();
    expect(typeof leyline.compressMessage).toBe('function');
    expect(typeof leyline.decompressMessage).toBe('function');
    expect(typeof leyline.isCompressedMessage).toBe('function');
    expect(leyline.NodeMetrics).toBeDefined();
    expect(leyline.PartitionDetector).toBeDefined();
    expect(leyline.PriorityQueue).toBeDefined();
    expect(leyline.MessagePriority).toBeDefined();
    expect(leyline.Logger).toBeDefined();
    expect(leyline.LogLevel).toBeDefined();
    expect(typeof leyline.setGlobalLogLevel).toBe('function');
    expect(typeof leyline.getGlobalLogLevel).toBe('function');
    expect(typeof leyline.setGlobalLogHandler).toBe('function');
  });

  it('exports crypto envelope', () => {
    expect(typeof leyline.encryptPayload).toBe('function');
    expect(typeof leyline.decryptPayload).toBe('function');
    expect(typeof leyline.ed25519PubToX25519).toBe('function');
    expect(typeof leyline.ed25519PrivToX25519).toBe('function');
    expect(typeof leyline.computeSharedSecret).toBe('function');
  });
});
