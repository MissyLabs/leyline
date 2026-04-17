import { describe, it, expect, beforeAll } from 'vitest';
import {
  initProto,
  deserializeMessageJson,
  createMessage,
  serializeMessage,
  deserializeMessage,
  MessageType,
  MAX_PAYLOAD_SIZE,
  generateKeypair,
} from '../src/index.js';

beforeAll(async () => {
  await initProto();
});

describe('JSON deserialization — field size limits', () => {
  it('rejects oversized hex payload field', () => {
    const oversizedPayload = 'a'.repeat(MAX_PAYLOAD_SIZE * 2 + 256);
    const wire = JSON.stringify({
      id: 'aa'.repeat(16),
      senderPubkey: 'bb'.repeat(32),
      signature: 'cc'.repeat(64),
      tags: ['test'],
      payload: oversizedPayload,
      timestamp: Date.now(),
      nonce: 'dd'.repeat(16),
      type: MessageType.BROADCAST,
      ttl: 300,
    });
    expect(() => deserializeMessageJson(new TextEncoder().encode(wire)))
      .toThrow(/size limit/);
  });

  it('rejects oversized id field', () => {
    const wire = JSON.stringify({
      id: 'a'.repeat(256),
      senderPubkey: 'bb'.repeat(32),
      signature: 'cc'.repeat(64),
      tags: ['test'],
      payload: 'ee'.repeat(10),
      timestamp: Date.now(),
      nonce: 'dd'.repeat(16),
      type: MessageType.BROADCAST,
      ttl: 300,
    });
    expect(() => deserializeMessageJson(new TextEncoder().encode(wire)))
      .toThrow(/size limit/);
  });

  it('rejects oversized signature field', () => {
    const wire = JSON.stringify({
      id: 'aa'.repeat(16),
      senderPubkey: 'bb'.repeat(32),
      signature: 'c'.repeat(512),
      tags: ['test'],
      payload: 'ee'.repeat(10),
      timestamp: Date.now(),
      nonce: 'dd'.repeat(16),
      type: MessageType.BROADCAST,
      ttl: 300,
    });
    expect(() => deserializeMessageJson(new TextEncoder().encode(wire)))
      .toThrow(/size limit/);
  });

  it('accepts well-sized fields', () => {
    const wire = JSON.stringify({
      id: 'aa'.repeat(16),
      senderPubkey: 'bb'.repeat(32),
      signature: 'cc'.repeat(64),
      tags: ['test'],
      payload: 'ee'.repeat(10),
      timestamp: Date.now(),
      nonce: 'dd'.repeat(16),
      type: MessageType.BROADCAST,
      ttl: 300,
    });
    const msg = deserializeMessageJson(new TextEncoder().encode(wire));
    expect(msg.tags).toEqual(['test']);
  });
});

describe('JSON deserialization — tags sanitization', () => {
  it('filters non-string tags', () => {
    const wire = JSON.stringify({
      id: 'aa'.repeat(16),
      senderPubkey: 'bb'.repeat(32),
      signature: 'cc'.repeat(64),
      tags: ['valid', 42, null, 'also-valid', undefined],
      payload: 'ee'.repeat(10),
      timestamp: Date.now(),
      nonce: 'dd'.repeat(16),
      type: MessageType.BROADCAST,
      ttl: 300,
    });
    const msg = deserializeMessageJson(new TextEncoder().encode(wire));
    expect(msg.tags).toEqual(['valid', 'also-valid']);
  });

  it('caps tags to 50 in JSON path', () => {
    const manyTags = Array.from({ length: 100 }, (_, i) => `tag${i}`);
    const wire = JSON.stringify({
      id: 'aa'.repeat(16),
      senderPubkey: 'bb'.repeat(32),
      signature: 'cc'.repeat(64),
      tags: manyTags,
      payload: 'ee'.repeat(10),
      timestamp: Date.now(),
      nonce: 'dd'.repeat(16),
      type: MessageType.BROADCAST,
      ttl: 300,
    });
    const msg = deserializeMessageJson(new TextEncoder().encode(wire));
    expect(msg.tags.length).toBe(50);
  });
});

describe('Protobuf deserialization — tags cap', () => {
  it('caps tags array from protobuf decode via round-trip', async () => {
    const keypair = await generateKeypair();
    const tags = Array.from({ length: 5 }, (_, i) => `tag${i}`);
    const msg = await createMessage({
      tags,
      payload: new Uint8Array([1, 2, 3]),
      type: MessageType.BROADCAST,
      privateKey: keypair.privateKey,
      publicKey: keypair.publicKey,
    });

    const encoded = serializeMessage(msg);
    const decoded = deserializeMessage(encoded);
    expect(decoded.tags).toEqual(tags);
    expect(decoded.tags.length).toBeLessThanOrEqual(50);
  });
});
