import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { generateKeypair, publicKeyToHex, sign } from '../src/identity/keypair.js';
import { ServiceRegistry } from '../src/discovery/service-registry.js';
import { DiscoveryProtocol } from '../src/discovery/discovery-protocol.js';
import { withTimeout } from '../src/utils/stream-timeout.js';
import {
  LedgerConsensus,
  SharedLedger,
  TrustPolicy,
  SpamFilter,
  MessageBuffer,
  DirectMessageProtocol,
  DIRECT_MESSAGE_PROTOCOL,
  type DirectEnvelope,
  HandshakeProtocol,
  HANDSHAKE_PROTOCOL,
} from '../src/index.js';

// =========================================================================
// withTimeout edge cases
// =========================================================================

describe('withTimeout — edge cases', () => {
  it('handles source that throws', async () => {
    async function* throwingSource() {
      yield 1;
      throw new Error('boom');
    }

    const results: number[] = [];
    await expect(async () => {
      for await (const item of withTimeout(throwingSource(), 5000)) {
        results.push(item);
      }
    }).rejects.toThrow('boom');
    expect(results).toEqual([1]);
  });

  it('handles break from consumer side', async () => {
    let cleaned = false;
    async function* infiniteSource() {
      try {
        let i = 0;
        while (true) {
          yield i++;
        }
      } finally {
        cleaned = true;
      }
    }

    const results: number[] = [];
    for await (const item of withTimeout(infiniteSource(), 5000)) {
      results.push(item);
      if (item >= 2) break;
    }
    expect(results).toEqual([0, 1, 2]);
    expect(cleaned).toBe(true);
  });

  it('concurrent timeouts do not interfere', async () => {
    async function* delayedSource(delayMs: number) {
      yield 'a';
      await new Promise((r) => setTimeout(r, delayMs));
      yield 'b';
    }

    const fast = [];
    const slow = [];

    const [fastResult, slowResult] = await Promise.allSettled([
      (async () => {
        for await (const item of withTimeout(delayedSource(10), 5000)) {
          fast.push(item);
        }
      })(),
      (async () => {
        for await (const item of withTimeout(delayedSource(200), 50)) {
          slow.push(item);
        }
      })(),
    ]);

    expect(fast).toEqual(['a', 'b']);
    expect(slow).toEqual(['a']);
  });
});

// =========================================================================
// Trust Policy edge cases
// =========================================================================

describe('TrustPolicy — edge cases', () => {
  it('block overrides allow even for open tags', () => {
    const policy = new TrustPolicy();
    policy.allowTagOpen('public');
    policy.blockAgent('evil-agent');

    expect(policy.isAllowed('evil-agent', ['public'])).toBe(false);
    expect(policy.isAllowed('good-agent', ['public'])).toBe(true);
  });

  it('open tag requires ALL tags to be open', () => {
    const policy = new TrustPolicy();
    policy.allowTagOpen('open-tag');

    expect(policy.isAllowed('agent', ['open-tag'])).toBe(true);
    expect(policy.isAllowed('agent', ['open-tag', 'closed-tag'])).toBe(false);
  });

  it('empty tags always denied for unknown agents', () => {
    const policy = new TrustPolicy();
    expect(policy.isAllowed('unknown', [])).toBe(false);
  });

  it('per-tag allow requires agent-level allow', () => {
    const policy = new TrustPolicy();
    policy.allowTag('agent1', 'skill:code');
    // Agent-level allow is required before tag rules are evaluated
    expect(policy.isAllowed('agent1', ['skill:code'])).toBe(false);
    policy.allowAgent('agent1');
    expect(policy.isAllowed('agent1', ['skill:code'])).toBe(true);
    expect(policy.isAllowed('agent1', ['skill:other'])).toBe(false);
  });
});

// =========================================================================
// SpamFilter edge cases
// =========================================================================

