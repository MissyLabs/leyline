import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrustPolicy } from '../src/trust/policy.js';

describe('TrustPolicy — edge cases', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('block always overrides allow', () => {
    const tp = new TrustPolicy();
    tp.allowAgent('alice');
    tp.blockAgent('alice');
    expect(tp.isAllowed('alice', [])).toBe(false);
  });

  it('allow after block does not restore access', () => {
    const tp = new TrustPolicy();
    tp.blockAgent('alice');
    tp.allowAgent('alice');
    expect(tp.isAllowed('alice', [])).toBe(false);
  });

  it('timed block expires correctly', () => {
    const tp = new TrustPolicy();
    tp.allowAgent('alice');
    tp.blockAgentUntil('alice', Date.now() + 5000);
    expect(tp.isAllowed('alice', [])).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(tp.isAllowed('alice', [])).toBe(true);
  });

  it('timed block preserves allowed state after expiry', () => {
    const tp = new TrustPolicy();
    tp.allowAgent('alice');
    tp.blockAgentUntil('alice', Date.now() + 1000);
    vi.advanceTimersByTime(1000);
    expect(tp.isAllowed('alice', ['test'])).toBe(true);
  });

  it('permanent block overrides timed block', () => {
    const tp = new TrustPolicy();
    tp.allowAgent('alice');
    tp.blockAgentUntil('alice', Date.now() + 1000);
    tp.blockAgent('alice');
    vi.advanceTimersByTime(2000);
    expect(tp.isAllowed('alice', [])).toBe(false);
  });

  it('unblock restores deny-first default, not allowed', () => {
    const tp = new TrustPolicy();
    tp.blockAgent('alice');
    tp.unblockAgent('alice');
    expect(tp.isAllowed('alice', [])).toBe(false);
  });

  it('open tags work for unknown senders', () => {
    const tp = new TrustPolicy();
    tp.allowTagOpen('public');
    expect(tp.isAllowed('unknown-key', ['public'])).toBe(true);
  });

  it('open tags blocked for explicitly blocked senders', () => {
    const tp = new TrustPolicy();
    tp.allowTagOpen('public');
    tp.blockAgent('badactor');
    expect(tp.isAllowed('badactor', ['public'])).toBe(false);
  });

  it('mixed open and private tags denied for unknown senders', () => {
    const tp = new TrustPolicy();
    tp.allowTagOpen('public');
    expect(tp.isAllowed('unknown', ['public', 'private'])).toBe(false);
  });

  it('closing a tag reverts to deny-first', () => {
    const tp = new TrustPolicy();
    tp.allowTagOpen('temp');
    expect(tp.isAllowed('unknown', ['temp'])).toBe(true);
    tp.closeTag('temp');
    expect(tp.isAllowed('unknown', ['temp'])).toBe(false);
  });

  it('per-agent tag block overrides agent-level allow', () => {
    const tp = new TrustPolicy();
    tp.allowAgent('alice');
    tp.allowTag('alice', 'other');
    tp.blockTag('alice', 'secret');
    expect(tp.isAllowed('alice', ['secret'])).toBe(false);
    expect(tp.isAllowed('alice', ['other'])).toBe(true);
  });

  it('per-agent tag allow required when tag rules exist', () => {
    const tp = new TrustPolicy();
    tp.allowAgent('alice');
    tp.allowTag('alice', 'approved');
    expect(tp.isAllowed('alice', ['approved'])).toBe(true);
    expect(tp.isAllowed('alice', ['unapproved'])).toBe(false);
  });

  it('no tags supplied means agent-level check only', () => {
    const tp = new TrustPolicy();
    tp.allowAgent('alice');
    tp.blockTag('alice', 'secret');
    expect(tp.isAllowed('alice', [])).toBe(true);
  });

  it('getBlockedAgents returns all blocked', () => {
    const tp = new TrustPolicy();
    tp.blockAgent('a');
    tp.blockAgent('b');
    tp.allowAgent('c');
    const blocked = tp.getBlockedAgents();
    expect(blocked).toContain('a');
    expect(blocked).toContain('b');
    expect(blocked).not.toContain('c');
  });

  it('getAllowedAgents excludes blocked', () => {
    const tp = new TrustPolicy();
    tp.allowAgent('a');
    tp.allowAgent('b');
    tp.blockAgent('a');
    const allowed = tp.getAllowedAgents();
    expect(allowed).not.toContain('a');
    expect(allowed).toContain('b');
  });

  it('isTagOpen returns correct state', () => {
    const tp = new TrustPolicy();
    expect(tp.isTagOpen('test')).toBe(false);
    tp.allowTagOpen('test');
    expect(tp.isTagOpen('test')).toBe(true);
    tp.closeTag('test');
    expect(tp.isTagOpen('test')).toBe(false);
  });

  it('getBlockExpiry returns undefined for non-timed blocks', () => {
    const tp = new TrustPolicy();
    tp.blockAgent('alice');
    expect(tp.getBlockExpiry('alice')).toBeUndefined();
  });

  it('getBlockExpiry returns expiry for timed blocks', () => {
    const tp = new TrustPolicy();
    const expiry = Date.now() + 10000;
    tp.blockAgentUntil('alice', expiry);
    expect(tp.getBlockExpiry('alice')).toBe(expiry);
  });
});
