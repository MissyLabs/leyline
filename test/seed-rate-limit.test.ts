import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('SeedNode — ledger rate limit logic', () => {
  const RATE_LIMIT = 10;
  const RATE_WINDOW_MS = 60_000;
  const MAX_ENTRIES = 5_000;

  let timestamps: Map<string, number[]>;
  let callCount: number;

  function checkLedgerRateLimit(submitterHex: string): boolean {
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    let ts = timestamps.get(submitterHex);
    if (!ts) {
      ts = [];
      timestamps.set(submitterHex, ts);
    }
    const firstValid = ts.findIndex(t => t > cutoff);
    if (firstValid > 0) ts.splice(0, firstValid);
    else if (firstValid === -1) ts.length = 0;

    if (ts.length >= RATE_LIMIT) return false;
    ts.push(now);

    callCount++;
    if (callCount >= 500) {
      callCount = 0;
      for (const [key, arr] of timestamps) {
        if (arr.length === 0 || arr[arr.length - 1]! <= cutoff) {
          timestamps.delete(key);
        }
      }
      if (timestamps.size > MAX_ENTRIES) {
        const excess = timestamps.size - MAX_ENTRIES;
        let removed = 0;
        for (const key of timestamps.keys()) {
          if (removed >= excess) break;
          timestamps.delete(key);
          removed++;
        }
      }
    }

    return true;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    timestamps = new Map();
    callCount = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows submissions up to the rate limit', () => {
    for (let i = 0; i < RATE_LIMIT; i++) {
      expect(checkLedgerRateLimit('alice')).toBe(true);
    }
  });

  it('blocks submissions beyond the rate limit', () => {
    for (let i = 0; i < RATE_LIMIT; i++) {
      checkLedgerRateLimit('alice');
    }
    expect(checkLedgerRateLimit('alice')).toBe(false);
  });

  it('rate limit resets after window expires', () => {
    for (let i = 0; i < RATE_LIMIT; i++) {
      checkLedgerRateLimit('alice');
    }
    expect(checkLedgerRateLimit('alice')).toBe(false);

    vi.advanceTimersByTime(RATE_WINDOW_MS + 1);
    expect(checkLedgerRateLimit('alice')).toBe(true);
  });

  it('tracks rate limits per submitter independently', () => {
    for (let i = 0; i < RATE_LIMIT; i++) {
      checkLedgerRateLimit('alice');
    }
    expect(checkLedgerRateLimit('alice')).toBe(false);
    expect(checkLedgerRateLimit('bob')).toBe(true);
  });

  it('sliding window allows partial recovery', () => {
    for (let i = 0; i < RATE_LIMIT; i++) {
      checkLedgerRateLimit('alice');
      vi.advanceTimersByTime(1000);
    }
    expect(checkLedgerRateLimit('alice')).toBe(false);

    vi.advanceTimersByTime(RATE_WINDOW_MS - RATE_LIMIT * 1000 + 1);
    expect(checkLedgerRateLimit('alice')).toBe(true);
  });

  it('evicts stale entries after 500 calls', () => {
    checkLedgerRateLimit('stale-submitter');
    vi.advanceTimersByTime(RATE_WINDOW_MS + 1);

    // Fill up to just before the 500-call eviction threshold
    // callCount is currently 1 (from stale-submitter), so need 498 more
    for (let i = 0; i < 498; i++) {
      checkLedgerRateLimit(`filler-${i}`);
    }
    expect(timestamps.has('stale-submitter')).toBe(true);

    // This is call 500, which triggers eviction
    checkLedgerRateLimit('trigger-eviction');
    expect(timestamps.has('stale-submitter')).toBe(false);
  });

  it('caps total tracked submitters at MAX_ENTRIES', () => {
    for (let i = 0; i < MAX_ENTRIES + 100; i++) {
      checkLedgerRateLimit(`submitter-${i}`);
      if (callCount === 0) {
        // Eviction just ran
      }
    }
    // After eviction cycles, should be bounded
    // Force an eviction
    callCount = 499;
    checkLedgerRateLimit('final');
    expect(timestamps.size).toBeLessThanOrEqual(MAX_ENTRIES);
  });

  it('handles empty timestamp arrays during eviction', () => {
    timestamps.set('empty', []);
    callCount = 499;
    checkLedgerRateLimit('trigger');
    expect(timestamps.has('empty')).toBe(false);
  });

  it('handles rapid submissions within same millisecond', () => {
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      if (checkLedgerRateLimit('rapid')) allowed++;
    }
    expect(allowed).toBe(RATE_LIMIT);
  });
});
