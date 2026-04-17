import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageBuffer } from '../src/node/message-buffer.js';

function makeData(size: number): Uint8Array {
  return new Uint8Array(size).fill(0x42);
}

describe('MessageBuffer — boundary conditions', () => {
  let buffer: MessageBuffer;

  afterEach(() => {
    buffer.stop();
  });

  it('rejects messages exceeding maxMessageBytes', () => {
    buffer = new MessageBuffer({ maxMessageBytes: 100 });
    expect(buffer.push('t1', makeData(101), 'id1')).toBe(false);
    expect(buffer.push('t1', makeData(100), 'id2')).toBe(true);
    expect(buffer.getCount()).toBe(1);
  });

  it('deduplicates messages with the same ID', () => {
    buffer = new MessageBuffer();
    expect(buffer.push('t1', makeData(10), 'dup')).toBe(true);
    expect(buffer.push('t1', makeData(10), 'dup')).toBe(false);
    expect(buffer.push('t2', makeData(10), 'dup')).toBe(false);
    expect(buffer.getCount()).toBe(1);
  });

  it('evicts oldest per-topic when maxPerTopic reached', () => {
    buffer = new MessageBuffer({ maxPerTopic: 3 });
    buffer.push('t1', makeData(1), 'a');
    buffer.push('t1', makeData(1), 'b');
    buffer.push('t1', makeData(1), 'c');
    buffer.push('t1', makeData(1), 'd');

    expect(buffer.getCount()).toBe(3);
    const msgs = buffer.getForTopics(['t1']);
    expect(msgs.map((m) => m.id)).toEqual(['b', 'c', 'd']);
  });

  it('evicts oldest globally when maxTotal reached', () => {
    buffer = new MessageBuffer({ maxTotal: 3, maxPerTopic: 10 });
    buffer.push('t1', makeData(1), 'a');
    buffer.push('t2', makeData(1), 'b');
    buffer.push('t3', makeData(1), 'c');
    buffer.push('t4', makeData(1), 'd');

    expect(buffer.getCount()).toBe(3);
    const all = buffer.getForTopics(['t1', 't2', 't3', 't4']);
    const ids = all.map((m) => m.id);
    expect(ids).not.toContain('a');
    expect(ids).toContain('d');
  });

  it('getForTopics filters by since timestamp', async () => {
    buffer = new MessageBuffer();
    buffer.push('t1', makeData(1), 'old');
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    buffer.push('t1', makeData(1), 'new');

    const msgs = buffer.getForTopics(['t1'], before);
    expect(msgs.length).toBe(1);
    expect(msgs[0].id).toBe('new');
  });

  it('getForTopics returns empty for unknown topics', () => {
    buffer = new MessageBuffer();
    expect(buffer.getForTopics(['nonexistent'])).toEqual([]);
  });

  it('getForTopics returns messages across topics sorted chronologically', async () => {
    buffer = new MessageBuffer();
    buffer.push('t1', makeData(1), 'first');
    await new Promise((r) => setTimeout(r, 10));
    buffer.push('t2', makeData(1), 'second');
    await new Promise((r) => setTimeout(r, 10));
    buffer.push('t1', makeData(1), 'third');

    const msgs = buffer.getForTopics(['t1', 't2']);
    expect(msgs.map((m) => m.id)).toEqual(['first', 'second', 'third']);
  });

  it('prune removes expired messages', async () => {
    buffer = new MessageBuffer({ ttlMs: 50 });
    buffer.push('t1', makeData(1), 'expire-me');
    await new Promise((r) => setTimeout(r, 100));
    buffer.push('t1', makeData(1), 'keep-me');

    const pruned = buffer.prune();
    expect(pruned).toBe(1);
    expect(buffer.getCount()).toBe(1);

    const msgs = buffer.getForTopics(['t1']);
    expect(msgs[0].id).toBe('keep-me');
  });

  it('prune cleans up empty topic entries', async () => {
    buffer = new MessageBuffer({ ttlMs: 50 });
    buffer.push('t1', makeData(1), 'a');
    await new Promise((r) => setTimeout(r, 100));

    buffer.prune();
    expect(buffer.getBufferedTopics()).toEqual([]);
  });

  it('getTopicCounts reports correct per-topic counts', () => {
    buffer = new MessageBuffer();
    buffer.push('t1', makeData(1), 'a');
    buffer.push('t1', makeData(1), 'b');
    buffer.push('t2', makeData(1), 'c');

    const counts = buffer.getTopicCounts();
    expect(counts.get('t1')).toBe(2);
    expect(counts.get('t2')).toBe(1);
  });

  it('evicted per-topic IDs can be reused', () => {
    buffer = new MessageBuffer({ maxPerTopic: 1 });
    buffer.push('t1', makeData(1), 'reuse-me');
    buffer.push('t1', makeData(1), 'push-out');

    expect(buffer.push('t1', makeData(1), 'reuse-me')).toBe(true);
  });

  it('handles zero-length data', () => {
    buffer = new MessageBuffer();
    expect(buffer.push('t1', new Uint8Array(0), 'empty')).toBe(true);
    const msgs = buffer.getForTopics(['t1']);
    expect(msgs[0].data.length).toBe(0);
  });

  it('global eviction prefers oldest across topics', () => {
    buffer = new MessageBuffer({ maxTotal: 2, maxPerTopic: 10 });
    buffer.push('t1', makeData(1), 'oldest');
    buffer.push('t2', makeData(1), 'newer');
    buffer.push('t3', makeData(1), 'newest');

    const all = buffer.getForTopics(['t1', 't2', 't3']);
    expect(all.length).toBe(2);
    expect(all.map((m) => m.id)).toEqual(['newer', 'newest']);
  });
});
