import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import {
  MessageBuffer,
  InboxServer,
  InboxClient,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    },
  } as Parameters<typeof createLibp2p>[0]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeData(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

function makeId(label: string): string {
  // Simple deterministic ID for test fixtures
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

// ---------------------------------------------------------------------------
// InboxClient unit tests (no libp2p required)
// ---------------------------------------------------------------------------

describe('InboxClient – markReceived / getLastReceivedAt', () => {
  let node: Libp2p;
  let client: InboxClient;

  beforeAll(async () => {
    node = await createTestNode();
    client = new InboxClient(node);
  });

  afterAll(async () => {
    await node?.stop();
  });

  it('starts with lastReceivedAt of 0', () => {
    expect(client.getLastReceivedAt()).toBe(0);
  });

  it('markReceived updates the timestamp', () => {
    client.markReceived(1_000_000);
    expect(client.getLastReceivedAt()).toBe(1_000_000);
  });

  it('markReceived only advances the timestamp, never moves it back', () => {
    client.markReceived(500_000); // older than current
    expect(client.getLastReceivedAt()).toBe(1_000_000);
  });

  it('markReceived advances when given a newer timestamp', () => {
    client.markReceived(2_000_000);
    expect(client.getLastReceivedAt()).toBe(2_000_000);
  });
});

describe('InboxClient.fetch – unknown peer returns empty array', () => {
  let node: Libp2p;
  let client: InboxClient;

  beforeAll(async () => {
    node = await createTestNode();
    client = new InboxClient(node);
  });

  afterAll(async () => {
    await node?.stop();
  });

  it('returns empty array when peerId is not connected', async () => {
    const result = await client.fetch(
      '12D3KooWFakeUnknownPeerIdThatIsDefinitelyNotConnected',
      ['magic/tag/test'],
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MessageBuffer unit tests
// ---------------------------------------------------------------------------

describe('MessageBuffer', () => {
  it('push stores a message and getForTopics retrieves it', () => {
    const buf = new MessageBuffer();
    const data = makeData('hello');
    const id = makeId('msg-1');

    buf.push('topic-a', data, id);

    const msgs = buf.getForTopics(['topic-a']);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].topic).toBe('topic-a');
    expect(msgs[0].id).toBe(id);
  });

  it('getForTopics respects the since filter', async () => {
    const buf = new MessageBuffer();

    buf.push('topic-b', makeData('old'), makeId('old-msg'));
    const pivot = Date.now();
    await sleep(5); // ensure receivedAt is strictly after pivot
    buf.push('topic-b', makeData('new'), makeId('new-msg'));

    const all = buf.getForTopics(['topic-b'], 0);
    expect(all).toHaveLength(2);

    const afterPivot = buf.getForTopics(['topic-b'], pivot);
    expect(afterPivot).toHaveLength(1);
    expect(afterPivot[0].id).toBe(makeId('new-msg'));
  });

  it('getForTopics only returns messages for requested topics', () => {
    const buf = new MessageBuffer();
    buf.push('topic-x', makeData('x'), makeId('msg-x'));
    buf.push('topic-y', makeData('y'), makeId('msg-y'));

    const results = buf.getForTopics(['topic-x']);
    expect(results).toHaveLength(1);
    expect(results[0].topic).toBe('topic-x');
  });

  it('getForTopics returns empty array for unknown topic', () => {
    const buf = new MessageBuffer();
    expect(buf.getForTopics(['topic-nonexistent'])).toHaveLength(0);
  });

  it('deduplicates messages with the same id', () => {
    const buf = new MessageBuffer();
    const id = makeId('dup-msg');
    buf.push('topic-c', makeData('first'), id);
    buf.push('topic-c', makeData('second'), id);

    expect(buf.getForTopics(['topic-c'])).toHaveLength(1);
  });

  it('returns messages sorted chronologically (oldest first)', async () => {
    const buf = new MessageBuffer();
    for (let i = 0; i < 5; i++) {
      await sleep(2);
      buf.push('topic-d', makeData(`msg-${i}`), makeId(`sorted-${i}`));
    }

    const msgs = buf.getForTopics(['topic-d']);
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].receivedAt).toBeGreaterThanOrEqual(msgs[i - 1].receivedAt);
    }
  });

  it('getBufferedTopics lists topics with messages', () => {
    const buf = new MessageBuffer();
    buf.push('topic-e', makeData('e'), makeId('e'));
    buf.push('topic-f', makeData('f'), makeId('f'));

    const topics = buf.getBufferedTopics();
    expect(topics).toContain('topic-e');
    expect(topics).toContain('topic-f');
  });
});

// ---------------------------------------------------------------------------
// Full integration: InboxServer + InboxClient over real libp2p connections
// ---------------------------------------------------------------------------

describe('InboxServer / InboxClient – integration', () => {
  let serverNode: Libp2p;
  let clientNode: Libp2p;
  let buffer: MessageBuffer;
  let server: InboxServer;
  let client: InboxClient;

  const TOPIC_A = 'magic/tag/channel-a';
  const TOPIC_B = 'magic/tag/channel-b';

  beforeAll(async () => {
    serverNode = await createTestNode();
    clientNode = await createTestNode();

    buffer = new MessageBuffer({ pruneIntervalMs: 60_000 });

    // Pre-populate the buffer with test messages
    buffer.push(TOPIC_A, makeData('msg-a1'), makeId('a1'));
    buffer.push(TOPIC_A, makeData('msg-a2'), makeId('a2'));
    buffer.push(TOPIC_B, makeData('msg-b1'), makeId('b1'));

    server = new InboxServer(serverNode, buffer);
    client = new InboxClient(clientNode);

    await server.start();

    // Connect client to server
    await clientNode.dial(serverNode.getMultiaddrs()[0]);
    await sleep(500);
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    await serverNode?.stop();
    await clientNode?.stop();
  });

  it('fetches messages for a requested topic', async () => {
    const messages = await client.fetch(
      serverNode.peerId.toString(),
      [TOPIC_A],
      0,
      200,
    );

    expect(messages.length).toBe(2);
    const ids = messages.map((m) => m.id);
    expect(ids).toContain(makeId('a1'));
    expect(ids).toContain(makeId('a2'));
  }, 10000);

  it('server respects the topic filter — only returns requested topics', async () => {
    // Request only TOPIC_B; should not receive TOPIC_A messages
    const messages = await client.fetch(
      serverNode.peerId.toString(),
      [TOPIC_B],
      0,
      200,
    );

    expect(messages.every((m) => m.topic === TOPIC_B)).toBe(true);
    const ids = messages.map((m) => m.id);
    expect(ids).not.toContain(makeId('a1'));
    expect(ids).not.toContain(makeId('a2'));
    expect(ids).toContain(makeId('b1'));
  }, 10000);

  it('server respects the since timestamp filter', async () => {
    // Add a message with a known later timestamp
    await sleep(10);
    const afterPivot = Date.now();
    await sleep(10);
    buffer.push(TOPIC_A, makeData('msg-a3-new'), makeId('a3-new'));

    const messages = await client.fetch(
      serverNode.peerId.toString(),
      [TOPIC_A],
      afterPivot,
      200,
    );

    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe(makeId('a3-new'));
  }, 10000);

  it('server respects the limit parameter', async () => {
    // Buffer has at least 3 TOPIC_A messages now (a1, a2, a3-new)
    const messages = await client.fetch(
      serverNode.peerId.toString(),
      [TOPIC_A],
      0,
      1, // limit = 1
    );

    expect(messages.length).toBe(1);
  }, 10000);

  it('fetch returns empty array when the topic has no buffered messages', async () => {
    const messages = await client.fetch(
      serverNode.peerId.toString(),
      ['magic/tag/completely-unknown-topic'],
      0,
      200,
    );

    expect(messages).toEqual([]);
  }, 10000);

  it('reconstructed messages have correct data bytes', async () => {
    const messages = await client.fetch(
      serverNode.peerId.toString(),
      [TOPIC_B],
      0,
      200,
    );

    expect(messages.length).toBeGreaterThan(0);
    const decoded = new TextDecoder().decode(messages[0].data);
    expect(decoded).toBe('msg-b1');
  }, 10000);

  it('fetchFromAllPeers deduplicates messages from multiple seeds', async () => {
    // With a single connected peer, fetchFromAllPeers should return the same
    // set as a direct fetch — dedup means no duplicates if the same peer is
    // called only once.
    const direct = await client.fetch(
      serverNode.peerId.toString(),
      [TOPIC_A],
      0,
      200,
    );
    const fromAll = await client.fetchFromAllPeers([TOPIC_A], 0);

    const directIds = new Set(direct.map((m) => m.id));
    const allIds = new Set(fromAll.map((m) => m.id));

    // Every message from fetchFromAllPeers must appear in the direct fetch
    for (const id of allIds) {
      expect(directIds.has(id)).toBe(true);
    }

    // No duplicate IDs in the result
    expect(fromAll.length).toBe(allIds.size);
  }, 10000);
});
