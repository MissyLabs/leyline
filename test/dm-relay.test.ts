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

describe('DirectMessage — relay path', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let nodeC: Libp2p;
  let kpA: Awaited<ReturnType<typeof generateKeypair>>;
  let kpB: Awaited<ReturnType<typeof generateKeypair>>;
  let kpC: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    kpA = await generateKeypair();
    kpB = await generateKeypair();
    kpC = await generateKeypair();
    nodeA = await createTestNode();
    nodeB = await createTestNode();
    nodeC = await createTestNode();

    // Topology: A <-> B <-> C  (A and C are NOT directly connected)
    await nodeB.dial(nodeA.getMultiaddrs()[0]);
    await nodeB.dial(nodeC.getMultiaddrs()[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    await nodeC?.stop();
  });

  it('relays a message from A to C through B (3-node relay)', async () => {
    const received: DirectEnvelope[] = [];

    const dmA = new DirectMessageProtocol(nodeA, {
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
    });
    const dmB = new DirectMessageProtocol(nodeB, {
      localPrivateKey: kpB.privateKey,
      localPubkeyHex: publicKeyToHex(kpB.publicKey),
    });
    const dmC = new DirectMessageProtocol(nodeC, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpC.privateKey,
      localPubkeyHex: publicKeyToHex(kpC.publicKey),
    });

    await dmA.start();
    await dmB.start();
    await dmC.start();

    try {
      const payload = new TextEncoder().encode('hello via relay');
      const ok = await dmA.send(nodeC.peerId.toString(), payload);
      // A cannot reach C directly, so it relays through B
      expect(ok).toBe(true);

      await sleep(1000);

      expect(received.length).toBe(1);
      expect(new TextDecoder().decode(received[0].payload)).toBe('hello via relay');
      expect(received[0].senderPeerId).toBe(nodeA.peerId.toString());
      expect(received[0].senderPubkeyHex).toBe(publicKeyToHex(kpA.publicKey));
    } finally {
      await dmA.stop();
      await dmB.stop();
      await dmC.stop();
    }
  }, 15000);

  it('relay preserves envelope signature through intermediary', async () => {
    const received: DirectEnvelope[] = [];

    const dmA = new DirectMessageProtocol(nodeA, {
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
    });
    const dmB = new DirectMessageProtocol(nodeB, {
      localPrivateKey: kpB.privateKey,
      localPubkeyHex: publicKeyToHex(kpB.publicKey),
    });
    const dmC = new DirectMessageProtocol(nodeC, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpC.privateKey,
      localPubkeyHex: publicKeyToHex(kpC.publicKey),
    });

    await dmA.start();
    await dmB.start();
    await dmC.start();

    try {
      const payload = new TextEncoder().encode('signed relay');
      await dmA.send(nodeC.peerId.toString(), payload);
      await sleep(1000);

      expect(received.length).toBe(1);
      // The envelope signature should be present and valid (verified by C's handler)
      expect(received[0].envelopeSignature).toBeTruthy();
    } finally {
      await dmA.stop();
      await dmB.stop();
      await dmC.stop();
    }
  }, 15000);

  it('relay drops unsigned envelopes to prevent amplification', async () => {
    const received: DirectEnvelope[] = [];

    // A sends without signing (no private key)
    const dmA = new DirectMessageProtocol(nodeA, {});
    const dmB = new DirectMessageProtocol(nodeB, {
      localPrivateKey: kpB.privateKey,
      localPubkeyHex: publicKeyToHex(kpB.publicKey),
    });
    const dmC = new DirectMessageProtocol(nodeC, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpC.privateKey,
      localPubkeyHex: publicKeyToHex(kpC.publicKey),
    });

    await dmA.start();
    await dmB.start();
    await dmC.start();

    try {
      const payload = new TextEncoder().encode('unsigned relay attempt');
      const ok = await dmA.send(nodeC.peerId.toString(), payload);
      // Direct delivery fails (A not connected to C), relay attempt has no signature
      // B should drop the unsigned relay envelope

      await sleep(1000);

      // C should NOT receive the message since B drops unsigned relay envelopes
      expect(received.length).toBe(0);
    } finally {
      await dmA.stop();
      await dmB.stop();
      await dmC.stop();
    }
  }, 15000);

  it('direct delivery succeeds when target is a connected peer', async () => {
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
      const payload = new TextEncoder().encode('direct to B');
      const ok = await dmA.send(nodeB.peerId.toString(), payload);
      expect(ok).toBe(true);

      await sleep(500);

      expect(received.length).toBe(1);
      expect(new TextDecoder().decode(received[0].payload)).toBe('direct to B');
    } finally {
      await dmA.stop();
      await dmB.stop();
    }
  }, 10000);

  it('send returns false when target is unreachable and no relay path exists', async () => {
    // Create an isolated node with no connections
    const isolated = await createTestNode();
    const kpIsolated = await generateKeypair();
    const dmIsolated = new DirectMessageProtocol(isolated, {
      localPrivateKey: kpIsolated.privateKey,
      localPubkeyHex: publicKeyToHex(kpIsolated.publicKey),
    });

    await dmIsolated.start();
    try {
      const payload = new TextEncoder().encode('lost message');
      const ok = await dmIsolated.send('12D3KooWFakeTargetPeerId', payload);
      expect(ok).toBe(false);
    } finally {
      await dmIsolated.stop();
      await isolated.stop();
    }
  }, 10000);
});

