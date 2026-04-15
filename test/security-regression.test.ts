import { describe, it, expect, beforeAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
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
