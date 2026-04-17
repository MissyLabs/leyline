import { describe, it, expect } from 'vitest';
import { withTimeout, STREAM_TIMEOUT_MS, StreamAbortedError } from '../src/utils/stream-timeout.js';

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

  it('terminates immediately when AbortSignal is already aborted', async () => {
    async function* source() {
      yield 1;
      yield 2;
    }

    const controller = new AbortController();
    controller.abort();

    const results: number[] = [];
    for await (const item of withTimeout(source(), 5000, controller.signal)) {
      results.push(item);
    }
    expect(results).toEqual([]);
  });

  it('terminates mid-stream when AbortSignal fires', async () => {
    const controller = new AbortController();

    async function* slowSource() {
      yield 'first';
      await new Promise((r) => setTimeout(r, 500));
      yield 'should-not-arrive';
    }

    const results: string[] = [];
    try {
      for await (const item of withTimeout(slowSource(), 30_000, controller.signal)) {
        results.push(item);
        // Abort after receiving first item
        controller.abort();
      }
    } catch (err) {
      expect(err).toBeInstanceOf(StreamAbortedError);
    }
    expect(results).toEqual(['first']);
  });

  it('cleans up source iterator when AbortSignal fires', async () => {
    let cleaned = false;
    const controller = new AbortController();

    async function* tracked() {
      try {
        yield 1;
        await new Promise((r) => setTimeout(r, 500));
        yield 2;
      } finally {
        cleaned = true;
      }
    }

    try {
      for await (const item of withTimeout(tracked(), 30_000, controller.signal)) {
        if (item === 1) controller.abort();
      }
    } catch {
      // StreamAbortedError expected
    }

    expect(cleaned).toBe(true);
  });

  it('StreamAbortedError has correct name and message', () => {
    const err = new StreamAbortedError();
    expect(err.name).toBe('StreamAbortedError');
    expect(err.message).toBe('Stream aborted via AbortSignal');
    expect(err).toBeInstanceOf(Error);
  });

  it('works normally when signal is provided but never aborted', async () => {
    const controller = new AbortController();

    async function* source() {
      yield 'a';
      yield 'b';
    }

    const results: string[] = [];
    for await (const item of withTimeout(source(), 5000, controller.signal)) {
      results.push(item);
    }
    expect(results).toEqual(['a', 'b']);
  });
});