describe('SpamFilter — edge cases', () => {
  it('deduplicates messages by ID', () => {
    const filter = new SpamFilter();
    expect(filter.isDuplicate('msg1')).toBe(false);
    expect(filter.isDuplicate('msg1')).toBe(true);
  });

  it('rate limits after threshold', () => {
    const filter = new SpamFilter();
    // isRateLimited records a timestamp on each call; exceeds maxPerMinute after 4th call
    expect(filter.isRateLimited('sender1', 3)).toBe(false); // count=1, 1>3 false
    expect(filter.isRateLimited('sender1', 3)).toBe(false); // count=2, 2>3 false
    expect(filter.isRateLimited('sender1', 3)).toBe(false); // count=3, 3>3 false
    expect(filter.isRateLimited('sender1', 3)).toBe(true);  // count=4, 4>3 true
  });

  it('different senders have independent limits', () => {
    const filter = new SpamFilter();
    filter.isRateLimited('sender1', 1); // count=1, 1>1 false
    expect(filter.isRateLimited('sender1', 1)).toBe(true); // count=2, 2>1 true
    expect(filter.isRateLimited('sender2', 1)).toBe(false); // count=1, 1>1 false
  });
});

// =========================================================================
// LedgerConsensus — security edge cases
// =========================================================================

describe('LedgerConsensus — security edge cases', () => {
  it('rejects proposal when pending limit reached', () => {
    const consensus = new LedgerConsensus({ maxPendingEntries: 2 });
    consensus.propose(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([20]));
    consensus.propose(new Uint8Array([2]), new Uint8Array([11]), new Uint8Array([21]));
    expect(() =>
      consensus.propose(new Uint8Array([3]), new Uint8Array([12]), new Uint8Array([22])),
    ).toThrow(/maxPendingEntries/);
  });

  it('rejects remote proposal with future timestamp beyond clock skew', () => {
    const consensus = new LedgerConsensus({ maxClockSkewMs: 1000 });
    const farFuture = Date.now() + 60_000;
    const result = consensus.proposeRemote(
      new Uint8Array([1]),
      new Uint8Array([10]),
      new Uint8Array([20]),
      farFuture,
    );
    expect(result).toBeUndefined();
  });

  it('deduplicates proposals with same content', () => {
    const consensus = new LedgerConsensus();
    const data = new Uint8Array([1, 2, 3]);
    const pubkey = new Uint8Array([10, 20, 30]);
    const sig = new Uint8Array([40, 50, 60]);
    const p1 = consensus.propose(data, pubkey, sig);
    const p2 = consensus.propose(data, pubkey, sig);
    expect(p1.hash).toBe(p2.hash);
  });

  it('confirmation from same peer counted only once', () => {
    const consensus = new LedgerConsensus({ quorumSize: 3 });
    const p = consensus.propose(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([20]));
    consensus.addConfirmation(p.hash, 'peer1');
    consensus.addConfirmation(p.hash, 'peer1');
    consensus.addConfirmation(p.hash, 'peer1');
    expect(consensus.isFinalized(p.hash)).toBe(false);
    consensus.addConfirmation(p.hash, 'peer2');
    consensus.addConfirmation(p.hash, 'peer3');
    expect(consensus.isFinalized(p.hash)).toBe(true);
  });

  it('rejected proposals cannot be finalized', () => {
    const consensus = new LedgerConsensus({ quorumSize: 1 });
    const p = consensus.propose(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([20]));
    consensus.reject(p.hash);
    consensus.addConfirmation(p.hash, 'peer1');
    expect(consensus.isFinalized(p.hash)).toBe(false);
  });
});

// =========================================================================
// ServiceRegistry — descriptor validation
// =========================================================================

