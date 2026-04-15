import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageBuffer } from '../src/node/message-buffer.js';

describe('MessageBuffer — getForTopics limit parameter', () => {
  let buffer: MessageBuffer;

  afterEach(() => {
    buffer.stop();
  });

  it('returns all messages when limit is not specified', () => {
    buffer = new MessageBuffer();
    for (let i = 0; i < 10; i++) {
      buffer.push('topic1', new Uint8Array([i]), `msg-${i}`);
    }
    const result = buffer.getForTopics(['topic1']);
    expect(result.length).toBe(10);
  });

  it('caps results when limit is specified', () => {
    buffer = new MessageBuffer();
    for (let i = 0; i < 10; i++) {
      buffer.push('topic1', new Uint8Array([i]), `msg-${i}`);
    }
    const result = buffer.getForTopics(['topic1'], 0, 5);
    expect(result.length).toBe(5);
  });

  it('returns all when limit exceeds available messages', () => {
    buffer = new MessageBuffer();
    for (let i = 0; i < 3; i++) {
      buffer.push('topic1', new Uint8Array([i]), `msg-${i}`);
    }
    const result = buffer.getForTopics(['topic1'], 0, 100);
    expect(result.length).toBe(3);
  });

  it('limit of 0 returns all messages', () => {
    buffer = new MessageBuffer();
    for (let i = 0; i < 5; i++) {
      buffer.push('topic1', new Uint8Array([i]), `msg-${i}`);
    }
    const result = buffer.getForTopics(['topic1'], 0, 0);
    expect(result.length).toBe(5);
  });

  it('negative limit returns all messages', () => {
    buffer = new MessageBuffer();
    for (let i = 0; i < 5; i++) {
      buffer.push('topic1', new Uint8Array([i]), `msg-${i}`);
    }
    const result = buffer.getForTopics(['topic1'], 0, -1);
    expect(result.length).toBe(5);
  });

  it('limit works across multiple topics', () => {
    buffer = new MessageBuffer();
    for (let i = 0; i < 5; i++) {
      buffer.push('topic1', new Uint8Array([i]), `t1-${i}`);
      buffer.push('topic2', new Uint8Array([i + 10]), `t2-${i}`);
    }
    const result = buffer.getForTopics(['topic1', 'topic2'], 0, 3);
    expect(result.length).toBe(3);
  });

  it('limited results are sorted chronologically', () => {
    buffer = new MessageBuffer();
    for (let i = 0; i < 10; i++) {
      buffer.push('topic1', new Uint8Array([i]), `msg-${i}`);
    }
    const result = buffer.getForTopics(['topic1'], 0, 5);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].receivedAt).toBeGreaterThanOrEqual(result[i - 1].receivedAt);
    }
  });

  it('limit of 1 returns single oldest message', () => {
    buffer = new MessageBuffer();
    buffer.push('topic1', new Uint8Array([1]), 'first');
    buffer.push('topic1', new Uint8Array([2]), 'second');
    buffer.push('topic1', new Uint8Array([3]), 'third');
    const result = buffer.getForTopics(['topic1'], 0, 1);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('first');
  });

  it('since filter applies before limit', () => {
    buffer = new MessageBuffer();
    const now = Date.now();
    buffer.push('topic1', new Uint8Array([1]), 'old');
    const result = buffer.getForTopics(['topic1'], now + 10000, 10);
    expect(result.length).toBe(0);
  });
});

describe('MessageBuffer — empty and missing topic handling', () => {
  let buffer: MessageBuffer;

  afterEach(() => {
    buffer.stop();
  });

  it('returns empty array for non-existent topics', () => {
    buffer = new MessageBuffer();
    const result = buffer.getForTopics(['nonexistent']);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty topic list', () => {
    buffer = new MessageBuffer();
    buffer.push('topic1', new Uint8Array([1]), 'msg1');
    const result = buffer.getForTopics([]);
    expect(result).toEqual([]);
  });

  it('handles mix of existing and non-existent topics', () => {
    buffer = new MessageBuffer();
    buffer.push('topic1', new Uint8Array([1]), 'msg1');
    const result = buffer.getForTopics(['topic1', 'nonexistent', 'also-missing']);
    expect(result.length).toBe(1);
  });
});
