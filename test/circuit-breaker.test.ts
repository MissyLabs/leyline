import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../src/utils/circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts closed for unknown peers', () => {
    const cb = new CircuitBreaker();
    expect(cb.isOpen('peer-1')).toBe(false);
  });

  it('stays closed below failure threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(false);
  });

  it('opens after reaching failure threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(true);
  });

  it('closes after cooldown period', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 5000 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(true);

    vi.advanceTimersByTime(4999);
    expect(cb.isOpen('peer-1')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(cb.isOpen('peer-1')).toBe(false);
  });

  it('resets failure count after cooldown', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(cb.isOpen('peer-1')).toBe(false);

    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(false);
  });

  it('success resets failure count', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    cb.recordSuccess('peer-1');
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(false);
  });

  it('success on unknown peer is no-op', () => {
    const cb = new CircuitBreaker();
    cb.recordSuccess('peer-1');
    expect(cb.isOpen('peer-1')).toBe(false);
  });

  it('tracks peers independently', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-2');
    expect(cb.isOpen('peer-1')).toBe(true);
    expect(cb.isOpen('peer-2')).toBe(false);
  });

  it('reset removes a peer', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(true);
    cb.reset('peer-1');
    expect(cb.isOpen('peer-1')).toBe(false);
    expect(cb.size).toBe(0);
  });

  it('clear removes all peers', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-2');
    cb.recordFailure('peer-3');
    expect(cb.size).toBe(3);
    cb.clear();
    expect(cb.size).toBe(0);
  });

  it('getOpenPeers returns only open circuits', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 5000 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-2');
    cb.recordFailure('peer-3');
    cb.recordFailure('peer-3');
    expect(cb.getOpenPeers().sort()).toEqual(['peer-1', 'peer-3']);
  });

  it('evicts oldest entry when max tracked is reached', () => {
    const cb = new CircuitBreaker({ maxTrackedPeers: 3, failureThreshold: 1 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-2');
    cb.recordFailure('peer-3');
    expect(cb.size).toBe(3);
    cb.recordFailure('peer-4');
    expect(cb.size).toBe(3);
    expect(cb.isOpen('peer-1')).toBe(false);
    expect(cb.isOpen('peer-4')).toBe(true);
  });

  it('uses default config values', () => {
    const cb = new CircuitBreaker();
    // Default threshold is 3
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(false);
    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(true);

    // Default cooldown is 60s
    vi.advanceTimersByTime(59999);
    expect(cb.isOpen('peer-1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(cb.isOpen('peer-1')).toBe(false);
  });

  it('re-opens on repeated failure after cooldown', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(cb.isOpen('peer-1')).toBe(false);

    cb.recordFailure('peer-1');
    cb.recordFailure('peer-1');
    expect(cb.isOpen('peer-1')).toBe(true);
  });
});