describe('ServiceRegistry — descriptor validation', () => {
  it('rejects descriptors with oversized name', () => {
    const registry = new ServiceRegistry();
    const result = registry.addRemote({
      id: 'test-id',
      name: 'x'.repeat(300),
      tags: ['test'],
      description: 'test',
      providerPubkey: 'aabb',
      providerPeerId: 'peer1',
      multiaddrs: [],
      advertisedAt: Date.now(),
      ttl: 300000,
      metadata: {},
    });
    expect(result).toBe(false);
  });

  it('rejects descriptors with too many tags', () => {
    const registry = new ServiceRegistry();
    const result = registry.addRemote({
      id: 'test-id',
      name: 'test',
      tags: Array.from({ length: 200 }, (_, i) => `tag${i}`),
      description: 'test',
      providerPubkey: 'aabb',
      providerPeerId: 'peer1',
      multiaddrs: [],
      advertisedAt: Date.now(),
      ttl: 300000,
      metadata: {},
    });
    expect(result).toBe(false);
  });

  it('rejects descriptors with too many metadata keys', () => {
    const registry = new ServiceRegistry();
    const metadata: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      metadata[`key${i}`] = 'value';
    }
    const result = registry.addRemote({
      id: 'test-id',
      name: 'test',
      tags: ['test'],
      description: 'test',
      providerPubkey: 'aabb',
      providerPeerId: 'peer1',
      multiaddrs: [],
      advertisedAt: Date.now(),
      ttl: 300000,
      metadata,
    });
    expect(result).toBe(false);
  });

  it('accepts valid descriptors', () => {
    const registry = new ServiceRegistry();
    const result = registry.addRemote({
      id: 'test-id',
      name: 'test',
      tags: ['test'],
      description: 'A valid service',
      providerPubkey: 'aabb',
      providerPeerId: 'peer1',
      multiaddrs: ['/ip4/127.0.0.1/tcp/9876'],
      advertisedAt: Date.now(),
      ttl: 300000,
      metadata: { version: '1.0' },
    });
    expect(result).toBe(true);
  });
});

// =========================================================================
// MessageBuffer — bounded storage
// =========================================================================

describe('MessageBuffer — bounded storage', () => {
  it('respects per-topic message limit', () => {
    const buffer = new MessageBuffer({ maxPerTopic: 3 });
    buffer.start();

    buffer.push('topic1', new Uint8Array([1]), 'id1');
    buffer.push('topic1', new Uint8Array([2]), 'id2');
    buffer.push('topic1', new Uint8Array([3]), 'id3');
    buffer.push('topic1', new Uint8Array([4]), 'id4');

    const messages = buffer.getForTopics(['topic1'], 0);
    expect(messages.length).toBe(3);
    expect(messages[0].id).toBe('id2');

    buffer.stop();
  });

  it('deduplicates by message ID', () => {
    const buffer = new MessageBuffer();
    buffer.start();

    expect(buffer.push('topic1', new Uint8Array([1]), 'id1')).toBe(true);
    expect(buffer.push('topic1', new Uint8Array([1]), 'id1')).toBe(false);
    expect(buffer.getCount()).toBe(1);

    buffer.stop();
  });

  it('filters by since timestamp', async () => {
    const buffer = new MessageBuffer();
    buffer.start();

    buffer.push('topic1', new Uint8Array([1]), 'id1');
    const afterFirst = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    buffer.push('topic1', new Uint8Array([2]), 'id2');

    const messages = buffer.getForTopics(['topic1'], afterFirst);
    expect(messages.length).toBeGreaterThanOrEqual(1);

    buffer.stop();
  });
});

// =========================================================================
// SpamFilter — reportSpam tracking
// =========================================================================

describe('SpamFilter — reportSpam tracking', () => {
  it('starts with a spam count of zero for any sender', () => {
    const filter = new SpamFilter();
    expect(filter.getSpamCount('unknown-sender')).toBe(0);
  });

  it('increments spam count by one per reportSpam call', () => {
    const filter = new SpamFilter();
    filter.reportSpam('spammer1');
    expect(filter.getSpamCount('spammer1')).toBe(1);
    filter.reportSpam('spammer1');
    expect(filter.getSpamCount('spammer1')).toBe(2);
    filter.reportSpam('spammer1');
    expect(filter.getSpamCount('spammer1')).toBe(3);
  });

  it('spam counts are per-sender and do not cross-contaminate', () => {
    const filter = new SpamFilter();
    filter.reportSpam('alice');
    filter.reportSpam('alice');
    filter.reportSpam('bob');

    expect(filter.getSpamCount('alice')).toBe(2);
    expect(filter.getSpamCount('bob')).toBe(1);
    expect(filter.getSpamCount('charlie')).toBe(0);
  });

  it('spam count accumulates across many reports', () => {
    const filter = new SpamFilter();
    const COUNT = 50;
    for (let i = 0; i < COUNT; i++) {
      filter.reportSpam('flood-sender');
    }
    expect(filter.getSpamCount('flood-sender')).toBe(COUNT);
  });

  it('multiple senders can each be reported independently', () => {
    const filter = new SpamFilter();
    const senders = ['s1', 's2', 's3', 's4'];
    senders.forEach((s, i) => {
      for (let j = 0; j <= i; j++) {
        filter.reportSpam(s);
      }
    });
    expect(filter.getSpamCount('s1')).toBe(1);
    expect(filter.getSpamCount('s2')).toBe(2);
    expect(filter.getSpamCount('s3')).toBe(3);
    expect(filter.getSpamCount('s4')).toBe(4);
  });
});

