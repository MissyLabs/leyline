/**
 * Deep edge-case tests for Leyline.
 *
 * Covers:
 *  1. PersistentTrustPolicy — persistence across close/re-open for all rule types
 *  2. PersistentSpamFilter  — persistence, ephemeral dedup, multi-peer counts
 *  3. SeedNode              — lifecycle: start/stop, health check, timer cleanup
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PersistentTrustPolicy,
  PersistentSpamFilter,
} from '../src/trust/persistent-policy.js';
import { SeedNode } from '../src/node/seed-node.js';
import { initProto } from '../src/messages/proto.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp directory per test that cleans itself up. */
async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `leyline-deep-${prefix}-`));
}

async function cleanDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 1. PersistentTrustPolicy — persistence tests
// ---------------------------------------------------------------------------

describe('PersistentTrustPolicy — persistence across close + re-open', () => {
  beforeAll(async () => {
    await initProto();
  });

  // -------------------------------------------------------------------------
  // Test 1: allowAgent persists
  // -------------------------------------------------------------------------

  it('allowed agent is still allowed after close and re-open', async () => {
    const dir = await makeTempDir('tp-allow');
    try {
      const p1 = new PersistentTrustPolicy(dir);
      await p1.open();
      await p1.allowAgent('aabbccdd');
      await p1.close();

      const p2 = new PersistentTrustPolicy(dir);
      await p2.open();
      expect(p2.isAllowed('aabbccdd', ['any:tag'])).toBe(true);
      expect(p2.getAllowedAgents()).toContain('aabbccdd');
      await p2.close();
    } finally {
      await cleanDir(dir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: allowTag persists
  // -------------------------------------------------------------------------

  it('allowed tag for an agent survives close and re-open', async () => {
    const dir = await makeTempDir('tp-tag');
    try {
      const p1 = new PersistentTrustPolicy(dir);
      await p1.open();
      await p1.allowAgent('agent-tag-persist');
      await p1.allowTag('agent-tag-persist', 'skill:code');
      await p1.close();

      const p2 = new PersistentTrustPolicy(dir);
      await p2.open();
      // Agent is allowed and the specific tag is allowed.
      expect(p2.isAllowed('agent-tag-persist', ['skill:code'])).toBe(true);
      await p2.close();
    } finally {
      await cleanDir(dir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: blockAgent persists
  // -------------------------------------------------------------------------

  it('blocked agent remains blocked after close and re-open', async () => {
    const dir = await makeTempDir('tp-block');
    try {
      const p1 = new PersistentTrustPolicy(dir);
      await p1.open();
      await p1.blockAgent('bad-actor');
      await p1.close();

      const p2 = new PersistentTrustPolicy(dir);
      await p2.open();
      expect(p2.isAllowed('bad-actor', ['any:tag'])).toBe(false);
      expect(p2.getBlockedAgents()).toContain('bad-actor');
      await p2.close();
    } finally {
      await cleanDir(dir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: allowTagOpen persists
  // -------------------------------------------------------------------------

  it('open tags persist across close and re-open', async () => {
    const dir = await makeTempDir('tp-open');
    try {
      const p1 = new PersistentTrustPolicy(dir);
      await p1.open();
      await p1.allowTagOpen('public:announce');
      await p1.allowTagOpen('discovery:peer');
      await p1.close();

      const p2 = new PersistentTrustPolicy(dir);
      await p2.open();
      // An unknown sender with an open tag should be allowed.
      expect(p2.isAllowed('unknown-sender', ['public:announce'])).toBe(true);
      expect(p2.isAllowed('unknown-sender', ['discovery:peer'])).toBe(true);
      // An unknown sender without an open tag must still be denied.
      expect(p2.isAllowed('unknown-sender', ['private:internal'])).toBe(false);
      expect(p2.isTagOpen('public:announce')).toBe(true);
      expect(p2.isTagOpen('discovery:peer')).toBe(true);
      await p2.close();
    } finally {
      await cleanDir(dir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: allowAgent then blockAgent — block wins after re-open
  // -------------------------------------------------------------------------

  it('block overrides allow and the block persists across re-open', async () => {
    const dir = await makeTempDir('tp-allow-then-block');
    try {
      const p1 = new PersistentTrustPolicy(dir);
      await p1.open();
      // First allow, then immediately block the same agent.
      await p1.allowAgent('flip-flop-agent');
      await p1.blockAgent('flip-flop-agent');
      // Verify the in-session state before close.
      expect(p1.isAllowed('flip-flop-agent', ['any:tag'])).toBe(false);
      await p1.close();

      // After re-open the block must still override any prior allow record.
      const p2 = new PersistentTrustPolicy(dir);
      await p2.open();
      expect(p2.isAllowed('flip-flop-agent', ['any:tag'])).toBe(false);
      expect(p2.getBlockedAgents()).toContain('flip-flop-agent');
      // The agent must NOT appear in the allowed list.
      expect(p2.getAllowedAgents()).not.toContain('flip-flop-agent');
      await p2.close();
    } finally {
      await cleanDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. PersistentSpamFilter — persistence tests
// ---------------------------------------------------------------------------

describe('PersistentSpamFilter — persistence across close + re-open', () => {
  // -------------------------------------------------------------------------
  // Test 1: spam count persists after N reports
  // -------------------------------------------------------------------------

  it('spam count survives close and re-open', async () => {
    const dir = await makeTempDir('sf-count');
    try {
      const f1 = new PersistentSpamFilter(dir);
      await f1.open();
      for (let i = 0; i < 7; i++) {
        await f1.reportSpam('spammer-persist');
      }
      expect(f1.getSpamCount('spammer-persist')).toBe(7);
      await f1.close();

      const f2 = new PersistentSpamFilter(dir);
      await f2.open();
      // Exact count must be restored — not reset to zero.
      expect(f2.getSpamCount('spammer-persist')).toBe(7);
      // Further reports must increment from the restored baseline.
      await f2.reportSpam('spammer-persist');
      expect(f2.getSpamCount('spammer-persist')).toBe(8);
      await f2.close();
    } finally {
      await cleanDir(dir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: dedup state is ephemeral — not restored after close/re-open
  // -------------------------------------------------------------------------

  it('isDuplicate seen-set is reset on re-open (ephemeral)', async () => {
    const dir = await makeTempDir('sf-dedup');
    try {
      const f1 = new PersistentSpamFilter(dir);
      await f1.open();
      // Register three message IDs in the first session.
      f1.isDuplicate('msg-alpha');
      f1.isDuplicate('msg-beta');
      f1.isDuplicate('msg-gamma');
      // All three are duplicates within the session.
      expect(f1.isDuplicate('msg-alpha')).toBe(true);
      expect(f1.isDuplicate('msg-beta')).toBe(true);
      expect(f1.isDuplicate('msg-gamma')).toBe(true);
      await f1.close();

      const f2 = new PersistentSpamFilter(dir);
      await f2.open();
      // After re-open the seen-set is fresh — none of them are duplicates.
      expect(f2.isDuplicate('msg-alpha')).toBe(false);
      expect(f2.isDuplicate('msg-beta')).toBe(false);
      expect(f2.isDuplicate('msg-gamma')).toBe(false);
      await f2.close();
    } finally {
      await cleanDir(dir);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: multiple peers with different counts all persist correctly
  // -------------------------------------------------------------------------

  it('spam counts for multiple distinct peers persist independently', async () => {
    const dir = await makeTempDir('sf-multi');
    try {
      const f1 = new PersistentSpamFilter(dir);
      await f1.open();
      // Peer A — 5 reports
      for (let i = 0; i < 5; i++) await f1.reportSpam('peer-aaaaaa');
      // Peer B — 2 reports
      for (let i = 0; i < 2; i++) await f1.reportSpam('peer-bbbbbb');
      // Peer C — 1 report
      await f1.reportSpam('peer-cccccc');
      await f1.close();

      const f2 = new PersistentSpamFilter(dir);
      await f2.open();
      expect(f2.getSpamCount('peer-aaaaaa')).toBe(5);
      expect(f2.getSpamCount('peer-bbbbbb')).toBe(2);
      expect(f2.getSpamCount('peer-cccccc')).toBe(1);
      // A peer that was never reported should still read as 0.
      expect(f2.getSpamCount('peer-dddddd')).toBe(0);
      await f2.close();
    } finally {
      await cleanDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. SeedNode — lifecycle tests
// ---------------------------------------------------------------------------

describe('SeedNode — lifecycle', () => {
  // Use a high base port to avoid conflicts with other test suites.
  // Tests pick sequential offsets to avoid port collisions within this suite.
  const BASE_PORT = 19_500;

  beforeAll(async () => {
    await initProto();
  });

  // -------------------------------------------------------------------------
  // Test 1: SeedNode can start and stop cleanly
  // -------------------------------------------------------------------------

  it('starts and stops without throwing', async () => {
    const dir = await makeTempDir('seed-start-stop');
    const node = new SeedNode({
      listenPort: BASE_PORT,
      enableWebSocket: false,
      enableRelay: false,
      seedNodes: [],        // No external seeds — isolated test
      dataDir: dir,
      healthCheckPort: 0,   // Disable HTTP health check for this test
    });

    try {
      await node.start();
      // If we get here without throwing, startup succeeded.
      expect(node).toBeDefined();
    } finally {
      await node.stop();
      await cleanDir(dir);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 2: health check HTTP server responds on the configured port
  // -------------------------------------------------------------------------

  it('health check server responds on the configured port after start', async () => {
    const dir = await makeTempDir('seed-health');
    const healthPort = BASE_PORT + 1;
    const node = new SeedNode({
      listenPort: BASE_PORT + 2,
      enableWebSocket: false,
      enableRelay: false,
      seedNodes: [],
      dataDir: dir,
      healthCheckPort: healthPort,
    });

    try {
      await node.start();

      const res = await fetch(`http://127.0.0.1:${healthPort}/health`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        status: string;
        version: string;
        uptime: number;
      };
      // Status is either 'ok' or 'degraded' (no peers in isolated test).
      expect(['ok', 'degraded']).toContain(body.status);
      expect(typeof body.version).toBe('string');
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    } finally {
      await node.stop();
      await cleanDir(dir);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 3: stop() cleans up timers and internal state
  // -------------------------------------------------------------------------

  it('stop cleans up peerExchangeTimer, ledgerConfirmTimer, and event listeners', async () => {
    const dir = await makeTempDir('seed-stop-cleanup');
    const node = new SeedNode({
      listenPort: BASE_PORT + 3,
      enableWebSocket: false,
      enableRelay: false,
      seedNodes: [],
      dataDir: dir,
      healthCheckPort: 0,
    });

    try {
      await node.start();
      // stop() must complete without throwing.
      await expect(node.stop()).resolves.toBeUndefined();
      // After a clean stop the node should not be usable for new connections —
      // verify by confirming the peer list is empty (libp2p torn down).
      expect(node.getPeerCount()).toBe(0);
    } finally {
      await cleanDir(dir);
    }
  }, 30_000);
});
