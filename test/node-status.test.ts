import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MagicNode } from '../src/node/magic-node.js';
import { initProto } from '../src/messages/proto.js';
import { LEYLINE_VERSION } from '../src/config/compat.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('MagicNode — getNodeStatus', () => {
  let node: MagicNode;
  let tmpDir: string;

  beforeAll(async () => {
    await initProto();
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-status-'));
    node = new MagicNode({
      listenPort: 0,
      subscribedTags: ['skill:code', 'lang:ts'],
      seedNodes: [],
      enableWebSocket: false,
      enableRelay: false,
      dataDir: tmpDir,
    });
    await node.start();
  }, 30000);

  afterAll(async () => {
    await node.stop();
    await rm(tmpDir, { recursive: true, force: true });
  }, 15000);

  it('returns basic status fields', () => {
    const status = node.getNodeStatus();
    expect(status.running).toBe(true);
    expect(status.degraded).toBe(false);
    expect(status.peerId).toBeTruthy();
    expect(status.fingerprint).toBeTruthy();
    expect(status.version).toBe(LEYLINE_VERSION);
  });

  it('reflects subscribed tags', () => {
    const status = node.getNodeStatus();
    expect(status.subscribedTags).toContain('skill:code');
    expect(status.subscribedTags).toContain('lang:ts');
  });

  it('shows zero peers when no connections', () => {
    const status = node.getNodeStatus();
    expect(status.peerCount).toBe(0);
    expect(status.connectedSeeds).toBe(0);
  });

  it('shows paused state', () => {
    const status = node.getNodeStatus();
    expect(status.paused).toBe(false);
    node.pause();
    expect(node.getNodeStatus().paused).toBe(true);
    node.resume();
    expect(node.getNodeStatus().paused).toBe(false);
  });

  it('async variant includes ledger entry count', async () => {
    const status = await node.getNodeStatusAsync();
    expect(status.ledgerEntries).toBe(0);
    expect(status.running).toBe(true);
  });

  it('shows not running after stop', async () => {
    const node2 = new MagicNode({
      listenPort: 0,
      seedNodes: [],
      enableWebSocket: false,
      enableRelay: false,
      dataDir: await mkdtemp(join(tmpdir(), 'leyline-status2-')),
    });
    await node2.start();
    const statusBefore = node2.getNodeStatus();
    expect(statusBefore.running).toBe(true);

    await node2.stop();
    const statusAfter = node2.getNodeStatus();
    expect(statusAfter.running).toBe(false);

    await rm(node2['config'].dataDir, { recursive: true, force: true });
  }, 15000);
});