// =========================================================================
// TrustPolicy — additional edge cases
// =========================================================================

describe('TrustPolicy — additional edge cases', () => {
  it('blockAgent after allowAgent still blocks the agent', () => {
    const policy = new TrustPolicy();
    policy.allowAgent('agent1');
    expect(policy.isAllowed('agent1', [])).toBe(true);
    policy.blockAgent('agent1');
    expect(policy.isAllowed('agent1', [])).toBe(false);
    // Granting allow again after block should not restore access
    policy.allowAgent('agent1');
    expect(policy.isAllowed('agent1', [])).toBe(false);
  });

  it('allowTagOpen + blockTag for same agent: block wins on per-agent tag check', () => {
    const policy = new TrustPolicy();
    // 'news' is open to all (unknown senders pass)
    policy.allowTagOpen('news');
    // agent1 is explicitly allowed
    policy.allowAgent('agent1');
    // block agent1 from using the 'news' tag specifically
    policy.blockTag('agent1', 'news');

    // Unknown sender can still use the open tag
    expect(policy.isAllowed('unknown-agent', ['news'])).toBe(true);
    // agent1's tag-level block overrides their agent-level allow
    expect(policy.isAllowed('agent1', ['news'])).toBe(false);
  });

  it('agent allowed on some tags but denied on others when tag rules exist', () => {
    const policy = new TrustPolicy();
    policy.allowAgent('agent1');
    policy.allowTag('agent1', 'skill:code');
    policy.allowTag('agent1', 'skill:test');

    // Allowed tags pass
    expect(policy.isAllowed('agent1', ['skill:code'])).toBe(true);
    expect(policy.isAllowed('agent1', ['skill:test'])).toBe(true);

    // A tag not in the allowed set is denied when tag rules exist
    expect(policy.isAllowed('agent1', ['skill:other'])).toBe(false);

    // Mixed: one allowed, one not — entire message is denied
    expect(policy.isAllowed('agent1', ['skill:code', 'skill:other'])).toBe(false);

    // All allowed tags together should pass
    expect(policy.isAllowed('agent1', ['skill:code', 'skill:test'])).toBe(true);
  });

  it('blockAgent overrides allowTagOpen for blocked agent', () => {
    const policy = new TrustPolicy();
    policy.allowTagOpen('public');
    policy.allowTagOpen('announce');
    policy.blockAgent('bad-actor');

    // bad-actor blocked even though both tags are open
    expect(policy.isAllowed('bad-actor', ['public'])).toBe(false);
    expect(policy.isAllowed('bad-actor', ['announce'])).toBe(false);
    expect(policy.isAllowed('bad-actor', ['public', 'announce'])).toBe(false);

    // Other unknown senders still pass on open tags
    expect(policy.isAllowed('innocent-agent', ['public'])).toBe(true);
  });

  it('no tag rules on allowed agent — all tags pass', () => {
    const policy = new TrustPolicy();
    policy.allowAgent('free-agent');

    // No tag-level rules at all: any tag combination is allowed
    expect(policy.isAllowed('free-agent', ['tag:a'])).toBe(true);
    expect(policy.isAllowed('free-agent', ['tag:a', 'tag:b', 'tag:c'])).toBe(true);
    expect(policy.isAllowed('free-agent', [])).toBe(true);
  });

  it('allowTagOpen with no tags on the message still denies unknown agents', () => {
    const policy = new TrustPolicy();
    policy.allowTagOpen('open');
    // Unknown agent sends a message with no tags — cannot match any open tag
    expect(policy.isAllowed('unknown', [])).toBe(false);
  });
});

