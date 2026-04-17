import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MagicNode } from '../src/node/magic-node.js';
import { initProto } from '../src/messages/proto.js';
import {
  createMessage,
  serializeMessage,
  MessageType,
} from '../src/messages/message.js';
import { generateKeypair, publicKeyToHex } from '../src/identity/keypair.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class TestableNode extends MagicNode {
  async processMessage(topic: string, data: Uint8Array): Promise<void> {
    return this.handleIncomingMessage(topic, data);
  }
  getTrustPolicy() { return this.trustPolicy; }
}

describe('MagicNode — metrics integration', () => {
  let node: TestableNode;
  let tmpDir: string;
  let senderKeys: Awaited<ReturnType<typeof generateKeypair>>;
  let senderHex: string;

  async function makeMsg(tags: string[] = ['test']) {
    return serializeMessage(await createMessage({
      publicKey: senderKeys.publicKey,
      privateKey: senderKeys.privateKey,
      tags,
      payload: new Uint8Array([1, 2, 3]),
      type: MessageType.BROADCAST,
    }));
  }

  beforeAll(async () => {
    await initProto();
    senderKeys = await generateKeypair();
    senderHex = publicKeyToHex(senderKeys.publicKey);
    tmpDir = await mkdtemp(join(tmpdir(), 'metrics-integ-'));
    node = new TestableNode({
      listenPort: 0,
      subscribedTags: ['test'],
      seedNodes: [],
      enableWebSocket: false,
      enableRelay: false,
      dataDir: tmpDir,
    });
    await node.start();
    await node.allowAgent(senderHex);
  });

  afterAll(async () => {
    await node.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('records message processing latency histogram', async () => {
    const data = await makeMsg();
    await node.processMessage('magic/tag/test', data);

    const stats = node.metrics.histogram('message.latency.ms');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(1);
    expect(stats!.min).toBeGreaterThanOrEqual(0);
    expect(stats!.max).toBeLessThan(5000);
  });

  it('latency histogram accumulates across messages', async () => {
    const before = node.metrics.histogram('message.latency.ms')?.count ?? 0;

    for (let i = 0; i < 5; i++) {
      const data = await makeMsg();
      await node.processMessage('magic/tag/test', data);
    }

    const stats = node.metrics.histogram('message.latency.ms');
    expect(stats!.count).toBe(before + 5);
  });

  it('snapshot includes histogram and gauge data', async () => {
    const snap = node.metrics.snapshot();
    expect(snap.histograms).toBeDefined();
    expect(snap.gauges).toBeDefined();
    expect(snap.histograms['message.latency.ms']).toBeDefined();
  });

  it('blocked messages do not record latency', async () => {
    const countBefore = node.metrics.histogram('message.latency.ms')?.count ?? 0;

    const otherKeys = await generateKeypair();
    const data = serializeMessage(await createMessage({
      publicKey: otherKeys.publicKey,
      privateKey: otherKeys.privateKey,
      tags: ['test'],
      payload: new Uint8Array([9]),
      type: MessageType.BROADCAST,
    }));

    await node.processMessage('magic/tag/test', data);

    const countAfter = node.metrics.histogram('message.latency.ms')?.count ?? 0;
    expect(countAfter).toBe(countBefore);
  });

  it('trust denial increments trust.denied counter', async () => {
    const before = node.metrics.get('trust.denied');

    const otherKeys = await generateKeypair();
    const data = serializeMessage(await createMessage({
      publicKey: otherKeys.publicKey,
      privateKey: otherKeys.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    }));

    await node.processMessage('magic/tag/test', data);

    expect(node.metrics.get('trust.denied')).toBe(before + 1);
  });
});
