import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PersistentTrustPolicy,
  PersistentSpamFilter,
} from '../src/trust/persistent-policy.js';

// ---------------------------------------------------------------------------
// PersistentTrustPolicy
// ---------------------------------------------------------------------------

describe('PersistentTrustPolicy', () => {
  let dir: string;
  let policy: PersistentTrustPolicy;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'leyline-trust-'));
    policy = new PersistentTrustPolicy(dir);
    await policy.open();
  });

  afterAll(async () => {
    await policy.close();
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Basic allow / block / isAllowed
  // -------------------------------------------------------------------------

  it('denies an unknown agent by default (deny-first)', () => {
    expect(policy.isAllowed('unknown-agent', ['any:tag'])).toBe(false);
  });

  it('allows an explicitly whitelisted agent', async () => {
    await policy.allowAgent('agent-allow');
    expect(policy.isAllowed('agent-allow', ['any:tag'])).toBe(true);
  });

  it('block overrides allow', async () => {
    await policy.allowAgent('agent-block');
    await policy.blockAgent('agent-block');
    expect(policy.isAllowed('agent-block', ['any:tag'])).toBe(false);
  });

  it('getBlockedAgents() returns the blocked agent', async () => {
    await policy.blockAgent('agent-listed-blocked');
    expect(policy.getBlockedAgents()).toContain('agent-listed-blocked');
  });

  it('getAllowedAgents() lists only allowed-and-not-blocked agents', async () => {
    await policy.allowAgent('agent-only-allowed');
    const allowed = policy.getAllowedAgents();
    expect(allowed).toContain('agent-only-allowed');
    // An agent that was blocked should not appear in getAllowedAgents().
    expect(allowed).not.toContain('agent-block');
  });

  // -------------------------------------------------------------------------
  // Tag-level rules
  // -------------------------------------------------------------------------

  it('allowTag permits access for that tag', async () => {
    await policy.allowAgent('agent-tags');
    await policy.allowTag('agent-tags', 'skill:code');

    // Allowed tag passes.
    expect(policy.isAllowed('agent-tags', ['skill:code'])).toBe(true);
  });

  it('blockTag denies access for that tag even when agent is allowed', async () => {
    await policy.allowAgent('agent-blocked-tag');
    await policy.blockTag('agent-blocked-tag', 'skill:admin');

    expect(policy.isAllowed('agent-blocked-tag', ['skill:admin'])).toBe(false);
  });

  it('allowTag + blockTag: blocked tag wins for that tag', async () => {
    await policy.allowAgent('agent-mixed-tags');
    await policy.allowTag('agent-mixed-tags', 'skill:code');
    await policy.blockTag('agent-mixed-tags', 'skill:admin');

    expect(policy.isAllowed('agent-mixed-tags', ['skill:code'])).toBe(true);
    expect(policy.isAllowed('agent-mixed-tags', ['skill:admin'])).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Persistence: close, re-open, verify state survives
  // -------------------------------------------------------------------------

  it('persists agent allow/block state across close + re-open', async () => {
    const persistDir = await mkdtemp(join(tmpdir(), 'leyline-trust-persist-'));

    try {
      const p1 = new PersistentTrustPolicy(persistDir);
      await p1.open();
      await p1.allowAgent('persistent-agent-a');
      await p1.blockAgent('persistent-agent-b');
      await p1.close();

      // Re-open with a fresh instance pointing to the same directory.
      const p2 = new PersistentTrustPolicy(persistDir);
      await p2.open();

      expect(p2.isAllowed('persistent-agent-a', ['any:tag'])).toBe(true);
      expect(p2.isAllowed('persistent-agent-b', ['any:tag'])).toBe(false);
      expect(p2.getAllowedAgents()).toContain('persistent-agent-a');
      expect(p2.getBlockedAgents()).toContain('persistent-agent-b');

      await p2.close();
    } finally {
      await rm(persistDir, { recursive: true, force: true });
    }
  });

  it('persists tag allow/block rules across close + re-open', async () => {
    const persistDir = await mkdtemp(join(tmpdir(), 'leyline-trust-tags-'));

    try {
      const p1 = new PersistentTrustPolicy(persistDir);
      await p1.open();
      await p1.allowAgent('tag-agent');
      await p1.allowTag('tag-agent', 'skill:code');
      await p1.blockTag('tag-agent', 'skill:admin');
      await p1.close();

      const p2 = new PersistentTrustPolicy(persistDir);
      await p2.open();

      // Allowed tag should still be accessible.
      expect(p2.isAllowed('tag-agent', ['skill:code'])).toBe(true);
      // Blocked tag should still be denied.
      expect(p2.isAllowed('tag-agent', ['skill:admin'])).toBe(false);

      await p2.close();
    } finally {
      await rm(persistDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PersistentSpamFilter
// ---------------------------------------------------------------------------

describe('PersistentSpamFilter', () => {
  let dir: string;
  let filter: PersistentSpamFilter;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'leyline-spam-'));
    filter = new PersistentSpamFilter(dir);
    await filter.open();
  });

  afterAll(async () => {
    await filter.close();
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // isDuplicate — ephemeral, no persistence
  // -------------------------------------------------------------------------

  it('returns false for a message id seen for the first time', () => {
    expect(filter.isDuplicate('msg-new-1')).toBe(false);
  });

  it('returns true for a message id seen a second time in the same session', () => {
    filter.isDuplicate('msg-dup-check'); // first touch — registers it
    expect(filter.isDuplicate('msg-dup-check')).toBe(true);
  });

  it('treats different message ids as independent', () => {
    expect(filter.isDuplicate('unique-a')).toBe(false);
    expect(filter.isDuplicate('unique-b')).toBe(false);
    // Calling unique-a again should now be a duplicate.
    expect(filter.isDuplicate('unique-a')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // reportSpam / getSpamCount
  // -------------------------------------------------------------------------

  it('starts with a spam count of 0 for any sender', () => {
    expect(filter.getSpamCount('brand-new-sender')).toBe(0);
  });

  it('increments the spam count with each report', async () => {
    await filter.reportSpam('spammer-a');
    expect(filter.getSpamCount('spammer-a')).toBe(1);

    await filter.reportSpam('spammer-a');
    expect(filter.getSpamCount('spammer-a')).toBe(2);
  });

  it('tracks spam counts independently per sender', async () => {
    await filter.reportSpam('sender-x');
    await filter.reportSpam('sender-x');
    await filter.reportSpam('sender-x');
    await filter.reportSpam('sender-y');

    expect(filter.getSpamCount('sender-x')).toBe(3);
    expect(filter.getSpamCount('sender-y')).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Persistence: close, re-open, verify spam counts survived
  // -------------------------------------------------------------------------

  it('persists spam counts across close + re-open', async () => {
    const persistDir = await mkdtemp(join(tmpdir(), 'leyline-spam-persist-'));

    try {
      const f1 = new PersistentSpamFilter(persistDir);
      await f1.open();

      await f1.reportSpam('persistent-spammer');
      await f1.reportSpam('persistent-spammer');
      await f1.reportSpam('persistent-spammer');
      expect(f1.getSpamCount('persistent-spammer')).toBe(3);

      await f1.close();

      // Re-open with a fresh instance pointing to the same directory.
      const f2 = new PersistentSpamFilter(persistDir);
      await f2.open();

      expect(f2.getSpamCount('persistent-spammer')).toBe(3);

      await f2.close();
    } finally {
      await rm(persistDir, { recursive: true, force: true });
    }
  });

  it('correctly resumes accumulation after re-open', async () => {
    const persistDir = await mkdtemp(join(tmpdir(), 'leyline-spam-resume-'));

    try {
      const f1 = new PersistentSpamFilter(persistDir);
      await f1.open();
      await f1.reportSpam('resume-sender');
      await f1.reportSpam('resume-sender');
      await f1.close();

      const f2 = new PersistentSpamFilter(persistDir);
      await f2.open();
      // Count should resume from 2, not restart at 0.
      await f2.reportSpam('resume-sender');
      expect(f2.getSpamCount('resume-sender')).toBe(3);

      await f2.close();
    } finally {
      await rm(persistDir, { recursive: true, force: true });
    }
  });

  it('isDuplicate state is ephemeral — not restored after re-open', async () => {
    const persistDir = await mkdtemp(join(tmpdir(), 'leyline-spam-ephemeral-'));

    try {
      const f1 = new PersistentSpamFilter(persistDir);
      await f1.open();
      // Register a message ID in the first session.
      f1.isDuplicate('ephemeral-msg-id');
      expect(f1.isDuplicate('ephemeral-msg-id')).toBe(true); // duplicate within session
      await f1.close();

      const f2 = new PersistentSpamFilter(persistDir);
      await f2.open();
      // After re-open the seen-set is fresh — the id is no longer a duplicate.
      expect(f2.isDuplicate('ephemeral-msg-id')).toBe(false);

      await f2.close();
    } finally {
      await rm(persistDir, { recursive: true, force: true });
    }
  });
});
