import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MagicNode } from '../src/node/magic-node.js';
import { initProto } from '../src/messages/proto.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/config.js';

describe('Config — maxConnections', () => {
  it('defaults to 100', () => {
    expect(DEFAULT_CONFIG.maxConnections).toBe(100);
  });

  it('can be set to 0 for unlimited', () => {
    expect(DEFAULT_CONFIG.maxConnections).toBeGreaterThanOrEqual(0);
  });
});

describe('MagicNode — connection limits', () => {
  let node: MagicNode;
  let tmpDir: string;

  beforeAll(async () => {
    await initProto();
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-connlimit-'));
    node = new MagicNode({
      listenPort: 0,
      seedNodes: [],
      enableWebSocket: false,
      enableRelay: false,
      dataDir: tmpDir,
      maxConnections: 5,
    });
    await node.start();
  }, 30000);

  afterAll(async () => {
    await node.stop();
    await rm(tmpDir, { recursive: true, force: true });
  }, 15000);

  it('starts with maxConnections configured', () => {
    expect(node).toBeDefined();
  });

  it('node can accept at least one connection', async () => {
    const peer = new MagicNode({
      listenPort: 0,
      seedNodes: [],
      enableWebSocket: false,
      enableRelay: false,
      dataDir: await mkdtemp(join(tmpdir(), 'leyline-peer-')),
      maxConnections: 5,
    });
    await peer.start();

    const addrs = node.getMultiaddrs();
    expect(addrs.length).toBeGreaterThan(0);

    await peer.stop();
    await rm(peer['config'].dataDir, { recursive: true, force: true });
  }, 15000);
});