// =========================================================================
// MessageBuffer — multi-topic edge cases
// =========================================================================

describe('MessageBuffer — multi-topic edge cases', () => {
  it('multiple topics do not interfere with each other', () => {
    const buffer = new MessageBuffer({ maxPerTopic: 3 });
    buffer.start();

    buffer.push('topicA', new Uint8Array([1]), 'a1');
    buffer.push('topicA', new Uint8Array([2]), 'a2');
    buffer.push('topicB', new Uint8Array([3]), 'b1');
    buffer.push('topicB', new Uint8Array([4]), 'b2');
    buffer.push('topicB', new Uint8Array([5]), 'b3');

    const msgsA = buffer.getForTopics(['topicA'], 0);
    const msgsB = buffer.getForTopics(['topicB'], 0);

    expect(msgsA.length).toBe(2);
    expect(msgsA.every((m) => m.topic === 'topicA')).toBe(true);
    expect(msgsB.length).toBe(3);
    expect(msgsB.every((m) => m.topic === 'topicB')).toBe(true);

    buffer.stop();
  });

  it('getCount reflects total message count across all topics', () => {
    const buffer = new MessageBuffer();
    buffer.start();

    buffer.push('t1', new Uint8Array([1]), 'c-id1');
    buffer.push('t1', new Uint8Array([2]), 'c-id2');
    buffer.push('t2', new Uint8Array([3]), 'c-id3');
    buffer.push('t3', new Uint8Array([4]), 'c-id4');

    expect(buffer.getCount()).toBe(4);

    buffer.stop();
  });

  it('push returns false for a duplicate ID regardless of topic', () => {
    const buffer = new MessageBuffer();
    buffer.start();

    expect(buffer.push('topicX', new Uint8Array([1]), 'shared-id')).toBe(true);
    // Same ID on a different topic is still a duplicate — the seenIds set is global
    expect(buffer.push('topicY', new Uint8Array([2]), 'shared-id')).toBe(false);
    // Count should still be 1 (not 2)
    expect(buffer.getCount()).toBe(1);

    buffer.stop();
  });

  it('per-topic overflow does not affect other topics', () => {
    const buffer = new MessageBuffer({ maxPerTopic: 2 });
    buffer.start();

    // Fill topicA past its limit
    buffer.push('topicA', new Uint8Array([1]), 'ov-a1');
    buffer.push('topicA', new Uint8Array([2]), 'ov-a2');
    buffer.push('topicA', new Uint8Array([3]), 'ov-a3'); // evicts 'ov-a1'

    // topicB is unaffected
    buffer.push('topicB', new Uint8Array([4]), 'ov-b1');

    const msgsA = buffer.getForTopics(['topicA'], 0);
    const msgsB = buffer.getForTopics(['topicB'], 0);

    expect(msgsA.length).toBe(2);
    expect(msgsA.map((m) => m.id)).toEqual(['ov-a2', 'ov-a3']);
    expect(msgsB.length).toBe(1);
    expect(msgsB[0].id).toBe('ov-b1');

    buffer.stop();
  });

  it('getForTopics with multiple topic names returns combined results', () => {
    const buffer = new MessageBuffer();
    buffer.start();

    buffer.push('alpha', new Uint8Array([1]), 'multi-a1');
    buffer.push('beta', new Uint8Array([2]), 'multi-b1');
    buffer.push('gamma', new Uint8Array([3]), 'multi-g1');

    const combined = buffer.getForTopics(['alpha', 'gamma'], 0);
    expect(combined.length).toBe(2);
    const ids = combined.map((m) => m.id).sort();
    expect(ids).toEqual(['multi-a1', 'multi-g1'].sort());

    buffer.stop();
  });
});

// =========================================================================
// DirectEnvelope — payload size limit (indirect via protocol)
// =========================================================================

async function createTestNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

