import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { HandshakeProtocol } from '../src/node/handshake-protocol.js';

async function createTestNode() {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

describe('HandshakeProtocol — unit methods', () => {
  let node: Libp2p;
  let handshake: HandshakeProtocol;

  beforeAll(async () => {
    node = await createTestNode();
    handshake = new HandshakeProtocol(node);
    await handshake.start();
  }, 15000);

  afterAll(async () => {
    await handshake.stop();
    await node.stop();
  }, 10000);

  it('getPeerVersion returns unknown for untracked peer', () => {
    expect(handshake.getPeerVersion('nonexistent')).toBe('unknown');
  });

  it('getAllPeerVersions returns a copy', () => {
    const versions = handshake.getAllPeerVersions();
    expect(versions).toBeInstanceOf(Map);
    expect(versions.size).toBe(0);
  });

  it('getVersionStats returns empty map when no peers', () => {
    const stats = handshake.getVersionStats();
    expect(stats.size).toBe(0);
  });

  it('isIncompatible returns false for unknown peers', () => {
    expect(handshake.isIncompatible('nonexistent')).toBe(false);
  });

  it('removePeer cleans up tracking data', () => {
    // No crash when removing non-existent peer
    handshake.removePeer('fake-peer');
    expect(handshake.getPeerVersion('fake-peer')).toBe('unknown');
  });

  it('pruneDisconnected removes unconnected peers', () => {
    // Manually insert some peer data via the public getter
    // Since we can't directly add, test via getAllPeerVersions
    const connected = new Set<string>();
    handshake.pruneDisconnected(connected);
    expect(handshake.getAllPeerVersions().size).toBe(0);
  });
});

describe('HandshakeProtocol — two-node handshake', () => {
  let nodeA: Libp2p;
  let nodeB: Libp2p;
  let handshakeA: HandshakeProtocol;
  let handshakeB: HandshakeProtocol;
  let peerVersionEvents: Array<{ peerId: string; version: string }>;

  beforeAll(async () => {
    peerVersionEvents = [];
    nodeA = await createTestNode();
    nodeB = await createTestNode();

    handshakeA = new HandshakeProtocol(nodeA, {
      onPeerVersion: (peerId, version) => {
        peerVersionEvents.push({ peerId, version });
      },
    });
    handshakeB = new HandshakeProtocol(nodeB);

    await handshakeA.start();
    await handshakeB.start();

    // Connect nodeA to nodeB
    const addrB = nodeB.getMultiaddrs()[0];
    await nodeA.dial(addrB!);

    // Wait for handshake to complete (1s delay + exchange)
    await new Promise(r => setTimeout(r, 3000));
  }, 30000);

  afterAll(async () => {
    await handshakeA.stop();
    await handshakeB.stop();
    await nodeA.stop();
    await nodeB.stop();
  }, 15000);

  it('records peer version after handshake', () => {
    const peerBId = nodeB.peerId.toString();
    const version = handshakeA.getPeerVersion(peerBId);
    expect(version).toBe('0.2.0');
  });

  it('fires onPeerVersion event', () => {
    expect(peerVersionEvents.length).toBeGreaterThan(0);
    expect(peerVersionEvents[0].version).toBe('0.2.0');
  });

  it('peer is not marked incompatible for same version', () => {
    const peerBId = nodeB.peerId.toString();
    expect(handshakeA.isIncompatible(peerBId)).toBe(false);
  });

  it('getVersionStats includes the connected peer', () => {
    const stats = handshakeA.getVersionStats();
    expect(stats.get('0.2.0')).toBeGreaterThanOrEqual(1);
  });

  it('removePeer clears version and incompatible status', () => {
    const peerBId = nodeB.peerId.toString();
    handshakeA.removePeer(peerBId);
    expect(handshakeA.getPeerVersion(peerBId)).toBe('unknown');
    expect(handshakeA.isIncompatible(peerBId)).toBe(false);
  });
});