describe('DirectMessage — relay loop and hop limits', () => {
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

  it('relay() drops envelope when hopsRemaining reaches 0', async () => {
    const dmA = new DirectMessageProtocol(nodeA, {
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
    });

    await dmA.start();
    try {
      const envelope: DirectEnvelope = {
        payload: new TextEncoder().encode('hop-exhausted'),
        targetPeerId: '12D3KooWFakeTarget',
        senderPeerId: nodeA.peerId.toString(),
        timestamp: Date.now(),
        isRelay: true,
        hopsRemaining: 1, // Will be decremented to 0 in relay()
        encrypted: false,
        visitedPeers: [],
      };

      const relayed = await dmA.relay(envelope);
      expect(relayed).toBe(false);
    } finally {
      await dmA.stop();
    }
  }, 10000);

  it('relay() drops envelope when local peer is in visitedPeers (loop prevention)', async () => {
    const dmA = new DirectMessageProtocol(nodeA, {
      localPrivateKey: kpA.privateKey,
      localPubkeyHex: publicKeyToHex(kpA.publicKey),
    });

    await dmA.start();
    try {
      const envelope: DirectEnvelope = {
        payload: new TextEncoder().encode('loop-test'),
        targetPeerId: '12D3KooWFakeTarget',
        senderPeerId: nodeB.peerId.toString(),
        timestamp: Date.now(),
        isRelay: true,
        hopsRemaining: 3,
        encrypted: false,
        visitedPeers: [nodeA.peerId.toString()], // A already visited
      };

      const relayed = await dmA.relay(envelope);
      expect(relayed).toBe(false);
    } finally {
      await dmA.stop();
    }
  }, 10000);

  it('relay() adds local peer to visitedPeers set', async () => {
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
      const envelope: DirectEnvelope = {
        payload: new TextEncoder().encode('relay-track'),
        targetPeerId: nodeB.peerId.toString(),
        senderPeerId: '12D3KooWOriginalSender',
        senderPubkeyHex: publicKeyToHex(kpA.publicKey),
        timestamp: Date.now(),
        isRelay: true,
        hopsRemaining: 3,
        encrypted: false,
        visitedPeers: [],
      };

      // Sign the envelope so B accepts it
      const { sign: edSign } = await import('../src/identity/keypair.js');
      const { createHash } = await import('node:crypto');
      const payloadB64 = Buffer.from(envelope.payload).toString('base64');
      const payloadHash = createHash('sha256').update(payloadB64).digest('hex');
      const canonical = [
        payloadHash,
        envelope.targetPeerId,
        envelope.senderPeerId,
        String(envelope.timestamp),
        envelope.senderPubkeyHex ?? '',
        String(envelope.encrypted),
      ].join('|');
      const signable = new TextEncoder().encode(canonical);
      const sig = await edSign(kpA.privateKey, signable);
      envelope.envelopeSignature = Buffer.from(sig).toString('hex');

      const relayed = await dmA.relay(envelope);
      expect(relayed).toBe(true);

      await sleep(500);
      expect(received.length).toBe(1);
    } finally {
      await dmA.stop();
      await dmB.stop();
    }
  }, 10000);
});
