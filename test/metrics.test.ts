import { describe, it, expect } from 'vitest';
import { NodeMetrics, type MetricEvent } from '../src/utils/metrics.js';

describe('NodeMetrics', () => {
  it('starts with all counters at zero', () => {
    const m = new NodeMetrics();
    expect(m.get('messages.received')).toBe(0);
    expect(m.get('nonexistent')).toBe(0);
  });

  it('increments counters', () => {
    const m = new NodeMetrics();
    m.increment('messages.received');
    m.increment('messages.received');
    m.increment('messages.received', 3);
    expect(m.get('messages.received')).toBe(5);
  });

  it('emits metric events on increment', () => {
    const m = new NodeMetrics();
    const events: MetricEvent[] = [];
    m.on('metric', (e: MetricEvent) => events.push(e));

    m.increment('test.counter', 1, { reason: 'testing' });

    expect(events.length).toBe(1);
    expect(events[0].name).toBe('test.counter');
    expect(events[0].value).toBe(1);
    expect(events[0].tags).toEqual({ reason: 'testing' });
    expect(events[0].timestamp).toBeGreaterThan(0);
  });

  it('produces a snapshot with all fields', () => {
    const m = new NodeMetrics();
    m.increment('messages.received', 10);
    m.increment('messages.blocked', 3);
    m.increment('messages.sent', 5);
    m.increment('peers.connected', 2);
    m.increment('trust.denied', 1);
    m.increment('ratelimit.hit', 1);
    m.increment('signature.failed', 1);

    const snap = m.snapshot();
    expect(snap.messagesReceived).toBe(10);
    expect(snap.messagesBlocked).toBe(3);
    expect(snap.messagesSent).toBe(5);
    expect(snap.peerConnections).toBe(2);
    expect(snap.trustDenials).toBe(1);
    expect(snap.rateLimitHits).toBe(1);
    expect(snap.signatureFailures).toBe(1);
    expect(snap.uptime).toBeGreaterThanOrEqual(0);
  });

  it('resets all counters', () => {
    const m = new NodeMetrics();
    m.increment('messages.received', 100);
    m.increment('messages.sent', 50);
    m.reset();
    expect(m.get('messages.received')).toBe(0);
    expect(m.get('messages.sent')).toBe(0);
  });

  it('snapshot uptime increases over time', async () => {
    const m = new NodeMetrics();
    const snap1 = m.snapshot();
    await new Promise((r) => setTimeout(r, 50));
    const snap2 = m.snapshot();
    expect(snap2.uptime).toBeGreaterThan(snap1.uptime);
  });

  it('handles multiple listeners', () => {
    const m = new NodeMetrics();
    let count1 = 0;
    let count2 = 0;
    m.on('metric', () => count1++);
    m.on('metric', () => count2++);
    m.increment('test', 1);
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  it('tracks independent counters separately', () => {
    const m = new NodeMetrics();
    m.increment('a', 10);
    m.increment('b', 20);
    m.increment('c', 30);
    expect(m.get('a')).toBe(10);
    expect(m.get('b')).toBe(20);
    expect(m.get('c')).toBe(30);
  });
});
