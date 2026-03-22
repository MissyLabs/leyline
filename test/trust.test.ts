import { describe, it, expect } from 'vitest';
import { TrustPolicy, SpamFilter } from '../src/trust/policy.js';

describe('TrustPolicy', () => {
  it('denies unknown agents by default', () => {
    const policy = new TrustPolicy();
    expect(policy.isAllowed('unknown-key', ['test'])).toBe(false);
  });

  it('allows explicitly whitelisted agents', () => {
    const policy = new TrustPolicy();
    policy.allowAgent('agent-a');
    expect(policy.isAllowed('agent-a', ['test'])).toBe(true);
  });

  it('block overrides allow', () => {
    const policy = new TrustPolicy();
    policy.allowAgent('agent-a');
    policy.blockAgent('agent-a');
    expect(policy.isAllowed('agent-a', ['test'])).toBe(false);
  });

  it('enforces per-tag trust', () => {
    const policy = new TrustPolicy();
    policy.allowAgent('agent-a');
    policy.allowTag('agent-a', 'skill:code');
    policy.blockTag('agent-a', 'skill:admin');

    expect(policy.isAllowed('agent-a', ['skill:code'])).toBe(true);
    expect(policy.isAllowed('agent-a', ['skill:admin'])).toBe(false);
  });

  it('requires all tags to be allowed when tag rules exist', () => {
    const policy = new TrustPolicy();
    policy.allowAgent('agent-a');
    policy.allowTag('agent-a', 'tag1');
    // tag2 is not allowed
    expect(policy.isAllowed('agent-a', ['tag1', 'tag2'])).toBe(false);
  });

  it('lists allowed and blocked agents', () => {
    const policy = new TrustPolicy();
    policy.allowAgent('a');
    policy.allowAgent('b');
    policy.blockAgent('c');
    expect(policy.getAllowedAgents().sort()).toEqual(['a', 'b']);
    expect(policy.getBlockedAgents()).toEqual(['c']);
  });
});

describe('SpamFilter', () => {
  it('detects duplicate messages', () => {
    const filter = new SpamFilter();
    expect(filter.isDuplicate('msg-1')).toBe(false);
    expect(filter.isDuplicate('msg-1')).toBe(true);
    expect(filter.isDuplicate('msg-2')).toBe(false);
  });

  it('tracks spam reports', () => {
    const filter = new SpamFilter();
    expect(filter.getSpamCount('bad-agent')).toBe(0);
    filter.reportSpam('bad-agent');
    filter.reportSpam('bad-agent');
    expect(filter.getSpamCount('bad-agent')).toBe(2);
  });

  it('rate limits excessive senders', () => {
    const filter = new SpamFilter();
    // Send 10 messages, limit is 5/min
    for (let i = 0; i < 5; i++) {
      expect(filter.isRateLimited('sender', 5)).toBe(false);
    }
    expect(filter.isRateLimited('sender', 5)).toBe(true);
  });

  it('evicts old entries when max size reached', () => {
    const filter = new SpamFilter(10);
    for (let i = 0; i < 10; i++) {
      filter.isDuplicate(`msg-${i}`);
    }
    // This should trigger eviction and still work
    expect(filter.isDuplicate('msg-new')).toBe(false);
    // Old entries (first 25% = first 3) should be evicted
    // msg-0, msg-1, msg-2 should be gone
    expect(filter.isDuplicate('msg-0')).toBe(false); // Not a dupe anymore
  });
});
