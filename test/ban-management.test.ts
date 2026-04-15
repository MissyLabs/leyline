import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrustPolicy } from '../src/trust/policy.js';
import { PersistentTrustPolicy } from '../src/trust/persistent-policy.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AGENT_A = 'aa'.repeat(32);
const AGENT_B = 'bb'.repeat(32);
const AGENT_C = 'cc'.repeat(32);

describe('TrustPolicy — unblockAgent', () => {
  let policy: TrustPolicy;

  beforeEach(() => {
    policy = new TrustPolicy();
  });

  it('unblocking a blocked agent removes the block', () => {
    policy.allowAgent(AGENT_A);
    policy.blockAgent(AGENT_A);
    expect(policy.isAllowed(AGENT_A, [])).toBe(false);

    policy.unblockAgent(AGENT_A);
    expect(policy.getBlockedAgents()).not.toContain(AGENT_A);
    // Agent is not auto-allowed after unblock — deny-first applies
    expect(policy.isAllowed(AGENT_A, [])).toBe(false);
  });

  it('unblocking then re-allowing restores full access', () => {
    policy.blockAgent(AGENT_A);
    policy.unblockAgent(AGENT_A);
    policy.allowAgent(AGENT_A);
    expect(policy.isAllowed(AGENT_A, [])).toBe(true);
  });

  it('unblocking an agent that was never blocked is a no-op', () => {
    policy.unblockAgent(AGENT_A);
    expect(policy.getBlockedAgents()).toEqual([]);
  });

  it('unblocking an unknown agent is a no-op', () => {
    policy.unblockAgent('unknown');
    expect(policy.getBlockedAgents()).toEqual([]);
  });

  it('unblock preserves tag-level rules', () => {
    policy.allowAgent(AGENT_A);
    policy.allowTag(AGENT_A, 'tag:a');
    policy.blockTag(AGENT_A, 'tag:b');
    policy.blockAgent(AGENT_A);
    policy.unblockAgent(AGENT_A);
    policy.allowAgent(AGENT_A);

    expect(policy.isAllowed(AGENT_A, ['tag:a'])).toBe(true);
    expect(policy.isAllowed(AGENT_A, ['tag:b'])).toBe(false);
  });
});

describe('TrustPolicy — time-bounded bans', () => {
  let policy: TrustPolicy;

  beforeEach(() => {
    policy = new TrustPolicy();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blockAgentUntil blocks the agent before expiry', () => {
    const expiresAt = Date.now() + 60_000;
    policy.blockAgentUntil(AGENT_A, expiresAt);
    expect(policy.isAllowed(AGENT_A, [])).toBe(false);
    expect(policy.getBlockedAgents()).toContain(AGENT_A);
  });

  it('blockAgentUntil auto-expires after the deadline', () => {
    const expiresAt = Date.now() + 60_000;
    policy.allowAgent(AGENT_A);
    policy.blockAgentUntil(AGENT_A, expiresAt);
    expect(policy.isAllowed(AGENT_A, [])).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(policy.isAllowed(AGENT_A, [])).toBe(true);
    expect(policy.getBlockedAgents()).not.toContain(AGENT_A);
  });

  it('permanent blockAgent has no expiry', () => {
    policy.blockAgent(AGENT_A);
    expect(policy.getBlockExpiry(AGENT_A)).toBeUndefined();

    vi.advanceTimersByTime(999_999_999);
    expect(policy.isAllowed(AGENT_A, [])).toBe(false);
  });

  it('getBlockExpiry returns the expiry for time-bounded bans', () => {
    const expiresAt = Date.now() + 120_000;
    policy.blockAgentUntil(AGENT_A, expiresAt);
    expect(policy.getBlockExpiry(AGENT_A)).toBe(expiresAt);
  });

  it('getBlockExpiry returns undefined for non-blocked agents', () => {
    expect(policy.getBlockExpiry(AGENT_A)).toBeUndefined();
    policy.allowAgent(AGENT_A);
    expect(policy.getBlockExpiry(AGENT_A)).toBeUndefined();
  });

  it('permanent block overrides a prior time-bounded ban', () => {
    policy.blockAgentUntil(AGENT_A, Date.now() + 60_000);
    policy.blockAgent(AGENT_A);
    expect(policy.getBlockExpiry(AGENT_A)).toBeUndefined();

    vi.advanceTimersByTime(120_000);
    expect(policy.isAllowed(AGENT_A, [])).toBe(false);
  });

  it('time-bounded ban does not make the agent allowed after expiry if never allowed', () => {
    policy.blockAgentUntil(AGENT_A, Date.now() + 10_000);
    vi.advanceTimersByTime(10_001);

    // Not blocked, but also not allowed — deny-first
    expect(policy.isAllowed(AGENT_A, [])).toBe(false);
    expect(policy.getBlockedAgents()).not.toContain(AGENT_A);
  });

  it('unblockAgent clears time-bounded ban', () => {
    policy.blockAgentUntil(AGENT_A, Date.now() + 60_000);
    policy.unblockAgent(AGENT_A);
    expect(policy.getBlockExpiry(AGENT_A)).toBeUndefined();
    expect(policy.getBlockedAgents()).not.toContain(AGENT_A);
  });

  it('expired ban on open tags allows messages through', () => {
    policy.allowTagOpen('open:tag');
    policy.blockAgentUntil(AGENT_A, Date.now() + 5_000);

    expect(policy.isAllowed(AGENT_A, ['open:tag'])).toBe(false);
    vi.advanceTimersByTime(5_001);
    expect(policy.isAllowed(AGENT_A, ['open:tag'])).toBe(true);
  });

  it('multiple agents with different expiry times', () => {
    policy.allowAgent(AGENT_A);
    policy.allowAgent(AGENT_B);
    policy.allowAgent(AGENT_C);

    policy.blockAgentUntil(AGENT_A, Date.now() + 10_000);
    policy.blockAgentUntil(AGENT_B, Date.now() + 30_000);
    policy.blockAgent(AGENT_C);

    vi.advanceTimersByTime(15_000);
    expect(policy.isAllowed(AGENT_A, [])).toBe(true);
    expect(policy.isAllowed(AGENT_B, [])).toBe(false);
    expect(policy.isAllowed(AGENT_C, [])).toBe(false);

    vi.advanceTimersByTime(20_000);
    expect(policy.isAllowed(AGENT_B, [])).toBe(true);
    expect(policy.isAllowed(AGENT_C, [])).toBe(false);
  });
});

