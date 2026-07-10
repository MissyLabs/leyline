import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MagicNode } from '../src/node/magic-node.js';
import { LEYLINE_VERSION } from '../src/config/compat.js';
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
  getSpamFilterInstance() { return this.spamFilter; }
}

describe('MagicNode — handleIncomingMessage pipeline', () => {
  let node: TestableNode;
  let tmpDir: string;
  let senderKeys: Awaited<ReturnType<typeof generateKeypair>>;
  let senderHex: string;

  async function makeMsg(opts?: {
    tags?: string[];
    payload?: Uint8Array;
    keys?: Awaited<ReturnType<typeof generateKeypair>>;
  }) {
    const keys = opts?.keys ?? senderKeys;
    const tags = opts?.tags ?? ['test'];
    const payload = opts?.payload ?? new Uint8Array([1, 2, 3]);
    const msg = await createMessage({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      tags,
      payload,
      type: MessageType.BROADCAST,
    });
    return serializeMessage(msg);
  }

  beforeAll(async () => {
    await initProto();
    senderKeys = await generateKeypair();
    senderHex = publicKeyToHex(senderKeys.publicKey);

    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-pipeline-'));
    node = new TestableNode({
      listenPort: 0,
      subscribedTags: ['test', 'open'],
      seedNodes: [],
      enableWebSocket: false,
      enableRelay: false,
      dataDir: tmpDir,
      rateLimitPerMinute: 60,
      maxInboundPerMinute: 200,
      maxPayloadBytesPerMinute: 1_048_576,
      autoBlockThreshold: 3,
    });
    await node.start();
    await node.allowAgent(senderHex);
  }, 30000);

  afterAll(async () => {
    await node.stop();
    await rm(tmpDir, { recursive: true, force: true });
  }, 15000);

  it('delivers a valid, trusted message', async () => {
    let received = false;
    node.onTag('test', () => { received = true; });

    const data = await makeMsg();
    await node.processMessage('magic/tag/test', data);
    expect(received).toBe(true);
  });

  it('drops messages when paused', async () => {
    let received = false;
    node.onTag('test', () => { received = true; });

    node.pause();
    expect(node.isPaused()).toBe(true);

    const data = await makeMsg({ payload: new Uint8Array([10]) });
    await node.processMessage('magic/tag/test', data);
    expect(received).toBe(false);

    node.resume();
    expect(node.isPaused()).toBe(false);
  });

  it('deduplicates messages by ID', async () => {
    let count = 0;
    node.onTag('test', () => { count++; });

    const data = await makeMsg({ payload: new Uint8Array([20]) });
    await node.processMessage('magic/tag/test', data);
    const first = count;
    await node.processMessage('magic/tag/test', data);
    expect(count).toBe(first); // second call should not increment
  });

  it('blocks untrusted senders', async () => {
    const unknownKeys = await generateKeypair();
    let received = false;
    node.onTag('test', () => { received = true; });

    const data = await makeMsg({ keys: unknownKeys, payload: new Uint8Array([30]) });
    await node.processMessage('magic/tag/test', data);
    expect(received).toBe(false);
  });

  it('drops malformed messages gracefully', async () => {
    let received = false;
    node.onTag('test', () => { received = true; });

    await node.processMessage('magic/tag/test', new Uint8Array([0, 1, 2, 3]));
    expect(received).toBe(false);
  });

  it('open tags allow unknown senders', async () => {
    const unknownKeys = await generateKeypair();
    let received = false;
    node.onTag('open', () => { received = true; });

    await node.allowTagOpen('open');

    const data = await makeMsg({ keys: unknownKeys, tags: ['open'], payload: new Uint8Array([40]) });
    await node.processMessage('magic/tag/open', data);
    expect(received).toBe(true);
  });

  it('blocked agents cannot use open tags', async () => {
    const badKeys = await generateKeypair();
    const badHex = publicKeyToHex(badKeys.publicKey);
    let received = false;
    node.onTag('open', () => { received = true; });

    await node.allowTagOpen('open');
    await node.blockAgent(badHex);

    const data = await makeMsg({ keys: badKeys, tags: ['open'], payload: new Uint8Array([50]) });
    await node.processMessage('magic/tag/open', data);
    expect(received).toBe(false);
  });

  it('fires global onMessage event for valid messages', async () => {
    let eventFired = false;
    const node2tmpDir = await mkdtemp(join(tmpdir(), 'leyline-pipe2-'));
    const node2 = new TestableNode(
      {
        listenPort: 0,
        subscribedTags: ['test'],
        seedNodes: [],
        enableWebSocket: false,
        enableRelay: false,
        dataDir: node2tmpDir,
        rateLimitPerMinute: 60,
        maxInboundPerMinute: 200,
        maxPayloadBytesPerMinute: 1_048_576,
        autoBlockThreshold: 3,
      },
      {
        onMessage: () => { eventFired = true; },
      },
    );
    await node2.start();
    await node2.allowAgent(senderHex);

    const data = await makeMsg({ payload: new Uint8Array([60]) });
    await node2.processMessage('magic/tag/test', data);
    expect(eventFired).toBe(true);

    await node2.stop();
    await rm(node2tmpDir, { recursive: true, force: true });
  });

  it('accessor methods return correct values', () => {
    expect(node.getVersion()).toBe(LEYLINE_VERSION);
    expect(node.getPublicKeyHex()).toHaveLength(64);
    expect(node.getFingerprint()).toHaveLength(16);
    expect(node.getPeerCount()).toBe(0);
    expect(node.getMultiaddrs().length).toBeGreaterThan(0);
    expect(node.getLocalLedger()).toBeDefined();
    expect(node.getSharedLedger()).toBeDefined();
    expect(node.getPeerExchange()).toBeDefined();
    expect(node.getLedgerSync()).toBeDefined();
    expect(node.getDirectMessage()).toBeDefined();
    expect(node.getServiceRegistry()).toBeDefined();
    expect(node.getDiscoveryProtocol()).toBeDefined();
    expect(node.getLedgerConsensus()).toBeDefined();
    expect(node.getHandshake()).toBeDefined();
  });

  it('subscribe and unsubscribe work at runtime', () => {
    node.subscribe('dynamic-tag');
    node.unsubscribe('dynamic-tag');
  });

  it('isTagOpen and getOpenTags reflect state', async () => {
    await node.allowTagOpen('check-tag');
    expect(node.isTagOpen('check-tag')).toBe(true);
    expect(node.getOpenTags()).toContain('check-tag');
    await node.closeTag('check-tag');
    expect(node.isTagOpen('check-tag')).toBe(false);
  });
}, 60000);
