import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { generateKeypair, publicKeyToHex } from '../src/identity/keypair.js';
import { PeerExchange, type PeerRecord } from '../src/index.js';

async function createTestNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

describe('PeerExchange — isValidRecord edge cases', () => {
  let node: Libp2p;
  let pex: PeerExchange;

  beforeAll(async () => {
    const kp = await generateKeypair();
    node = await createTestNode();
    pex = new PeerExchange(node, {
      localPrivateKey: kp.privateKey,
      localPubkeyHex: publicKeyToHex(kp.publicKey),
    });
    await pex.start();
  }, 15000);

  afterAll(async () => {
    await pex.stop();
    await node.stop();
  }, 10000);

  function baseRecord(): PeerRecord {
    return {
      peerId: 'test-peer-id',
      pubkeyHex: 'ab'.repeat(32),
      multiaddrs: ['/ip4/127.0.0.1/tcp/1234'],
      offeredTags: ['test'],
      lastSeen: Date.now(),
    };
  }

  it('rejects record with empty peerId', () => {
    pex.addPeer({ ...baseRecord(), peerId: '' });
    expect(pex.getPeer('')).toBeUndefined();
  });

  it('rejects record with overlong peerId (> 512 chars)', () => {
    const longId = 'x'.repeat(513);
    pex.addPeer({ ...baseRecord(), peerId: longId });
    expect(pex.getPeer(longId)).toBeUndefined();
  });

  it('rejects record with overlong pubkeyHex', () => {
    pex.addPeer({ ...baseRecord(), peerId: 'long-pubkey', pubkeyHex: 'a'.repeat(513) });
    expect(pex.getPeer('long-pubkey')).toBeUndefined();
  });

  it('rejects record with more than 10 multiaddrs', () => {
    const addrs = Array.from({ length: 11 }, (_, i) => `/ip4/127.0.0.1/tcp/${3000 + i}`);
    pex.addPeer({ ...baseRecord(), peerId: 'many-addrs', multiaddrs: addrs });
    expect(pex.getPeer('many-addrs')).toBeUndefined();
  });

  it('rejects record with more than 50 tags', () => {
    const tags = Array.from({ length: 51 }, (_, i) => `tag-${i}`);
    pex.addPeer({ ...baseRecord(), peerId: 'many-tags', offeredTags: tags });
    expect(pex.getPeer('many-tags')).toBeUndefined();
  });

  it('rejects record with overlong individual multiaddr', () => {
    pex.addPeer({ ...baseRecord(), peerId: 'long-addr', multiaddrs: ['x'.repeat(513)] });
    expect(pex.getPeer('long-addr')).toBeUndefined();
  });

  it('rejects record with overlong individual tag', () => {
    pex.addPeer({ ...baseRecord(), peerId: 'long-tag', offeredTags: ['x'.repeat(513)] });
    expect(pex.getPeer('long-tag')).toBeUndefined();
  });

  it('rejects record with NaN lastSeen', () => {
    pex.addPeer({ ...baseRecord(), peerId: 'nan-time', lastSeen: NaN });
    expect(pex.getPeer('nan-time')).toBeUndefined();
  });

  it('rejects record with future lastSeen (> 5 min ahead)', () => {
    pex.addPeer({
      ...baseRecord(),
      peerId: 'future-time',
      lastSeen: Date.now() + 10 * 60_000,
    });
    expect(pex.getPeer('future-time')).toBeUndefined();
  });

  it('accepts valid record within limits', () => {
    pex.addPeer(baseRecord());
    expect(pex.getPeer('test-peer-id')).toBeDefined();
  });

  it('accepts record with 10 multiaddrs (at limit)', () => {
    const addrs = Array.from({ length: 10 }, (_, i) => `/ip4/127.0.0.1/tcp/${4000 + i}`);
    pex.addPeer({ ...baseRecord(), peerId: 'ten-addrs', multiaddrs: addrs });
    expect(pex.getPeer('ten-addrs')).toBeDefined();
  });

  it('accepts record with 50 tags (at limit)', () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
    pex.addPeer({ ...baseRecord(), peerId: 'fifty-tags', offeredTags: tags });
    expect(pex.getPeer('fifty-tags')).toBeDefined();
  });

  it('signed record is not replaced by unsigned record', () => {
    const signed = { ...baseRecord(), peerId: 'signed-peer', signature: 'valid-sig' };
    pex.addPeer(signed);

    const unsigned = { ...baseRecord(), peerId: 'signed-peer', lastSeen: Date.now() + 1000 };
    pex.addPeer(unsigned);

    const record = pex.getPeer('signed-peer');
    expect(record?.signature).toBe('valid-sig');
  });
});
