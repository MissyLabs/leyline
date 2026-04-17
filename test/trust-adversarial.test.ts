/**
 * Adversarial tests for trust policy enforcement.
 * Verifies deny-first policy, open tag semantics, and block overrides.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TrustPolicy, SpamFilter } from '../src/trust/policy.js';

const enc = new TextEncoder();

describe('TrustPolicy — adversarial scenarios', () => {
  let trust: TrustPolicy;

  beforeEach(() => {
    trust = new TrustPolicy();
  });

  it('denies unknown senders by default (deny-first)', () => {
    expect(trust.isAllowed('unknown-peer', ['skill:code'])).toBe(false);
  });

  it('block overrides allow at all levels', () => {
    const peer = 'blocked-peer';
    trust.allowAgent(peer);
    trust.blockAgent(peer);
    expect(trust.isAllowed(peer, ['skill:code'])).toBe(false);
  });

  it('allowTag only permits the specific tag for that peer', () => {
    const peer = 'tag-peer';
    trust.allowAgent(peer);
    trust.allowTag(peer, 'skill:code');
    expect(trust.isAllowed(peer, ['skill:code'])).toBe(true);
    // Different peer not allowed
    expect(trust.isAllowed('other-peer', ['skill:code'])).toBe(false);
  });

  it('open tag requires ALL message tags to be open', () => {
    trust.allowTagOpen('public');
    // Single open tag — allowed
    expect(trust.isAllowed('anyone', ['public'])).toBe(true);
    // Mixed tags — one open, one not — should be denied
    expect(trust.isAllowed('anyone', ['public', 'secret'])).toBe(false);
  });

  it('blocked agent cannot use open tags', () => {
    trust.allowTagOpen('public');
    trust.blockAgent('bad-actor');
    expect(trust.isAllowed('bad-actor', ['public'])).toBe(false);
  });

  it('agent allowed for any tag after allowAgent', () => {
    trust.allowAgent('trusted');
    expect(trust.isAllowed('trusted', ['anything'])).toBe(true);
    expect(trust.isAllowed('trusted', ['anything', 'else'])).toBe(true);
  });

  it('empty tags array is denied for unknown peer', () => {
    expect(trust.isAllowed('peer', [])).toBe(false);
  });

  it('allowTag + blockAgent: block wins', () => {
    trust.allowAgent('enemy');
    trust.allowTag('enemy', 'skill:code');
    trust.blockAgent('enemy');
    expect(trust.isAllowed('enemy', ['skill:code'])).toBe(false);
  });
});

describe('SpamFilter — adversarial scenarios', () => {
  let filter: SpamFilter;

  beforeEach(() => {
    filter = new SpamFilter();
  });

  it('deduplicates messages by ID', () => {
    const id = enc.encode('msg-1'.padEnd(32, '0'));
    expect(filter.isDuplicate(id)).toBe(false);
    expect(filter.isDuplicate(id)).toBe(true);
  });

  it('rate limits a single sender after exceeding maxPerMinute', () => {
    const sender = 'aabbccdd'.repeat(8); // 64-char hex pubkey
    const maxPerMinute = 10;
    for (let i = 0; i < maxPerMinute + 1; i++) {
      filter.isRateLimited(sender, maxPerMinute);
    }
    expect(filter.isRateLimited(sender, maxPerMinute)).toBe(true);
  });

  it('different senders have independent rate limits', () => {
    const sender1 = 'aa'.repeat(32);
    const sender2 = 'bb'.repeat(32);
    const maxPerMinute = 5;

    // Exhaust sender1's limit
    for (let i = 0; i < maxPerMinute + 1; i++) {
      filter.isRateLimited(sender1, maxPerMinute);
    }
    expect(filter.isRateLimited(sender1, maxPerMinute)).toBe(true);

    // sender2 should not be rate-limited yet
    expect(filter.isRateLimited(sender2, maxPerMinute)).toBe(false);
  });
});
