import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MagicNode, type MagicNodeEvents } from '../src/node/magic-node.js';
import { initProto } from '../src/messages/proto.js';

/**
 * Minimal config for a no-network MagicNode suitable for unit testing.
 * Uses port 0 (OS assigns ephemeral port), no seed nodes, no WebSocket,
 * no relay — avoids any real network activity.
 */
function makeConfig(dataDir: string, seedNodes: string[] = []) {
  return {
    listenPort: 0,
    seedNodes,
    enableWebSocket: false,
    enableRelay: false,
    dataDir,
  };
}

describe('MagicNode — graceful seed degradation', () => {
  let tmpDir: string;
  let node: MagicNode | null = null;
  let started = false;

  beforeEach(async () => {
    await initProto();
    tmpDir = mkdtempSync(join(tmpdir(), 'leyline-degradation-'));
    node = null;
    started = false;
  });

  afterEach(async () => {
    if (node && started) {
      await node.stop();
    }
    node = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startNode(n: MagicNode): Promise<void> {
    started = true;
    await n.start();
  }

  // -------------------------------------------------------------------------
  // 1. Node starts in non-degraded state
  // -------------------------------------------------------------------------
  it('starts in non-degraded state when no seeds are configured', async () => {
    node = new MagicNode(makeConfig(tmpDir));
    await startNode(node);

    expect(node.isDegraded()).toBe(false);
  }, 30000);

  // -------------------------------------------------------------------------
  // 2. getConnectedSeedCount returns 0 when libp2p is not running
  // -------------------------------------------------------------------------
  it('reports 0 connected seeds when libp2p is not yet running', async () => {
    // Start, then stop the node — libp2p is set to null after stop(),
    // so getConnectedSeedCount must return 0 without throwing.
    node = new MagicNode(makeConfig(tmpDir));
    await startNode(node);
    await node.stop();
    started = false; // already stopped — afterEach should not stop again

    expect(node.getConnectedSeedCount()).toBe(0);
  }, 30000);

  // -------------------------------------------------------------------------
  // 3. getConnectedSeedCount returns 0 after start with no seeds configured
  // -------------------------------------------------------------------------
  it('reports 0 connected seeds after start when seedNodes is empty', async () => {
    node = new MagicNode(makeConfig(tmpDir));
    await startNode(node);

    expect(node.getConnectedSeedCount()).toBe(0);
  }, 30000);

  // -------------------------------------------------------------------------
  // 4. isDegraded returns false immediately after start (no monitor tick yet)
  // -------------------------------------------------------------------------
  it('isDegraded returns false immediately after start even with configured seeds', async () => {
    // Provide fake seed multiaddrs that will never be dialed in tests.
    // The 15-second monitor has not fired yet, so degraded must still be false.
    node = new MagicNode(makeConfig(tmpDir, [
      '/ip4/127.0.0.1/tcp/19999/p2p/12D3KooWTestFakePeerIdAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]));
    await startNode(node);

    // Degraded state is only set by the interval timer (fires after 15s),
    // not at construction or start time.
    expect(node.isDegraded()).toBe(false);
  }, 30000);

  // -------------------------------------------------------------------------
  // 5. Type system accepts onSeedConnectivityChange callback
  // -------------------------------------------------------------------------
  it('MagicNodeEvents interface accepts onSeedConnectivityChange handler', async () => {
    const events: MagicNodeEvents = {
      onSeedConnectivityChange: (connectedSeeds: number, totalSeeds: number) => {
        // Verify parameter types match the declared signature.
        const _c: number = connectedSeeds;
        const _t: number = totalSeeds;
        void _c;
        void _t;
      },
    };

    node = new MagicNode(makeConfig(tmpDir), events);
    await startNode(node);

    expect(node).toBeDefined();
  }, 30000);

  // -------------------------------------------------------------------------
  // 6. Type system accepts onDegraded callback
  // -------------------------------------------------------------------------
  it('MagicNodeEvents interface accepts onDegraded handler', async () => {
    const events: MagicNodeEvents = {
      onDegraded: (reason: string) => {
        const _r: string = reason;
        void _r;
      },
    };

    node = new MagicNode(makeConfig(tmpDir), events);
    await startNode(node);

    expect(node).toBeDefined();
  }, 30000);

  // -------------------------------------------------------------------------
  // 7. Type system accepts onRecovered callback
  // -------------------------------------------------------------------------
  it('MagicNodeEvents interface accepts onRecovered handler', async () => {
    const events: MagicNodeEvents = {
      onRecovered: () => {
        // No parameters — void return.
      },
    };

    node = new MagicNode(makeConfig(tmpDir), events);
    await startNode(node);

    expect(node).toBeDefined();
  }, 30000);

  // -------------------------------------------------------------------------
  // 8. All three new event handlers can be supplied together
  // -------------------------------------------------------------------------
  it('MagicNodeEvents interface accepts all three degradation handlers simultaneously', async () => {
    const calls: string[] = [];

    const events: MagicNodeEvents = {
      onSeedConnectivityChange: (connected, total) => {
        calls.push(`connectivity:${connected}/${total}`);
      },
      onDegraded: (reason) => {
        calls.push(`degraded:${reason}`);
      },
      onRecovered: () => {
        calls.push('recovered');
      },
    };

    // Start the node with all handlers registered; verify it starts cleanly.
    node = new MagicNode(makeConfig(tmpDir), events);
    await startNode(node);

    // Node starts healthy (non-degraded) with no seeds configured.
    expect(node.isDegraded()).toBe(false);
    // None of the degradation events fire at startup — only the interval triggers them.
    expect(calls.filter((c) => c.startsWith('degraded')).length).toBe(0);
    expect(calls.filter((c) => c === 'recovered').length).toBe(0);
  }, 30000);
});
