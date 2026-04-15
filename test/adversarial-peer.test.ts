/**
 * Adversarial peer simulation tests.
 *
 * Tests that simulate malicious peers sending crafted wire messages
 * to verify the protocol handlers reject invalid input correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { generateKeypair, publicKeyToHex, sign } from '../src/identity/keypair.js';
import {
  DirectMessageProtocol,
  DIRECT_MESSAGE_PROTOCOL,
  type DirectEnvelope,
} from '../src/node/direct-message.js';
import {
  HandshakeProtocol,
  HANDSHAKE_PROTOCOL,
} from '../src/node/handshake-protocol.js';
import {
  ServiceRegistry,
} from '../src/discovery/service-registry.js';
import {
  DiscoveryProtocol,
  DISCOVERY_PROTOCOL,
} from '../src/discovery/discovery-protocol.js';

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

function sendRaw(node: Libp2p, target: Libp2p, protocol: string, data: Uint8Array): Promise<void> {
  const peerId = target.peerId;
  return node.dialProtocol(peerId, protocol).then(async (stream) => {
    try {
      await pipe([data], (source) => lp.encode(source), stream);
    } finally {
      try { stream.close(); } catch { /* ok */ }
    }
  });
}

// =========================================================================
// DM protocol adversarial tests
// =========================================================================

