/**
 * Edge-case tests for rate limiting across subsystems.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DiscoveryProtocol,
  ServiceRegistry,
  type DiscoveryRateLimitConfig,
} from '../src/index.js';

const enc = new TextEncoder();

// Minimal stub that satisfies DiscoveryProtocol constructor for unit-level rate limit testing
function createProtocolForRateLimit(config: DiscoveryRateLimitConfig) {
  const registry = new ServiceRegistry();
  // We only need checkRateLimit — cast away the libp2p dependency
  const proto = Object.create(DiscoveryProtocol.prototype);
  proto.peerRequestTimes = new Map();
  proto.rateLimitConfig = {
    maxRequestsPerWindow: config.maxRequestsPerWindow ?? 30,
    windowMs: config.windowMs ?? 60_000,
  };
  return proto as InstanceType<typeof DiscoveryProtocol>;
}

describe('Discovery rate limiting — edge cases', () => {
  it('allows exactly maxRequestsPerWindow requests', () => {
    const proto = createProtocolForRateLimit({ maxRequestsPerWindow: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      expect(proto.checkRateLimit('peer-1')).toBe(true);
    }
    // 6th should be blocked
    expect(proto.checkRateLimit('peer-1')).toBe(false);
  });

  it('blocks all requests when maxRequestsPerWindow is 0', () => {
    const proto = createProtocolForRateLimit({ maxRequestsPerWindow: 0, windowMs: 60_000 });
    expect(proto.checkRateLimit('peer-1')).toBe(false);
  });

  it('isolates rate limits between peers', () => {
    const proto = createProtocolForRateLimit({ maxRequestsPerWindow: 2, windowMs: 60_000 });
    expect(proto.checkRateLimit('peer-a')).toBe(true);
    expect(proto.checkRateLimit('peer-a')).toBe(true);
    expect(proto.checkRateLimit('peer-a')).toBe(false);
    // peer-b should still be allowed
    expect(proto.checkRateLimit('peer-b')).toBe(true);
    expect(proto.checkRateLimit('peer-b')).toBe(true);
    expect(proto.checkRateLimit('peer-b')).toBe(false);
  });

  it('resets after window expires', async () => {
    const proto = createProtocolForRateLimit({ maxRequestsPerWindow: 1, windowMs: 50 });
    expect(proto.checkRateLimit('peer-1')).toBe(true);
    expect(proto.checkRateLimit('peer-1')).toBe(false);
    // Wait for window to expire
    await new Promise(r => setTimeout(r, 60));
    expect(proto.checkRateLimit('peer-1')).toBe(true);
  });

  it('handles rapid burst from single peer', () => {
    const proto = createProtocolForRateLimit({ maxRequestsPerWindow: 10, windowMs: 60_000 });
    const results: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      results.push(proto.checkRateLimit('burst-peer'));
    }
    expect(results.filter(r => r).length).toBe(10);
    expect(results.filter(r => !r).length).toBe(10);
  });

  it('does not leak memory — peerRequestTimes evicts old entries', async () => {
    const proto = createProtocolForRateLimit({ maxRequestsPerWindow: 100, windowMs: 50 });
    for (let i = 0; i < 50; i++) {
      proto.checkRateLimit('cleanup-peer');
    }
    // Wait for window to expire
    await new Promise(r => setTimeout(r, 60));
    // Make one more request — should evict old entries
    proto.checkRateLimit('cleanup-peer');
    const times = (proto as unknown as { peerRequestTimes: Map<string, number[]> })
      .peerRequestTimes.get('cleanup-peer');
    expect(times!.length).toBe(1);
  });
});
