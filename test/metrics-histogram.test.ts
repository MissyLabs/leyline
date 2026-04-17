import { describe, it, expect } from 'vitest';
import { NodeMetrics } from '../src/utils/metrics.js';

describe('NodeMetrics — gauges', () => {
  it('sets and reads gauge values', () => {
    const m = new NodeMetrics();
    m.gauge('peers.current', 5);
    expect(m.getGauge('peers.current')).toBe(5);
    m.gauge('peers.current', 3);
    expect(m.getGauge('peers.current')).toBe(3);
  });

  it('returns 0 for unset gauge', () => {
    const m = new NodeMetrics();
    expect(m.getGauge('nonexistent')).toBe(0);
  });

  it('gauges appear in snapshot', () => {
    const m = new NodeMetrics();
    m.gauge('peers.current', 7);
    m.gauge('buffer.size', 42);
    const snap = m.snapshot();
    expect(snap.gauges['peers.current']).toBe(7);
    expect(snap.gauges['buffer.size']).toBe(42);
  });

  it('reset clears gauges', () => {
    const m = new NodeMetrics();
    m.gauge('test', 100);
    m.reset();
    expect(m.getGauge('test')).toBe(0);
  });
});

describe('NodeMetrics — histograms', () => {
  it('observe tracks values and computes stats', () => {
    const m = new NodeMetrics();
    for (let i = 1; i <= 100; i++) {
      m.observe('latency.ms', i);
    }
    const stats = m.histogram('latency.ms');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(100);
    expect(stats!.min).toBe(1);
    expect(stats!.max).toBe(100);
    expect(stats!.mean).toBe(50.5);
    expect(stats!.p50).toBe(51);
    expect(stats!.p95).toBe(96);
    expect(stats!.p99).toBe(100);
  });

  it('returns null for unobserved histogram', () => {
    const m = new NodeMetrics();
    expect(m.histogram('nonexistent')).toBeNull();
  });

  it('single observation returns correct stats', () => {
    const m = new NodeMetrics();
    m.observe('single', 42);
    const stats = m.histogram('single');
    expect(stats!.count).toBe(1);
    expect(stats!.min).toBe(42);
    expect(stats!.max).toBe(42);
    expect(stats!.mean).toBe(42);
    expect(stats!.p50).toBe(42);
    expect(stats!.p95).toBe(42);
    expect(stats!.p99).toBe(42);
  });

  it('caps samples at 1000', () => {
    const m = new NodeMetrics();
    for (let i = 0; i < 1500; i++) {
      m.observe('capped', i);
    }
    const stats = m.histogram('capped');
    expect(stats!.count).toBe(1000);
    expect(stats!.min).toBe(500);
    expect(stats!.max).toBe(1499);
  });

  it('histograms appear in snapshot', () => {
    const m = new NodeMetrics();
    m.observe('dial.ms', 10);
    m.observe('dial.ms', 20);
    m.observe('dial.ms', 30);
    const snap = m.snapshot();
    expect(snap.histograms['dial.ms']).toBeDefined();
    expect(snap.histograms['dial.ms'].count).toBe(3);
    expect(snap.histograms['dial.ms'].mean).toBe(20);
  });

  it('reset clears histograms', () => {
    const m = new NodeMetrics();
    m.observe('test', 42);
    m.reset();
    expect(m.histogram('test')).toBeNull();
  });

  it('handles negative values', () => {
    const m = new NodeMetrics();
    m.observe('delta', -10);
    m.observe('delta', 0);
    m.observe('delta', 10);
    const stats = m.histogram('delta');
    expect(stats!.min).toBe(-10);
    expect(stats!.max).toBe(10);
    expect(stats!.mean).toBe(0);
  });

  it('handles floating point values', () => {
    const m = new NodeMetrics();
    m.observe('float', 0.1);
    m.observe('float', 0.2);
    m.observe('float', 0.3);
    const stats = m.histogram('float');
    expect(stats!.min).toBeCloseTo(0.1);
    expect(stats!.max).toBeCloseTo(0.3);
    expect(stats!.mean).toBeCloseTo(0.2);
  });

  it('independent histograms do not interfere', () => {
    const m = new NodeMetrics();
    m.observe('a', 100);
    m.observe('b', 200);
    expect(m.histogram('a')!.mean).toBe(100);
    expect(m.histogram('b')!.mean).toBe(200);
  });
});
