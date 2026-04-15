import { describe, it, expect } from 'vitest';
import { withTimeout, STREAM_TIMEOUT_MS } from '../src/utils/stream-timeout.js';

describe('withTimeout', () => {
  it('passes through messages that arrive within the timeout', async () => {
    async function* source() {
      yield 1;
      yield 2;
      yield 3;
    }

    const results: number[] = [];
    for await (const item of withTimeout(source(), 5000)) {
      results.push(item);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  it('terminates when a message takes longer than the timeout', async () => {
    async function* slowSource() {
      yield 'fast';
      await new Promise((r) => setTimeout(r, 200));
      yield 'should-not-arrive';
    }

    const results: string[] = [];
    for await (const item of withTimeout(slowSource(), 50)) {
      results.push(item);
    }
    expect(results).toEqual(['fast']);
  });

  it('handles empty source gracefully', async () => {
    async function* empty() {
      // yields nothing
    }

    const results: unknown[] = [];
    for await (const item of withTimeout(empty(), 100)) {
      results.push(item);
    }
    expect(results).toEqual([]);
  });

  it('cleans up the source iterator on timeout', async () => {
    let cleaned = false;

    async function* tracked() {
      try {
        yield 1;
        await new Promise((r) => setTimeout(r, 500));
        yield 2;
      } finally {
        cleaned = true;
      }
    }

    const results: number[] = [];
    for await (const item of withTimeout(tracked(), 50)) {
      results.push(item);
    }

    expect(results).toEqual([1]);
    expect(cleaned).toBe(true);
  });

  it('exports STREAM_TIMEOUT_MS as 30 seconds', () => {
    expect(STREAM_TIMEOUT_MS).toBe(30_000);
  });
});