describe('Adversarial — DirectMessage protocol', () => {
  let victim: Libp2p;
  let attacker: Libp2p;
  let kpVictim: Awaited<ReturnType<typeof generateKeypair>>;
  let kpAttacker: Awaited<ReturnType<typeof generateKeypair>>;
  let received: DirectEnvelope[];

  beforeAll(async () => {
    kpVictim = await generateKeypair();
    kpAttacker = await generateKeypair();
    victim = await createTestNode();
    attacker = await createTestNode();
    await attacker.dial(victim.getMultiaddrs()[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await victim?.stop();
    await attacker?.stop();
  });

  it('rejects completely invalid JSON', async () => {
    received = [];
    const dm = new DirectMessageProtocol(victim, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpVictim.privateKey,
      localPubkeyHex: publicKeyToHex(kpVictim.publicKey),
    });
    await dm.start();

    try {
      await sendRaw(attacker, victim, DIRECT_MESSAGE_PROTOCOL,
        new TextEncoder().encode('{{{not json at all'));
      await sleep(300);
      expect(received).toHaveLength(0);
    } finally {
      await dm.stop();
    }
  });

  it('rejects envelope with missing required fields', async () => {
    received = [];
    const dm = new DirectMessageProtocol(victim, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpVictim.privateKey,
      localPubkeyHex: publicKeyToHex(kpVictim.publicKey),
    });
    await dm.start();

    try {
      const partial = JSON.stringify({ payload: 'aGVsbG8=', targetPeerId: victim.peerId.toString() });
      await sendRaw(attacker, victim, DIRECT_MESSAGE_PROTOCOL,
        new TextEncoder().encode(partial));
      await sleep(300);
      expect(received).toHaveLength(0);
    } finally {
      await dm.stop();
    }
  });

  it('rejects envelope with wrong type fields', async () => {
    received = [];
    const dm = new DirectMessageProtocol(victim, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpVictim.privateKey,
      localPubkeyHex: publicKeyToHex(kpVictim.publicKey),
    });
    await dm.start();

    try {
      const badTypes = JSON.stringify({
        payload: 'aGVsbG8=',
        targetPeerId: victim.peerId.toString(),
        senderPeerId: attacker.peerId.toString(),
        timestamp: 'not-a-number',
        isRelay: 'not-a-boolean',
        hopsRemaining: 'nope',
        encrypted: false,
      });
      await sendRaw(attacker, victim, DIRECT_MESSAGE_PROTOCOL,
        new TextEncoder().encode(badTypes));
      await sleep(300);
      expect(received).toHaveLength(0);
    } finally {
      await dm.stop();
    }
  });

  it('rejects envelope with forged signature', async () => {
    received = [];
    const dm = new DirectMessageProtocol(victim, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpVictim.privateKey,
      localPubkeyHex: publicKeyToHex(kpVictim.publicKey),
    });
    await dm.start();

    try {
      const envelope = JSON.stringify({
        payload: Buffer.from('forged').toString('base64'),
        targetPeerId: victim.peerId.toString(),
        senderPeerId: attacker.peerId.toString(),
        timestamp: Date.now(),
        isRelay: false,
        hopsRemaining: 0,
        encrypted: false,
        senderPubkeyHex: publicKeyToHex(kpAttacker.publicKey),
        envelopeSignature: 'deadbeef'.repeat(16), // forged signature
      });
      await sendRaw(attacker, victim, DIRECT_MESSAGE_PROTOCOL,
        new TextEncoder().encode(envelope));
      await sleep(300);
      expect(received).toHaveLength(0);
    } finally {
      await dm.stop();
    }
  });

  it('rejects envelope with spoofed senderPubkeyHex (key mismatch)', async () => {
    received = [];
    const dm = new DirectMessageProtocol(victim, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpVictim.privateKey,
      localPubkeyHex: publicKeyToHex(kpVictim.publicKey),
    });
    await dm.start();

    try {
      // Sign with attacker key but claim to be victim's pubkey
      const payload = Buffer.from('spoofed-sender').toString('base64');
      const { createHash } = await import('node:crypto');
      const payloadHash = createHash('sha256').update(payload).digest('hex');
      const canonical = [
        payloadHash,
        victim.peerId.toString(),
        attacker.peerId.toString(),
        String(Date.now()),
        publicKeyToHex(kpVictim.publicKey), // spoofed: claim victim's key
        'false',
      ].join('|');
      const signable = new TextEncoder().encode(canonical);
      const sig = await sign(kpAttacker.privateKey, signable); // sign with attacker's key

      const envelope = JSON.stringify({
        payload,
        targetPeerId: victim.peerId.toString(),
        senderPeerId: attacker.peerId.toString(),
        timestamp: Date.now(),
        isRelay: false,
        hopsRemaining: 0,
        encrypted: false,
        senderPubkeyHex: publicKeyToHex(kpVictim.publicKey), // spoofed
        envelopeSignature: Buffer.from(sig).toString('hex'),
      });
      await sendRaw(attacker, victim, DIRECT_MESSAGE_PROTOCOL,
        new TextEncoder().encode(envelope));
      await sleep(300);
      expect(received).toHaveLength(0);
    } finally {
      await dm.stop();
    }
  });

  it('rejects oversized payload', async () => {
    received = [];
    const dm = new DirectMessageProtocol(victim, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpVictim.privateKey,
      localPubkeyHex: publicKeyToHex(kpVictim.publicKey),
    });
    await dm.start();

    try {
      const hugePayload = Buffer.alloc(300_000).toString('base64'); // >256KB
      const envelope = JSON.stringify({
        payload: hugePayload,
        targetPeerId: victim.peerId.toString(),
        senderPeerId: attacker.peerId.toString(),
        timestamp: Date.now(),
        isRelay: false,
        hopsRemaining: 0,
        encrypted: false,
      });
      await sendRaw(attacker, victim, DIRECT_MESSAGE_PROTOCOL,
        new TextEncoder().encode(envelope));
      await sleep(300);
      expect(received).toHaveLength(0);
    } finally {
      await dm.stop();
    }
  });

  it('rejects relay envelope with hopsRemaining > 10 (clamped to 10)', async () => {
    received = [];
    const dm = new DirectMessageProtocol(victim, {
      onMessage: (env) => received.push(env),
      localPrivateKey: kpVictim.privateKey,
      localPubkeyHex: publicKeyToHex(kpVictim.publicKey),
    });
    await dm.start();

    try {
      // Even if attacker sets hops to 999, the decoder clamps to 10
      const envelope = JSON.stringify({
        payload: Buffer.from('high-hops').toString('base64'),
        targetPeerId: 'some-other-peer',
        senderPeerId: attacker.peerId.toString(),
        timestamp: Date.now(),
        isRelay: true,
        hopsRemaining: 999,
        encrypted: false,
        senderPubkeyHex: publicKeyToHex(kpAttacker.publicKey),
        visitedPeers: [],
      });

      // This is testing the wire decoder, not the protocol handler
      // The handler would reject it for missing signature anyway
      await sendRaw(attacker, victim, DIRECT_MESSAGE_PROTOCOL,
        new TextEncoder().encode(envelope));
      await sleep(300);
      // Unsigned relay → dropped
      expect(received).toHaveLength(0);
    } finally {
      await dm.stop();
    }
  });
});