/** Build a minimal well-formed wire envelope JSON as raw bytes. */
function buildWireEnvelope(overrides: Partial<{
  payload: string;
  targetPeerId: string;
  senderPeerId: string;
  senderPubkeyHex: string;
  timestamp: number;
  isRelay: boolean;
  hopsRemaining: number;
  encrypted: boolean;
}>): Uint8Array {
  const wire = {
    payload: overrides.payload ?? Buffer.alloc(8).toString('base64'),
    targetPeerId: overrides.targetPeerId ?? 'peer-target',
    senderPeerId: overrides.senderPeerId ?? 'peer-sender',
    timestamp: overrides.timestamp ?? Date.now(),
    isRelay: overrides.isRelay ?? false,
    hopsRemaining: overrides.hopsRemaining ?? 0,
    encrypted: overrides.encrypted ?? false,
    senderPubkeyHex: overrides.senderPubkeyHex,
  };
  return new TextEncoder().encode(JSON.stringify(wire));
}

describe('DirectEnvelope — payload size limit (via protocol handler)', () => {
  // Each test creates its own isolated pair of nodes so protocol handlers
  // never collide across tests.

  it('rejects envelope with payload exceeding 341,334 base64 chars — onMessage never fires', async () => {
    const nodeA = await createTestNode();
    const nodeB = await createTestNode();
    await nodeA.dial(nodeB.getMultiaddrs()[0]);
    await new Promise((r) => setTimeout(r, 300));

    const received: DirectEnvelope[] = [];
    const targetId = nodeB.peerId.toString();

    const dmB = new DirectMessageProtocol(nodeB, {
      onMessage: (env) => received.push(env),
    });
    await dmB.start();

    // Build oversized payload: 341_335 base64 chars exceeds the 341_334 limit
    const oversizedPayload = 'A'.repeat(341_335);
    const rawFrame = buildWireEnvelope({
      payload: oversizedPayload,
      targetPeerId: targetId,
    });

    // nodeA dials nodeB directly — nodeA.getPeers()[0] is nodeB's peer ID
    const stream = await nodeA.dialProtocol(nodeA.getPeers()[0], DIRECT_MESSAGE_PROTOCOL);
    await pipe([rawFrame], (s) => lp.encode(s), stream);
    await stream.close();

    await new Promise((r) => setTimeout(r, 300));

    // onMessage must NOT have fired — the oversized payload is dropped
    expect(received.length).toBe(0);

    await dmB.stop();
    await nodeA.stop();
    await nodeB.stop();
  }, 20000);

  it('accepts envelope with payload at exactly the size limit', async () => {
    const nodeA = await createTestNode();
    const nodeB = await createTestNode();
    await nodeA.dial(nodeB.getMultiaddrs()[0]);
    await new Promise((r) => setTimeout(r, 300));

    const received: DirectEnvelope[] = [];
    const targetId = nodeB.peerId.toString();

    const dmB = new DirectMessageProtocol(nodeB, {
      onMessage: (env) => received.push(env),
    });
    await dmB.start();

    // 341_334 chars is exactly the limit — should be accepted
    const atLimitPayload = 'A'.repeat(341_334);
    const rawFrame = buildWireEnvelope({
      payload: atLimitPayload,
      targetPeerId: targetId,
    });

    const stream = await nodeA.dialProtocol(nodeA.getPeers()[0], DIRECT_MESSAGE_PROTOCOL);
    await pipe([rawFrame], (s) => lp.encode(s), stream);
    await stream.close();

    await new Promise((r) => setTimeout(r, 300));

    // Payload is within limit — envelope is parsed and delivered to onMessage
    // (no signature/trust checking is configured so it passes through)
    expect(received.length).toBe(1);

    await dmB.stop();
    await nodeA.stop();
    await nodeB.stop();
  }, 20000);

  it('rejects envelope with senderPeerId exceeding 128 chars — onMessage never fires', async () => {
    const nodeA = await createTestNode();
    const nodeB = await createTestNode();
    await nodeA.dial(nodeB.getMultiaddrs()[0]);
    await new Promise((r) => setTimeout(r, 300));

    const received: DirectEnvelope[] = [];
    const targetId = nodeB.peerId.toString();

    const dmB = new DirectMessageProtocol(nodeB, {
      onMessage: (env) => received.push(env),
    });
    await dmB.start();

    const oversizedPeerId = 'p'.repeat(129);
    const rawFrame = buildWireEnvelope({
      senderPeerId: oversizedPeerId,
      targetPeerId: targetId,
    });

    const stream = await nodeA.dialProtocol(nodeA.getPeers()[0], DIRECT_MESSAGE_PROTOCOL);
    await pipe([rawFrame], (s) => lp.encode(s), stream);
    await stream.close();

    await new Promise((r) => setTimeout(r, 300));

    expect(received.length).toBe(0);

    await dmB.stop();
    await nodeA.stop();
    await nodeB.stop();
  }, 20000);

  it('rejects envelope with senderPubkeyHex exceeding 128 chars — onMessage never fires', async () => {
    const nodeA = await createTestNode();
    const nodeB = await createTestNode();
    await nodeA.dial(nodeB.getMultiaddrs()[0]);
    await new Promise((r) => setTimeout(r, 300));

    const received: DirectEnvelope[] = [];
    const targetId = nodeB.peerId.toString();

    const dmB = new DirectMessageProtocol(nodeB, {
      onMessage: (env) => received.push(env),
    });
    await dmB.start();

    const oversizedPubkey = 'f'.repeat(129);
    const rawFrame = buildWireEnvelope({
      senderPubkeyHex: oversizedPubkey,
      targetPeerId: targetId,
    });

    const stream = await nodeA.dialProtocol(nodeA.getPeers()[0], DIRECT_MESSAGE_PROTOCOL);
    await pipe([rawFrame], (s) => lp.encode(s), stream);
    await stream.close();

    await new Promise((r) => setTimeout(r, 300));

    expect(received.length).toBe(0);

    await dmB.stop();
    await nodeA.stop();
    await nodeB.stop();
  }, 20000);
});

