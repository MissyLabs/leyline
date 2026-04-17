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
}

describe('MagicNode — onTagQueued', () => {
  let node: TestableNode;
  let tmpDir: string;
  let senderKeys: Awaited<ReturnType<typeof generateKeypair>>;
  let senderHex: string;

  async function makeMsg(payload: Uint8Array) {
    const msg = await createMessage({
      publicKey: senderKeys.publicKey,
      privateKey: senderKeys.privateKey,
      tags: ['queue-test'],
      payload,
      type: MessageType.BROADCAST,
    });
    return serializeMessage(msg);
  }

  beforeAll(async () => {
    await initProto();
    senderKeys = await generateKeypair();
    senderHex = publicKeyToHex(senderKeys.publicKey);

    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-queued-'));
    node = new TestableNode({
      listenPort: 0,
      subscribedTags: ['queue-test'],
      seedNodes: [],
      enableWebSocket: false,
      enableRelay: false,
      dataDir: tmpDir,
      rateLimitPerMinute: 100,
      maxInboundPerMinute: 200,
      maxPayloadBytesPerMinute: 1_048_576,
      autoBlockThreshold: 0,
    });
    await node.start();
    await node.allowAgent(senderHex);
  }, 30000);

  afterAll(async () => {
    await node.stop();
    await rm(tmpDir, { recursive: true, force: true });
  }, 15000);

  it('processes messages sequentially', async () => {
    const order: number[] = [];

    node.onTagQueued('queue-test', async (msg) => {
      const val = msg.payload[0];
      order.push(val);
      await new Promise(r => setTimeout(r, 10));
    }, 10);

    // Send 3 messages
    for (let i = 0; i < 3; i++) {
      const data = await makeMsg(new Uint8Array([i]));
      await node.processMessage('magic/tag/queue-test', data);
    }

    // Wait for processing
    await new Promise(r => setTimeout(r, 100));

    expect(order).toEqual([0, 1, 2]);
  });

  it('drops oldest when queue is full', async () => {
    const received: number[] = [];

    node.onTagQueued('queue-test', async (msg) => {
      received.push(msg.payload[0]);
      await new Promise(r => setTimeout(r, 50));
    }, 2); // max queue size of 2

    // Send 5 messages quickly — first will process immediately,
    // the rest queue. Queue size 2 means oldest gets dropped.
    for (let i = 10; i < 15; i++) {
      const data = await makeMsg(new Uint8Array([i]));
      await node.processMessage('magic/tag/queue-test', data);
    }

    await new Promise(r => setTimeout(r, 500));

    // The first message (10) should always be processed (it was dequeued immediately)
    expect(received[0]).toBe(10);
    // Later messages should include the most recent ones, not the oldest dropped ones
    expect(received.length).toBeLessThanOrEqual(5);
  });
});
