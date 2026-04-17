/**
 * Edge-case tests for message creation, serialization, and validation.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  serializeMessage,
  deserializeMessage,
  validateMessage,
  verifyMessageSignature,
  MessageType,
  MAX_PAYLOAD_SIZE,
  initProto,
  generateKeypair,
} from '../src/index.js';
import { createMessage } from '../src/messages/message.js';

beforeAll(async () => {
  await initProto();
});

describe('Message serialization round-trip with compression', () => {
  it('round-trips a small message (below compression threshold)', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      tags: ['test:small'],
      payload: new Uint8Array(10),
      type: MessageType.BROADCAST,
    });

    const serialized = serializeMessage(msg);
    const deserialized = deserializeMessage(serialized);
    expect(deserialized.tags).toEqual(msg.tags);
    expect(Buffer.from(deserialized.payload)).toEqual(Buffer.from(msg.payload));
  });

  it('round-trips a large message (above compression threshold)', async () => {
    const kp = await generateKeypair();
    const largePayload = new Uint8Array(2000);
    // Repetitive data compresses well
    for (let i = 0; i < largePayload.length; i++) largePayload[i] = i % 10;

    const msg = await createMessage({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      tags: ['test:large'],
      payload: largePayload,
      type: MessageType.BROADCAST,
    });

    const serialized = serializeMessage(msg);
    // Compressed size should be less than original protobuf encoding
    const deserialized = deserializeMessage(serialized);
    expect(Buffer.from(deserialized.payload)).toEqual(Buffer.from(largePayload));
  });

  it('compressed message still validates and verifies signature', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      tags: ['test:verify'],
      payload: new Uint8Array(500).fill(42),
      type: MessageType.BROADCAST,
    });

    const serialized = serializeMessage(msg);
    const deserialized = deserializeMessage(serialized);

    const validation = validateMessage(deserialized);
    expect(validation.valid).toBe(true);

    const sigValid = await verifyMessageSignature(deserialized);
    expect(sigValid).toBe(true);
  });
});

describe('Message validation edge cases', () => {
  it('rejects message with empty tags array', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      tags: [],
      payload: new Uint8Array(1),
      type: MessageType.BROADCAST,
    });
    msg.tags = [];
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
  });

  it('rejects message with too many tags', async () => {
    const kp = await generateKeypair();
    const tags = Array.from({ length: 25 }, (_, i) => `tag:${i}`);
    const msg = await createMessage({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      tags: tags.slice(0, 20),
      payload: new Uint8Array(1),
      type: MessageType.BROADCAST,
    });
    msg.tags = tags;
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
  });

  it('rejects message with zero-length ID', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      tags: ['test:id'],
      payload: new Uint8Array(1),
      type: MessageType.BROADCAST,
    });
    msg.id = new Uint8Array(0);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
  });

  it('rejects message with zero-length signature', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      tags: ['test:sig'],
      payload: new Uint8Array(1),
      type: MessageType.BROADCAST,
    });
    msg.signature = new Uint8Array(0);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
  });

  it('detects tampered payload via signature verification', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      tags: ['test:tamper'],
      payload: new TextEncoder().encode('original'),
      type: MessageType.BROADCAST,
    });

    // Tamper the payload
    msg.payload = new TextEncoder().encode('tampered');
    const sigValid = await verifyMessageSignature(msg);
    expect(sigValid).toBe(false);
  });

  it('JSON serialization format round-trips correctly', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      tags: ['test:json'],
      payload: new TextEncoder().encode('json-test'),
      type: MessageType.BROADCAST,
    });

    const serialized = serializeMessage(msg, 'json');
    const deserialized = deserializeMessage(serialized, 'json');
    expect(deserialized.tags).toEqual(msg.tags);
  });
});