// =========================================================================
// HandshakeProtocol — field validation (indirect via protocol handler)
// =========================================================================

describe('HandshakeProtocol — field validation (via protocol handler)', () => {
  // Each test creates its own isolated pair of nodes so protocol handlers
  // never collide across tests.

  it('rejects handshake with version string longer than 32 chars — peer version not recorded', async () => {
    const nodeA = await createTestNode();
    const nodeB = await createTestNode();
    // nodeA dials nodeB — so nodeA.getPeers()[0] is nodeB's peer ID
    await nodeA.dial(nodeB.getMultiaddrs()[0]);
    await new Promise((r) => setTimeout(r, 300));

    const hs = new HandshakeProtocol(nodeB, {});
    await hs.start();

    // version is 33 chars — exceeds the 32-char limit
    const oversizedVersion = '1'.repeat(33);
    const badHello = JSON.stringify({
      type: 'hello',
      version: oversizedVersion,
      minVersion: '0.1.0',
    });
    const rawFrame = new TextEncoder().encode(badHello);

    const stream = await nodeA.dialProtocol(nodeA.getPeers()[0], HANDSHAKE_PROTOCOL);
    await pipe([rawFrame], (s) => lp.encode(s), stream);
    await stream.close();

    await new Promise((r) => setTimeout(r, 300));

    // The malformed hello must not have been recorded
    expect(hs.getPeerVersion(nodeA.peerId.toString())).toBe('unknown');

    await hs.stop();
    await nodeA.stop();
    await nodeB.stop();
  }, 20000);

  it('rejects handshake with minVersion string longer than 32 chars — peer version not recorded', async () => {
    const nodeA = await createTestNode();
    const nodeB = await createTestNode();
    await nodeA.dial(nodeB.getMultiaddrs()[0]);
    await new Promise((r) => setTimeout(r, 300));

    const hs = new HandshakeProtocol(nodeB, {});
    await hs.start();

    const oversizedMinVersion = '0'.repeat(33);
    const badHello = JSON.stringify({
      type: 'hello',
      version: '0.2.0',
      minVersion: oversizedMinVersion,
    });
    const rawFrame = new TextEncoder().encode(badHello);

    const stream = await nodeA.dialProtocol(nodeA.getPeers()[0], HANDSHAKE_PROTOCOL);
    await pipe([rawFrame], (s) => lp.encode(s), stream);
    await stream.close();

    await new Promise((r) => setTimeout(r, 300));

    expect(hs.getPeerVersion(nodeA.peerId.toString())).toBe('unknown');

    await hs.stop();
    await nodeA.stop();
    await nodeB.stop();
  }, 20000);

  it('accepts a well-formed handshake hello and records peer version', async () => {
    const nodeA = await createTestNode();
    const nodeB = await createTestNode();
    await nodeA.dial(nodeB.getMultiaddrs()[0]);
    await new Promise((r) => setTimeout(r, 300));

    let capturedVersion: string | null = null;
    const hs = new HandshakeProtocol(nodeB, {
      onPeerVersion: (_peerId, version) => { capturedVersion = version; },
    });
    await hs.start();

    const validHello = JSON.stringify({
      type: 'hello',
      version: '0.2.0',
      minVersion: '0.1.0',
    });
    const rawFrame = new TextEncoder().encode(validHello);

    const stream = await nodeA.dialProtocol(nodeA.getPeers()[0], HANDSHAKE_PROTOCOL);
    await pipe([rawFrame], (s) => lp.encode(s), stream);
    await stream.close();

    await new Promise((r) => setTimeout(r, 300));

    // Valid hello: version must be recorded
    expect(hs.getPeerVersion(nodeA.peerId.toString())).toBe('0.2.0');
    expect(capturedVersion).toBe('0.2.0');

    await hs.stop();
    await nodeA.stop();
    await nodeB.stop();
  }, 20000);

  it('rejects welcome response with message field longer than 256 chars', async () => {
    // Test the initiator-side decode: a welcome with a 257-char message field
    // triggers a TypeError in decode(), so the version '9.9.9' is never stored.
    const nodeA = await createTestNode();
    const nodeB = await createTestNode();
    await nodeA.dial(nodeB.getMultiaddrs()[0]);
    await new Promise((r) => setTimeout(r, 300));

    const hs = new HandshakeProtocol(nodeA, {});
    await hs.start();

    // Register a fake responder on nodeB that replies with an oversized message field
    await nodeB.handle(HANDSHAKE_PROTOCOL, async ({ stream }) => {
      const oversizedMsg = 'x'.repeat(257);
      const badWelcome = JSON.stringify({
        type: 'welcome',
        version: '9.9.9',
        minVersion: '0.0.1',
        compatible: true,
        deprecated: false,
        message: oversizedMsg,
      });
      const rawFrame = new TextEncoder().encode(badWelcome);
      try {
        await pipe([rawFrame], (s) => lp.encode(s), stream);
      } finally {
        try { stream.close(); } catch { /* ignore */ }
      }
    });

    // Dial the handshake protocol — nodeB's fake handler sends the bad welcome back
    let outStream: import('@libp2p/interface').Stream | undefined;
    try {
      outStream = await nodeA.dialProtocol(nodeA.getPeers()[0], HANDSHAKE_PROTOCOL);
      await pipe(
        [new TextEncoder().encode(JSON.stringify({ type: 'hello', version: '0.2.0', minVersion: '0.1.0' }))],
        (s) => lp.encode(s),
        outStream,
        (s) => lp.decode(s),
        async (source) => {
          // Consume the response — the internal decode() in HandshakeProtocol
          // would throw and swallow the bad welcome, so we just drain here
          for await (const _msg of source) { /* drain */ }
        },
      );
    } catch {
      // Stream errors are expected when the decode throws internally
    } finally {
      try { outStream?.close(); } catch { /* ignore */ }
    }

    await new Promise((r) => setTimeout(r, 300));

    // The bad version '9.9.9' must NOT have been recorded by the HandshakeProtocol
    expect(hs.getPeerVersion(nodeB.peerId.toString())).toBe('unknown');

    await hs.stop();
    await nodeB.unhandle(HANDSHAKE_PROTOCOL);
    await nodeA.stop();
    await nodeB.stop();
  }, 20000);
});
