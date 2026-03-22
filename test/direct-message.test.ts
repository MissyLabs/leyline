import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { generateKeypair, publicKeyToHex } from '../src/identity/keypair.js';
import { DirectMessageProtocol, type DirectEnvelope } from '../src/node/direct-message.js';

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

describe('DirectMessageProtocol', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let nodeC: Libp2p;
  let kpA: Awaited<ReturnType<typeof generateKeypair>>;
  let kpB: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    kpA = await generateKeypair();
    kpB = await generateKeypair();
    nodeA = await createTestNode();
    nodeB = await createTestNode();
    nodeC = await createTestNode();

    // Connect A <-> B and B <-> C
    await nodeB.dial(nodeA.getMultiaddrs()[0]);
    await nodeC.dial(nodeB.getMultiaddrs()[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    await nodeC?.stop();
  });

  it('delivers a cleartext direct message between two peers', async () => {
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

    const payload = new TextEncoder().encode('hello B');
    const ok = await dmA.send(nodeB.peerId.toString(), payload);
    expect(ok).toBe(true);

    await sleep(500);

    expect(received.length).toBe(1);
    expect(new TextDecoder().decode(received[0].payload)).toBe('hello B');
    expect(received[0].encrypted).toBe(false);

    await dmA.stop();
    await dmB.stop();
  }, 10000);

  it('delivers an encrypted direct message using X25519', async () => {
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

    const payload = new TextEncoder().encode('secret message');
    const recipientPubHex = publicKeyToHex(kpB.publicKey);
    const ok = await dmA.send(nodeB.peerId.toString(), payload, recipientPubHex);
    expect(ok).toBe(true);

    await sleep(500);

    expect(received.length).toBe(1);
    // Payload should be decrypted on arrival
    expect(new TextDecoder().decode(received[0].payload)).toBe('secret message');

    await dmA.stop();
    await dmB.stop();
  }, 10000);

  it('returns false when target peer is unreachable', async () => {
    const dmA = new DirectMessageProtocol(nodeA, {
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
    });
    await dmA.start();

    const payload = new TextEncoder().encode('hello');
    const ok = await dmA.send('nonexistent-peer-id', payload);
    expect(ok).toBe(false);

    await dmA.stop();
  }, 10000);
});