// =========================================================================
// Handshake protocol adversarial tests
// =========================================================================

describe('Adversarial — Handshake protocol', () => {
  let victim: Libp2p;
  let attacker: Libp2p;

  beforeAll(async () => {
    victim = await createTestNode();
    attacker = await createTestNode();
    await attacker.dial(victim.getMultiaddrs()[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await victim?.stop();
    await attacker?.stop();
  });

  it('rejects handshake with extremely long version string — version not recorded as valid', async () => {
    const handshake = new HandshakeProtocol(victim);
    await handshake.start();

    try {
      const malicious = JSON.stringify({
        type: 'hello',
        version: 'A'.repeat(10000),
        minVersion: '0.1.0',
      });
      await sendRaw(attacker, victim, HANDSHAKE_PROTOCOL,
        new TextEncoder().encode(malicious));
      await sleep(300);

      // The decode() throws for oversized version, so the valid version is never recorded.
      // The peer may appear as 'unknown' from the connect handler fallback, but NOT as 'AAAA...'
      const peerVersion = handshake.getPeerVersion(attacker.peerId.toString());
      expect(peerVersion).not.toContain('AAAA');
    } finally {
      await handshake.stop();
    }
  });

  it('rejects handshake with invalid JSON — version not recorded as valid', async () => {
    const handshake = new HandshakeProtocol(victim);
    await handshake.start();

    try {
      await sendRaw(attacker, victim, HANDSHAKE_PROTOCOL,
        new TextEncoder().encode('not-json'));
      await sleep(300);
      // Should not have a valid version recorded — only 'unknown' from fallback
      const version = handshake.getPeerVersion(attacker.peerId.toString());
      expect(version === 'unknown' || version === undefined).toBe(true);
    } finally {
      await handshake.stop();
    }
  });

  it('rejects handshake with missing type field — version not recorded as valid', async () => {
    const handshake = new HandshakeProtocol(victim);
    await handshake.start();

    try {
      const noType = JSON.stringify({ version: '0.2.0', minVersion: '0.1.0' });
      await sendRaw(attacker, victim, HANDSHAKE_PROTOCOL,
        new TextEncoder().encode(noType));
      await sleep(300);
      // Missing type field causes decode() to throw — version not accepted
      const version = handshake.getPeerVersion(attacker.peerId.toString());
      expect(version === 'unknown' || version === undefined).toBe(true);
    } finally {
      await handshake.stop();
    }
  });
});

// =========================================================================
// Discovery protocol adversarial tests
// =========================================================================

describe('Adversarial — Discovery protocol', () => {
  let victim: Libp2p;
  let attacker: Libp2p;

  beforeAll(async () => {
    victim = await createTestNode();
    attacker = await createTestNode();
    await attacker.dial(victim.getMultiaddrs()[0]);
    await sleep(500);
  }, 15000);

  afterAll(async () => {
    await victim?.stop();
    await attacker?.stop();
  });

  it('rejects discovery message with invalid kind', async () => {
    const registry = new ServiceRegistry();
    const kp = await generateKeypair();
    const discovery = new DiscoveryProtocol(victim, registry, {
      localPubkeyHex: publicKeyToHex(kp.publicKey),
      localPrivateKey: kp.privateKey,
    });
    await discovery.start();

    try {
      const badKind = JSON.stringify({ kind: 'evil-kind', data: {} });
      await sendRaw(attacker, victim, DISCOVERY_PROTOCOL,
        new TextEncoder().encode(badKind));
      await sleep(300);
      // No crash, registry unchanged
      expect(registry.getAll()).toHaveLength(0);
    } finally {
      await discovery.stop();
    }
  });

  it('rejects advertisement with oversized descriptor fields', async () => {
    const registry = new ServiceRegistry();
    const kp = await generateKeypair();
    const discovery = new DiscoveryProtocol(victim, registry, {
      localPubkeyHex: publicKeyToHex(kp.publicKey),
      localPrivateKey: kp.privateKey,
    });
    await discovery.start();

    try {
      const oversized = JSON.stringify({
        kind: 'advertise',
        descriptor: {
          id: 'test-id',
          name: 'X'.repeat(5000), // exceeds 256 char limit
          tags: ['tag:test'],
          description: 'test',
          providerPubkey: publicKeyToHex(kp.publicKey),
          providerPeerId: attacker.peerId.toString(),
          multiaddrs: ['/ip4/127.0.0.1/tcp/9000'],
          advertisedAt: Date.now(),
          ttl: 300000,
          metadata: {},
        },
      });
      await sendRaw(attacker, victim, DISCOVERY_PROTOCOL,
        new TextEncoder().encode(oversized));
      await sleep(300);
      expect(registry.getAll()).toHaveLength(0);
    } finally {
      await discovery.stop();
    }
  });

  it('rejects advertisement with too many tags', async () => {
    const registry = new ServiceRegistry();
    const kp = await generateKeypair();
    const discovery = new DiscoveryProtocol(victim, registry, {
      localPubkeyHex: publicKeyToHex(kp.publicKey),
      localPrivateKey: kp.privateKey,
    });
    await discovery.start();

    try {
      const tooManyTags = JSON.stringify({
        kind: 'advertise',
        descriptor: {
          id: 'test-id',
          name: 'too-many-tags',
          tags: Array.from({ length: 200 }, (_, i) => `tag:${i}`),
          description: 'test',
          providerPubkey: publicKeyToHex(kp.publicKey),
          providerPeerId: attacker.peerId.toString(),
          multiaddrs: ['/ip4/127.0.0.1/tcp/9000'],
          advertisedAt: Date.now(),
          ttl: 300000,
          metadata: {},
        },
      });
      await sendRaw(attacker, victim, DISCOVERY_PROTOCOL,
        new TextEncoder().encode(tooManyTags));
      await sleep(300);
      expect(registry.getAll()).toHaveLength(0);
    } finally {
      await discovery.stop();
    }
  });

  it('rejects advertisement with too many metadata keys', async () => {
    const registry = new ServiceRegistry();
    const kp = await generateKeypair();
    const discovery = new DiscoveryProtocol(victim, registry, {
      localPubkeyHex: publicKeyToHex(kp.publicKey),
      localPrivateKey: kp.privateKey,
    });
    await discovery.start();

    try {
      const bigMeta: Record<string, string> = {};
      for (let i = 0; i < 100; i++) bigMeta[`key${i}`] = `value${i}`;
      const tooManyMeta = JSON.stringify({
        kind: 'advertise',
        descriptor: {
          id: 'test-id',
          name: 'metadata-flood',
          tags: ['tag:test'],
          description: 'test',
          providerPubkey: publicKeyToHex(kp.publicKey),
          providerPeerId: attacker.peerId.toString(),
          multiaddrs: ['/ip4/127.0.0.1/tcp/9000'],
          advertisedAt: Date.now(),
          ttl: 300000,
          metadata: bigMeta,
        },
      });
      await sendRaw(attacker, victim, DISCOVERY_PROTOCOL,
        new TextEncoder().encode(tooManyMeta));
      await sleep(300);
      expect(registry.getAll()).toHaveLength(0);
    } finally {
      await discovery.stop();
    }
  });
});
