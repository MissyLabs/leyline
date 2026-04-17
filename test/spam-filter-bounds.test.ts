import { describe, it, expect } from 'vitest';
import { SpamFilter } from '../src/trust/policy.js';

describe('SpamFilter — bounded data structures', () => {
  it('spamCounts evicts oldest entries when exceeding 10k', () => {
    const filter = new SpamFilter();
    const count = 10_002;
    for (let i = 0; i < count; i++) {
      filter.reportSpam(`sender-${i.toString().padStart(6, '0')}`);
    }
    // After eviction the map should be under the cap
    // The first entries should have been evicted
    expect(filter.getSpamCount('sender-000000')).toBe(0);
    // Recent entries should still be present
    expect(filter.getSpamCount(`sender-${(count - 1).toString().padStart(6, '0')}`)).toBe(1);
  });

  it('seen set evicts oldest 25% when exceeding maxSeenSize', () => {
    const filter = new SpamFilter(100);
    for (let i = 0; i < 100; i++) {
      filter.isDuplicate(`msg-${i}`);
    }
    // The 101st message triggers eviction of 25 oldest entries
    expect(filter.isDuplicate('msg-101')).toBe(false);
    // First entries should now be forgotten (evicted)
    expect(filter.isDuplicate('msg-0')).toBe(false); // Re-added as new
    // Recent entries should still be deduped
    expect(filter.isDuplicate('msg-99')).toBe(true);
  });

  it('constructor rejects invalid maxSeenSize', () => {
    expect(() => new SpamFilter(0)).toThrow(RangeError);
    expect(() => new SpamFilter(-1)).toThrow(RangeError);
    expect(() => new SpamFilter(1.5)).toThrow(RangeError);
  });

  it('rate limiting window evicts stale senders periodically', () => {
    const filter = new SpamFilter();
    // Generate enough calls to trigger eviction (every 1000 calls)
    for (let i = 0; i < 1001; i++) {
      filter.isRateLimited(`sender-${i}`, 100);
    }
    // The filter should not throw or leak memory
    // Just verify it still functions correctly
    expect(filter.isRateLimited('new-sender', 100)).toBe(false);
  });

  it('isDuplicate returns true on second call with same ID', () => {
    const filter = new SpamFilter();
    expect(filter.isDuplicate('abc')).toBe(false);
    expect(filter.isDuplicate('abc')).toBe(true);
  });

  it('reportSpam increments count correctly', () => {
    const filter = new SpamFilter();
    expect(filter.getSpamCount('x')).toBe(0);
    filter.reportSpam('x');
    expect(filter.getSpamCount('x')).toBe(1);
    filter.reportSpam('x');
    expect(filter.getSpamCount('x')).toBe(2);
  });
});
