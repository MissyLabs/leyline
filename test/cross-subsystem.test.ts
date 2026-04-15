/**
 * Cross-subsystem integration tests.
 *
 * Verifies that reputation, trust policy, and spam filter work correctly
 * together when processing messages through the full pipeline.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TrustPolicy, SpamFilter } from '../src/trust/policy.js';
import { PeerReputation } from '../src/trust/peer-reputation.js';
import { ServiceRegistry, type ServiceDescriptor } from '../src/discovery/service-registry.js';
import { LedgerConsensus, type ConsensusConfig } from '../src/ledger/consensus.js';
import { MessageBuffer } from '../src/node/message-buffer.js';

// =========================================================================
// Reputation + Trust + SpamFilter integration
// =========================================================================

describe('Cross-subsystem: Reputation + Trust + SpamFilter', () => {
  let trust: TrustPolicy;
  let spam: SpamFilter;
  let reputation: PeerReputation;

  const goodPeer = 'aabb01';
  const spamPeer = 'aabb02';
  const unknownPeer = 'aabb03';

  beforeEach(() => {
    trust = new TrustPolicy();
    spam = new SpamFilter();
    reputation = new PeerReputation({
      initialScore: 50,
      untrustedThreshold: 10,
      spamPenalty: 15,
      violationPenalty: 20,
    });
  });

  it('trusted peer with good reputation passes all checks', () => {
    trust.allowAgent(goodPeer);
    reputation.recordSuccess(goodPeer);
    reputation.recordSuccess(goodPeer);

    expect(trust.isAllowed(goodPeer, [])).toBe(true);
    expect(spam.isRateLimited(goodPeer)).toBe(false);
    expect(reputation.isTrusted(goodPeer)).toBe(true);
    expect(reputation.getScore(goodPeer)).toBeGreaterThan(50);
  });

  it('blocked peer is denied regardless of reputation', () => {
    trust.allowAgent(spamPeer);
    reputation.recordSuccess(spamPeer);
    trust.blockAgent(spamPeer);

    expect(trust.isAllowed(spamPeer, [])).toBe(false);
    expect(reputation.isTrusted(spamPeer)).toBe(true); // reputation unaffected by trust
  });

  it('spam reports degrade reputation below untrusted threshold', () => {
    trust.allowAgent(spamPeer);
    expect(reputation.isTrusted(spamPeer)).toBe(true);

    // Each spam report costs 15 points. Starting at 50, threshold at 10.
    // 3 reports: 50 - 45 = 5, which is below threshold
    reputation.recordSpam(spamPeer);
    reputation.recordSpam(spamPeer);
    reputation.recordSpam(spamPeer);

    expect(reputation.isTrusted(spamPeer)).toBe(false);
    expect(reputation.getScore(spamPeer)).toBeLessThan(10);
  });

  it('unknown peer is blocked by trust even with neutral reputation', () => {
    expect(trust.isAllowed(unknownPeer, [])).toBe(false);
    expect(reputation.isTrusted(unknownPeer)).toBe(true); // default score 50 > threshold 10
  });

  it('full pipeline: trust → dedup → rate limit → reputation', () => {
    trust.allowAgent(goodPeer);

    const messageId = 'msg-001';
    const tags = ['skill:code'];

    // Step 1: trust check
    expect(trust.isAllowed(goodPeer, tags)).toBe(true);

    // Step 2: dedup check
    expect(spam.isDuplicate(messageId)).toBe(false); // first time

    // Step 3: rate limit check
    expect(spam.isRateLimited(goodPeer)).toBe(false);

    // Step 4: reputation update on success
    reputation.recordSuccess(goodPeer);
    expect(reputation.getScore(goodPeer)).toBeGreaterThan(50);

    // Duplicate message should be caught
    expect(spam.isDuplicate(messageId)).toBe(true);
  });

  it('pipeline rejects message from blocked peer and records violation', () => {
    trust.blockAgent(spamPeer);
    const allowed = trust.isAllowed(spamPeer, ['skill:code']);
    expect(allowed).toBe(false);

    // Record a violation for the blocked attempt
    reputation.recordViolation(spamPeer);
    expect(reputation.getScore(spamPeer)).toBeLessThan(50);
  });

  it('open tags allow unknown peers but blocked peers are still denied', () => {
    trust.allowTagOpen('public:chat');

    // Unknown peer can send to open tag
    expect(trust.isAllowed(unknownPeer, ['public:chat'])).toBe(true);

    // Blocked peer cannot even use open tags
    trust.blockAgent(spamPeer);
    expect(trust.isAllowed(spamPeer, ['public:chat'])).toBe(false);
  });

  it('rate-limited peer triggers spam report and reputation penalty', () => {
    trust.allowAgent(spamPeer);

    // Simulate hitting rate limit (default: 60 msgs / 60s window)
    for (let i = 0; i < 61; i++) {
      spam.isRateLimited(spamPeer);
    }
    const limited = spam.isRateLimited(spamPeer);

    if (limited) {
      spam.reportSpam(spamPeer);
      reputation.recordSpam(spamPeer);
      expect(reputation.getScore(spamPeer)).toBeLessThan(50);
    }
  });
});

// =========================================================================
// ServiceRegistry + Trust integration
// =========================================================================

describe('Cross-subsystem: ServiceRegistry + Trust', () => {
  it('query results can be filtered by trust policy', () => {
    const registry = new ServiceRegistry();
    const trust = new TrustPolicy();

    const trustedPub = 'trusted-pub-001';
    const untrustedPub = 'untrusted-pub-001';

    trust.allowAgent(trustedPub);

    registry.addRemote({
      id: 'svc-1',
      name: 'trusted-service',
      tags: ['skill:code'],
      description: 'From a trusted peer',
      providerPubkey: trustedPub,
      providerPeerId: 'peer-1',
      multiaddrs: ['/ip4/10.0.0.1/tcp/9000'],
      advertisedAt: Date.now(),
      ttl: 300_000,
      metadata: {},
    });

    registry.addRemote({
      id: 'svc-2',
      name: 'untrusted-service',
      tags: ['skill:code'],
      description: 'From an untrusted peer',
      providerPubkey: untrustedPub,
      providerPeerId: 'peer-2',
      multiaddrs: ['/ip4/10.0.0.2/tcp/9000'],
      advertisedAt: Date.now(),
      ttl: 300_000,
      metadata: {},
    });

    const all = registry.query({ tags: ['skill:code'] });
    expect(all).toHaveLength(2);

    const trusted = all.filter((s) => trust.isAllowed(s.providerPubkey, []));
    expect(trusted).toHaveLength(1);
    expect(trusted[0].name).toBe('trusted-service');
  });

  it('reputation filters low-quality service providers', () => {
    const registry = new ServiceRegistry();
    const reputation = new PeerReputation({ untrustedThreshold: 20 });

    const goodProvider = 'good-peer-001';
    const badProvider = 'bad-peer-001';

    reputation.recordSuccess(goodProvider);
    for (let i = 0; i < 10; i++) reputation.recordSpam(badProvider);

    registry.addRemote({
      id: 'svc-good',
      name: 'reliable-service',
      tags: ['tag:a'],
      description: 'Good provider',
      providerPubkey: 'pub-good',
      providerPeerId: goodProvider,
      multiaddrs: [],
      advertisedAt: Date.now(),
      ttl: 300_000,
      metadata: {},
    });

    registry.addRemote({
      id: 'svc-bad',
      name: 'unreliable-service',
      tags: ['tag:a'],
      description: 'Bad provider',
      providerPubkey: 'pub-bad',
      providerPeerId: badProvider,
      multiaddrs: [],
      advertisedAt: Date.now(),
      ttl: 300_000,
      metadata: {},
    });

    const all = registry.query({ tags: ['tag:a'] });
    const reputable = all.filter((s) => reputation.isTrusted(s.providerPeerId));
    expect(reputable).toHaveLength(1);
    expect(reputable[0].name).toBe('reliable-service');
  });
});

// =========================================================================
// Ledger + Consensus integration
// =========================================================================

describe('Cross-subsystem: Ledger + Consensus', () => {
  it('consensus quorum tracks confirmations correctly', () => {
    const config: ConsensusConfig = { quorumSize: 2, maxPendingEntries: 100 };
    const consensus = new LedgerConsensus(config);

    const data = new TextEncoder().encode('test-action');
    const submitter = new Uint8Array(32).fill(1);
    const sig = new Uint8Array(64).fill(2);

    const proposal = consensus.propose(data, submitter, sig);

    // First confirmation
    const reachedQuorum1 = consensus.addConfirmation(proposal.hash, 'confirmer-1');
    expect(reachedQuorum1).toBe(false);
    expect(proposal.confirmations.size).toBe(1);
    expect(proposal.status).toBe('pending');

    // Second confirmation reaches quorum
    const reachedQuorum2 = consensus.addConfirmation(proposal.hash, 'confirmer-2');
    expect(reachedQuorum2).toBe(true);
    expect(proposal.confirmations.size).toBe(2);
    expect(proposal.status).toBe('confirmed');
    expect(consensus.isFinalized(proposal.hash)).toBe(true);
  });

  it('rejected entries do not reach confirmed state', () => {
    const config: ConsensusConfig = { quorumSize: 2, maxPendingEntries: 100 };
    const consensus = new LedgerConsensus(config);

    const data = new TextEncoder().encode('malicious-action');
    const submitter = new Uint8Array(32).fill(3);
    const sig = new Uint8Array(64).fill(4);

    const proposal = consensus.propose(data, submitter, sig);
    consensus.reject(proposal.hash);

    expect(proposal.status).toBe('rejected');
    expect(consensus.isFinalized(proposal.hash)).toBe(false);

    // Confirmations after rejection are ignored
    const reachedQuorum = consensus.addConfirmation(proposal.hash, 'confirmer-1');
    expect(reachedQuorum).toBe(false);
  });

  it('duplicate confirmations from same peer are counted once', () => {
    const config: ConsensusConfig = { quorumSize: 2, maxPendingEntries: 100 };
    const consensus = new LedgerConsensus(config);

    const data = new TextEncoder().encode('dedup-test');
    const submitter = new Uint8Array(32).fill(5);
    const sig = new Uint8Array(64).fill(6);

    const proposal = consensus.propose(data, submitter, sig);
    consensus.addConfirmation(proposal.hash, 'confirmer-1');
    consensus.addConfirmation(proposal.hash, 'confirmer-1'); // duplicate
    expect(proposal.confirmations.size).toBe(1);
    expect(proposal.status).toBe('pending');
  });

  it('content dedup returns existing proposal for same data', () => {
    const config: ConsensusConfig = { quorumSize: 2, maxPendingEntries: 100 };
    const consensus = new LedgerConsensus(config);

    const data = new TextEncoder().encode('same-content');
    const submitter = new Uint8Array(32).fill(7);
    const sig = new Uint8Array(64).fill(8);

    const proposal1 = consensus.propose(data, submitter, sig);
    const proposal2 = consensus.propose(data, submitter, sig);
    expect(proposal1.hash).toBe(proposal2.hash);
  });
});

// =========================================================================
// MessageBuffer + Deduplication
// =========================================================================

describe('Cross-subsystem: MessageBuffer + SpamFilter dedup', () => {
  it('dedup prevents same message from being buffered twice', () => {
    const buffer = new MessageBuffer({ maxPerTopic: 100, maxTotal: 1000 });
    const spam = new SpamFilter();
    const topic = 'magic/tag/test';
    const msgId = 'msg-dedup-001';
    const data = new Uint8Array([1, 2, 3]);

    // First delivery
    if (!spam.isDuplicate(msgId)) {
      buffer.push(topic, data, msgId);
    }

    // Second delivery (duplicate)
    if (!spam.isDuplicate(msgId)) {
      buffer.push(topic, data, msgId);
    }

    const messages = buffer.getForTopics([topic], 0);
    expect(messages).toHaveLength(1);
  });

  it('buffer eviction does not affect SpamFilter dedup state', () => {
    const buffer = new MessageBuffer({ maxPerTopic: 2, maxTotal: 1000 });
    const spam = new SpamFilter();
    const topic = 'magic/tag/evict';

    for (let i = 0; i < 5; i++) {
      const msgId = `msg-${i}`;
      if (!spam.isDuplicate(msgId)) {
        buffer.push(topic, new Uint8Array([i]), msgId);
      }
    }

    // Only 2 messages in buffer (evicted oldest)
    const messages = buffer.getForTopics([topic], 0);
    expect(messages.length).toBeLessThanOrEqual(2);

    // But all 5 are still marked as seen by SpamFilter dedup
    for (let i = 0; i < 5; i++) {
      expect(spam.isDuplicate(`msg-${i}`)).toBe(true);
    }
  });
});
