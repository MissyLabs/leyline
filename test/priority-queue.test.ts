import { describe, it, expect } from 'vitest';
import { PriorityQueue, MessagePriority } from '../src/utils/priority-queue.js';

describe('PriorityQueue', () => {
  it('pops items in priority order (lower number first)', () => {
    const pq = new PriorityQueue<string>(10);
    pq.push('low', MessagePriority.LOW);
    pq.push('critical', MessagePriority.CRITICAL);
    pq.push('normal', MessagePriority.NORMAL);
    pq.push('high', MessagePriority.HIGH);

    expect(pq.pop()).toBe('critical');
    expect(pq.pop()).toBe('high');
    expect(pq.pop()).toBe('normal');
    expect(pq.pop()).toBe('low');
  });

  it('preserves FIFO order within same priority', () => {
    const pq = new PriorityQueue<number>(10);
    pq.push(1, MessagePriority.NORMAL);
    pq.push(2, MessagePriority.NORMAL);
    pq.push(3, MessagePriority.NORMAL);

    expect(pq.pop()).toBe(1);
    expect(pq.pop()).toBe(2);
    expect(pq.pop()).toBe(3);
  });

  it('returns undefined when empty', () => {
    const pq = new PriorityQueue<string>(5);
    expect(pq.pop()).toBeUndefined();
    expect(pq.peek()).toBeUndefined();
  });

  it('reports correct length', () => {
    const pq = new PriorityQueue<number>(10);
    expect(pq.length).toBe(0);
    pq.push(1, 0);
    pq.push(2, 1);
    expect(pq.length).toBe(2);
    pq.pop();
    expect(pq.length).toBe(1);
  });

  it('respects capacity — drops lowest priority when full', () => {
    const pq = new PriorityQueue<string>(3);
    pq.push('a', MessagePriority.HIGH);
    pq.push('b', MessagePriority.NORMAL);
    pq.push('c', MessagePriority.LOW);
    expect(pq.length).toBe(3);

    // Push critical — should evict LOW
    const accepted = pq.push('d', MessagePriority.CRITICAL);
    expect(accepted).toBe(true);
    expect(pq.length).toBe(3);

    const items: string[] = [];
    while (pq.length > 0) items.push(pq.pop()!);
    expect(items).toEqual(['d', 'a', 'b']);
  });

  it('rejects when full and new item is lowest priority', () => {
    const pq = new PriorityQueue<string>(2);
    pq.push('a', MessagePriority.NORMAL);
    pq.push('b', MessagePriority.NORMAL);

    const accepted = pq.push('c', MessagePriority.LOW);
    expect(accepted).toBe(false);
    expect(pq.length).toBe(2);
  });

  it('rejects when full and new item ties with worst', () => {
    const pq = new PriorityQueue<string>(2);
    pq.push('a', MessagePriority.NORMAL);
    pq.push('b', MessagePriority.NORMAL);

    const accepted = pq.push('c', MessagePriority.NORMAL);
    expect(accepted).toBe(false);
    expect(pq.length).toBe(2);
  });

  it('peek returns highest priority without removing', () => {
    const pq = new PriorityQueue<string>(10);
    pq.push('low', MessagePriority.LOW);
    pq.push('high', MessagePriority.HIGH);
    expect(pq.peek()).toBe('high');
    expect(pq.length).toBe(2);
  });

  it('clear empties the queue', () => {
    const pq = new PriorityQueue<number>(10);
    pq.push(1, 0);
    pq.push(2, 1);
    pq.push(3, 2);
    pq.clear();
    expect(pq.length).toBe(0);
    expect(pq.pop()).toBeUndefined();
  });

  it('handles single-element capacity', () => {
    const pq = new PriorityQueue<string>(1);
    pq.push('a', MessagePriority.LOW);
    expect(pq.length).toBe(1);

    const accepted = pq.push('b', MessagePriority.CRITICAL);
    expect(accepted).toBe(true);
    expect(pq.pop()).toBe('b');
    expect(pq.length).toBe(0);
  });

  it('handles large number of insertions correctly', () => {
    const pq = new PriorityQueue<number>(100);
    for (let i = 0; i < 100; i++) {
      pq.push(i, i % 4);
    }
    expect(pq.length).toBe(100);

    let lastPriority = -1;
    while (pq.length > 0) {
      const val = pq.pop()!;
      const priority = val % 4;
      expect(priority).toBeGreaterThanOrEqual(lastPriority);
      if (priority > lastPriority) lastPriority = priority;
    }
  });

  it('mixed push/pop maintains heap invariant', () => {
    const pq = new PriorityQueue<string>(10);
    pq.push('c', 2);
    pq.push('a', 0);
    expect(pq.pop()).toBe('a');
    pq.push('b', 1);
    pq.push('d', 3);
    expect(pq.pop()).toBe('b');
    expect(pq.pop()).toBe('c');
    expect(pq.pop()).toBe('d');
  });

  it('capacity eviction keeps the best items', () => {
    const pq = new PriorityQueue<number>(5);
    for (let i = 10; i >= 0; i--) {
      pq.push(i, i);
    }
    expect(pq.length).toBe(5);
    const items: number[] = [];
    while (pq.length > 0) items.push(pq.pop()!);
    expect(items).toEqual([0, 1, 2, 3, 4]);
  });
});
