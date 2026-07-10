import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MagicNode } from '../src/node/magic-node.js';
import { initProto } from '../src/messages/proto.js';
import {
  createMessage,
  serializeMessage,
  MessageType,
} from '../src/messages/message.js';
import { generateKeypair, publicKeyToHex } from '../src/identity/keypair.js';
import { MessagePriority } from '../src/utils/priority-queue.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class TestableNode extends MagicNode {
  async processMessage(topic: string, data: Uint8Array): Promise<void> {
    return this.handleIncomingMessage(topic, data);
  }
}

describe('MagicNode — onTagPriority', () => {
  let node: TestableNode;
  let tmpDir: string;
  let senderKeys: Awaited<ReturnType<typeof generateKeypair>>;
  let senderHex: string;

  async function makeMsg(payload: Uint8Array) {
    return serializeMessage(await createMessage({
      publicKey: senderKeys.publicKey,
      privateKey: senderKeys.privateKey,
      tags: ['prio-test'],
      payload,
      type: MessageType.BROADCAST,
    }));
  }

  beforeAll(async () => {
    await initProto();
    senderKeys = await generateKeypair();
    senderHex = publicKeyToHex(senderKeys.publicKey);

    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-prio-'));
    node = new TestableNode({
      listenPort: 0,
      subscribedTags: ['prio-test'],
      seedNodes: [],
      enableWebSocket: false,
      enableRelay: false,
      dataDir: tmpDir,
      rateLimitPerMinute: 200,
      maxInboundPerMinute: 500,
      maxPayloadBytesPerMinute: 10_485_760,
      autoBlockThreshold: 0,
    });
    await node.start();
    await node.allowAgent(senderHex);
  }, 30000);

  afterAll(async () => {
    await node.stop();
    await rm(tmpDir, { recursive: true, force: true });
  }, 15000);

  it('processes messages in priority order', async () => {
    const order: number[] = [];

    // `onTagPriority` is a greedy online priority queue: the first message is
    // dequeued immediately when the queue is idle, and the drain loop pops
    // whatever is *already waiting* in priority order — it does not delay
    // processing to coalesce future arrivals. A previous version of this test
    // relied on all four messages happening to enqueue within the first
    // handler's 10ms sleep, which is a race (issue #12): on slower machines the
    // drain loop could pop a partially-filled queue and process the tail out of
    // priority order. We instead hold the FIRST handler invocation open with an
    // explicit gate so the remaining messages are provably enqueued before the
    // drain loop continues — making the ordering guarantee deterministic.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    let firstCall = true;

    node.onTagPriority(
      'prio-test',
      async (msg) => {
        order.push(msg.payload[0]);
        if (firstCall) {
          firstCall = false;
          await firstGate; // keep the drain loop parked until the rest enqueue
        }
      },
      (msg) => msg.payload[0] as MessagePriority,
      20,
    );

    // Send messages with different priorities encoded in payload[0].
    // 3=LOW, 2=NORMAL, 0=CRITICAL, 1=HIGH. The first (3) is popped immediately
    // (queue idle); 2/0/1 queue up behind the parked first handler because
    // drain() is fire-and-forget, so each processMessage() resolves after enqueue.
    const priorities = [3, 2, 0, 1];
    for (const p of priorities) {
      const data = await makeMsg(new Uint8Array([p]));
      await node.processMessage('magic/tag/prio-test', data);
    }

    // All of 2/0/1 are now waiting in the queue; let the drain loop proceed.
    releaseFirst();
    await new Promise(r => setTimeout(r, 100));

    // First message (3) was dequeued immediately since the queue was idle.
    // The remaining waiting messages drain in strict priority order: 0, 1, 2.
    expect(order[0]).toBe(3);
    expect(order.slice(1)).toEqual([0, 1, 2]);
  });

  it('drops lowest priority when queue is full', async () => {
    const received: number[] = [];

    node.onTagPriority(
      'prio-test',
      async (msg) => {
        received.push(msg.payload[0]);
        await new Promise(r => setTimeout(r, 30));
      },
      (msg) => {
        // payload[1] holds the priority value
        return msg.payload[1] as MessagePriority;
      },
      3,
    );

    // Send 6 messages, each with [seq, priority]
    const msgs: [number, number][] = [
      [10, MessagePriority.NORMAL],
      [11, MessagePriority.LOW],
      [12, MessagePriority.CRITICAL],
      [13, MessagePriority.HIGH],
      [14, MessagePriority.LOW],
      [15, MessagePriority.CRITICAL],
    ];

    for (const [seq, prio] of msgs) {
      const data = await makeMsg(new Uint8Array([seq, prio]));
      await node.processMessage('magic/tag/prio-test', data);
    }

    await new Promise(r => setTimeout(r, 500));

    // First message gets immediately processed
    expect(received[0]).toBe(10);
    // LOW priority messages should be dropped first when queue overflows
    expect(received).not.toContain(14);
  });

  it('uses NORMAL priority by default when no assignPriority given', async () => {
    const received: number[] = [];

    node.onTagPriority(
      'prio-test',
      async (msg) => {
        received.push(msg.payload[0]);
      },
    );

    for (let i = 0; i < 3; i++) {
      const data = await makeMsg(new Uint8Array([i]));
      await node.processMessage('magic/tag/prio-test', data);
    }

    await new Promise(r => setTimeout(r, 200));

    // All should be received since default priority is NORMAL (FIFO)
    expect(received).toEqual([0, 1, 2]);
  });
});
