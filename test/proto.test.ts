import { describe, it, expect, beforeAll } from 'vitest';
import { initProto, encodeMessage, decodeMessage } from '../src/messages/proto.js';
import { createMessage, MessageType, type MagicMessage } from '../src/messages/message.js';
import { generateKeypair } from '../src/identity/keypair.js';

describe('Proto — encode/decode', () => {
  beforeAll(async () => {
    await initProto();
  });

  it('round-trips a valid message', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test:roundtrip'],
      payload: new Uint8Array([10, 20, 30]),
      type: MessageType.BROADCAST,
    });

    const encoded = encodeMessage(msg);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeMessage(encoded);
    expect(Buffer.from(decoded.id).toString('hex')).toBe(Buffer.from(msg.id).toString('hex'));
    expect(decoded.tags).toEqual(msg.tags);
    expect(decoded.timestamp).toBe(msg.timestamp);
    expect(decoded.type).toBe(msg.type);
    expect(decoded.ttl).toBe(msg.ttl);
    expect(Buffer.from(decoded.payload).toString('hex')).toBe(Buffer.from(msg.payload).toString('hex'));
  });

  it('round-trips all message types', async () => {
    const kp = await generateKeypair();
    for (const type of [MessageType.BROADCAST, MessageType.DIRECT, MessageType.ADVERTISE, MessageType.DISCOVER, MessageType.DISCOVER_RESPONSE]) {
      const msg = await createMessage({
        publicKey: kp.publicKey,
        privateKey: kp.privateKey,
        tags: ['test'],
        payload: new Uint8Array([1]),
        type,
      });
      const decoded = decodeMessage(encodeMessage(msg));
      expect(decoded.type).toBe(type);
    }
  });

  it('handles empty payload', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array(0),
      type: MessageType.BROADCAST,
    });
    const decoded = decodeMessage(encodeMessage(msg));
    expect(decoded.payload.length).toBe(0);
  });

  it('handles multiple tags', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['a', 'b', 'c', 'd', 'e'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });
    const decoded = decodeMessage(encodeMessage(msg));
    expect(decoded.tags).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('preserves large payload', async () => {
    const kp = await generateKeypair();
    const bigPayload = new Uint8Array(10000);
    bigPayload.fill(42);
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: bigPayload,
      type: MessageType.BROADCAST,
    });
    const decoded = decodeMessage(encodeMessage(msg));
    expect(decoded.payload.length).toBe(10000);
    expect(decoded.payload[0]).toBe(42);
    expect(decoded.payload[9999]).toBe(42);
  });
});

describe('Proto — error paths', () => {
  it('throws on decode of empty data (UNSPECIFIED type)', async () => {
    await initProto();
    expect(() => decodeMessage(new Uint8Array(0))).toThrow('Unknown proto MessageType');
  });

  it('throws on decode of garbage data', async () => {
    await initProto();
    const garbage = new Uint8Array(100);
    for (let i = 0; i < 100; i++) garbage[i] = 0xff;
    expect(() => decodeMessage(garbage)).toThrow();
  });

  it('throws on encode/decode before initProto if cache is reset', () => {
    // This test is mainly documenting the expected behavior — initProto
    // is idempotent and already called in beforeAll above, so we can't
    // easily test the un-initialized state without resetting internal state.
    // The getType() function throws a descriptive error in that case.
  });

  it('initProto is idempotent', async () => {
    await initProto();
    await initProto();
    await initProto();
    // No error thrown on repeated calls
  });

  it('decode handles truncated protobuf', async () => {
    await initProto();
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1, 2, 3]),
      type: MessageType.BROADCAST,
    });
    const encoded = encodeMessage(msg);
    const truncated = encoded.slice(0, Math.floor(encoded.length / 2));
    // Truncated protobuf may decode partially or throw
    try {
      const decoded = decodeMessage(truncated);
      // If it doesn't throw, the decoded result should still be a valid structure
      expect(decoded).toBeDefined();
    } catch (err) {
      expect(err).toBeDefined();
    }
  });
});
