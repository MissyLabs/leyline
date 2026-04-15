import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MagicNode } from '../src/node/magic-node.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AGENT_A = 'aa'.repeat(32);
const AGENT_B = 'bb'.repeat(32);

describe('MagicNode — ban management API', () => {
  let node: MagicNode;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `leyline-admin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    node = new MagicNode({
      listenPort: 0,
      listenAddresses: [],
      seedNodes: [],
      dataDir,
    });
    // We don't call node.start() — just open the trust policy directly for unit testing
    // Access internal trustPolicy via the public API methods
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('blockAgent and getBlockedAgents', async () => {
    // Manually open trust policy for unit test
    await (node as any).trustPolicy.open();
    try {
      await node.blockAgent(AGENT_A);
      expect(node.getBlockedAgents()).toContain(AGENT_A);
    } finally {
      await (node as any).trustPolicy.close();
    }
  });

  it('unblockAgent removes the block', async () => {
    await (node as any).trustPolicy.open();
    try {
      await node.blockAgent(AGENT_A);
      expect(node.getBlockedAgents()).toContain(AGENT_A);
      await node.unblockAgent(AGENT_A);
      expect(node.getBlockedAgents()).not.toContain(AGENT_A);
    } finally {
      await (node as any).trustPolicy.close();
    }
  });

  it('blockAgentUntil and getBlockExpiry', async () => {
    await (node as any).trustPolicy.open();
    try {
      const expiresAt = Date.now() + 60_000;
      await node.blockAgentUntil(AGENT_A, expiresAt);
      expect(node.getBlockedAgents()).toContain(AGENT_A);
      expect(node.getBlockExpiry(AGENT_A)).toBe(expiresAt);
    } finally {
      await (node as any).trustPolicy.close();
    }
  });

  it('multiple blocks and unblocks', async () => {
    await (node as any).trustPolicy.open();
    try {
      await node.blockAgent(AGENT_A);
      await node.blockAgent(AGENT_B);
      expect(node.getBlockedAgents()).toHaveLength(2);

      await node.unblockAgent(AGENT_A);
      expect(node.getBlockedAgents()).toEqual([AGENT_B]);
    } finally {
      await (node as any).trustPolicy.close();
    }
  });
});

describe('MagicNode — partition detector integration', () => {
  it('partition detector is accessible', () => {
    const node = new MagicNode({
      listenPort: 0,
      listenAddresses: [],
      seedNodes: [],
      dataDir: join(tmpdir(), `leyline-part-${Date.now()}`),
    });

    const pd = node.getPartitionDetector();
    expect(pd).toBeDefined();
    expect(pd.isPartitionSuspected()).toBe(false);
    expect(pd.getPeakPeerCount()).toBe(0);
  });

  it('onPartition callback fires on partition events', () => {
    const partitionEvents: any[] = [];
    const node = new MagicNode(
      {
        listenPort: 0,
        listenAddresses: [],
        seedNodes: [],
        dataDir: join(tmpdir(), `leyline-part-${Date.now()}`),
      },
      {
        onPartition: (event) => partitionEvents.push(event),
      },
    );

    const pd = node.getPartitionDetector();
    // Simulate peer count changes
    pd.updatePeerCount(6);
    pd.updatePeerCount(2);

    expect(partitionEvents).toHaveLength(1);
    expect(partitionEvents[0].type).toBe('partition_suspected');
  });
});