describe('PersistentTrustPolicy — ban management persistence', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `leyline-ban-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('unblockAgent persists and survives restart', async () => {
    const policy1 = new PersistentTrustPolicy(dataDir);
    await policy1.open();
    await policy1.blockAgent(AGENT_A);
    expect(policy1.getBlockedAgents()).toContain(AGENT_A);
    await policy1.unblockAgent(AGENT_A);
    expect(policy1.getBlockedAgents()).not.toContain(AGENT_A);
    await policy1.close();

    const policy2 = new PersistentTrustPolicy(dataDir);
    await policy2.open();
    expect(policy2.getBlockedAgents()).not.toContain(AGENT_A);
    await policy2.close();
  });

  it('blockAgentUntil persists expiry and survives restart', async () => {
    const expiresAt = Date.now() + 3_600_000;
    const policy1 = new PersistentTrustPolicy(dataDir);
    await policy1.open();
    await policy1.blockAgentUntil(AGENT_A, expiresAt);
    expect(policy1.getBlockExpiry(AGENT_A)).toBe(expiresAt);
    await policy1.close();

    const policy2 = new PersistentTrustPolicy(dataDir);
    await policy2.open();
    expect(policy2.getBlockedAgents()).toContain(AGENT_A);
    expect(policy2.getBlockExpiry(AGENT_A)).toBe(expiresAt);
    await policy2.close();
  });

  it('expired ban is cleared on rehydration check', async () => {
    const expiresAt = Date.now() + 100;
    const policy1 = new PersistentTrustPolicy(dataDir);
    await policy1.open();
    await policy1.allowAgent(AGENT_A);
    await policy1.blockAgentUntil(AGENT_A, expiresAt);
    await policy1.close();

    // Wait past expiry
    await new Promise(r => setTimeout(r, 150));

    const policy2 = new PersistentTrustPolicy(dataDir);
    await policy2.open();
    // The ban was rehydrated but is now expired — isAllowed triggers cleanup
    expect(policy2.isAllowed(AGENT_A, [])).toBe(true);
    expect(policy2.getBlockedAgents()).not.toContain(AGENT_A);
    await policy2.close();
  });

  it('permanent block has no expiry after persistence', async () => {
    const policy1 = new PersistentTrustPolicy(dataDir);
    await policy1.open();
    await policy1.blockAgent(AGENT_A);
    await policy1.close();

    const policy2 = new PersistentTrustPolicy(dataDir);
    await policy2.open();
    expect(policy2.getBlockExpiry(AGENT_A)).toBeUndefined();
    expect(policy2.getBlockedAgents()).toContain(AGENT_A);
    await policy2.close();
  });
});
