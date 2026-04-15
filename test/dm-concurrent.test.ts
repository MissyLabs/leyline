import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { generateKeypair, publicKeyToHex } from '../src/identity/keypair.js';
import {
  DirectMessageProtocol,
  type DirectEnvelope,
} from '../src/node/direct-message.js';

async function createTestNode() {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('DirectMessage — concurrent DM handling', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let kpA: Awaited<ReturnType<typeof generateKeypair>>;
  let kpB: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    kpA = await generateKeypair();
    kpB = await generateKeypair();
    nodeA = await createTestNode();
    nodeB = await createTestNode();
    await nodeA.dial(nodeB.getMultiaddrs()[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('handles 10 concurrent DMs without data corruption', async () => {
    const received: DirectEnvelope[] = [];

    const dmA = new DirectMessageProtocol(nodeA, {
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
    });
    const dmB = new DirectMessageProtocol(nodeB, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpB.privateKey,
      localPubkeyHex: publicKeyToHex(kpB.publicKey),
    });

    await dmA.start();
    await dmB.start();

    try {
      const count = 10;
      const promises = Array.from({ length: count }, (_, i) => {
        const payload = new TextEncoder().encode(`concurrent-${i}`);
        return dmA.send(nodeB.peerId.toString(), payload);
      });

      const results = await Promise.all(promises);
      expect(results.every(r => r === true)).toBe(true);

      await sleep(2000);

      expect(received.length).toBe(count);
      const payloads = received.map(e => new TextDecoder().decode(e.payload)).sort();
      const expected = Array.from({ length: count }, (_, i) => `concurrent-${i}`).sort();
      expect(payloads).toEqual(expected);
    } finally {
      await dmA.stop();
      await dmB.stop();
    }
  }, 15000);

  it('handles bidirectional concurrent DMs', async () => {
    const receivedByA: DirectEnvelope[] = [];
    const receivedByB: DirectEnvelope[] = [];

    const dmA = new DirectMessageProtocol(nodeA, {
      onMessage: (env) => receivedByA.push(env),
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
    });
    const dmB = new DirectMessageProtocol(nodeB, {
      onMessage: (env) => receivedByB.push(env),
      localPrivateKey: kpB.privateKey,
      localPubkeyHex: publicKeyToHex(kpB.publicKey),
    });

    await dmA.start();
    await dmB.start();

    try {
      const [resAtoB, resBtoA] = await Promise.all([
        dmA.send(nodeB.peerId.toString(), new TextEncoder().encode('from-A')),
        dmB.send(nodeA.peerId.toString(), new TextEncoder().encode('from-B')),
      ]);

      expect(resAtoB).toBe(true);
      expect(resBtoA).toBe(true);

      await sleep(1000);

      expect(receivedByA.length).toBe(1);
      expect(receivedByB.length).toBe(1);
      expect(new TextDecoder().decode(receivedByA[0].payload)).toBe('from-B');
      expect(new TextDecoder().decode(receivedByB[0].payload)).toBe('from-A');
    } finally {
      await dmA.stop();
      await dmB.stop();
    }
  }, 10000);

  it('DM with empty payload', async () => {
    const received: DirectEnvelope[] = [];

    const dmA = new DirectMessageProtocol(nodeA, {
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
    });
    const dmB = new DirectMessageProtocol(nodeB, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpB.privateKey,
      localPubkeyHex: publicKeyToHex(kpB.publicKey),
    });

    await dmA.start();
    await dmB.start();

    try {
      const ok = await dmA.send(nodeB.peerId.toString(), new Uint8Array(0));
      expect(ok).toBe(true);

      await sleep(500);

      expect(received.length).toBe(1);
      expect(received[0].payload.length).toBe(0);
    } finally {
      await dmA.stop();
      await dmB.stop();
    }
  }, 10000);

  it('DM with max-size payload', async () => {
    const received: DirectEnvelope[] = [];

    const dmA = new DirectMessageProtocol(nodeA, {
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
    });
    const dmB = new DirectMessageProtocol(nodeB, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpB.privateKey,
      localPubkeyHex: publicKeyToHex(kpB.publicKey),
    });

    await dmA.start();
    await dmB.start();

    try {
      // 64KB payload — well within the 256KB DM envelope limit
      const largePayload = new Uint8Array(65536).fill(42);
      const ok = await dmA.send(nodeB.peerId.toString(), largePayload);
      expect(ok).toBe(true);

      await sleep(1000);

      expect(received.length).toBe(1);
      expect(received[0].payload.length).toBe(65536);
      expect(received[0].payload[0]).toBe(42);
    } finally {
      await dmA.stop();
      await dmB.stop();
    }
  }, 15000);
});
