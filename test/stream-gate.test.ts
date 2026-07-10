import { describe, it, expect } from 'vitest';
import { StreamGate } from '../src/utils/stream-gate.js';

// RL-4: per-peer in-flight stream concurrency cap.
describe('StreamGate', () => {
  it('allows up to maxPerPeer concurrent streams and rejects beyond', () => {
    const gate = new StreamGate(3);
    expect(gate.tryAcquire('p')).toBe(true);
    expect(gate.tryAcquire('p')).toBe(true);
    expect(gate.tryAcquire('p')).toBe(true);
    expect(gate.tryAcquire('p')).toBe(false); // over cap
    expect(gate.inFlight('p')).toBe(3);
  });

  it('frees slots on release', () => {
    const gate = new StreamGate(1);
    expect(gate.tryAcquire('p')).toBe(true);
    expect(gate.tryAcquire('p')).toBe(false);
    gate.release('p');
    expect(gate.tryAcquire('p')).toBe(true);
  });

  it('tracks peers independently', () => {
    const gate = new StreamGate(1);
    expect(gate.tryAcquire('a')).toBe(true);
    expect(gate.tryAcquire('b')).toBe(true);
    expect(gate.tryAcquire('a')).toBe(false);
    expect(gate.tryAcquire('b')).toBe(false);
  });

  it('cleans up peer entries when fully released', () => {
    const gate = new StreamGate(2);
    gate.tryAcquire('p');
    gate.release('p');
    expect(gate.inFlight('p')).toBe(0);
  });
});
