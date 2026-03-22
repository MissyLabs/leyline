import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeypair } from '../src/identity/keypair.js';
import { initProto } from '../src/messages/proto.js';
import {
  createMessage,
  serializeMessage,
  serializeMessageJson,
  deserializeMessage,
  deserializeMessageJson,
  validateMessage,
  verifyMessageSignature,
  MessageType,
  MAX_PAYLOAD_SIZE,
} from '../src/messages/message.js';

beforeAll(async () => {
  await initProto();
});

describe('Message', () => {
  it('creates and signs a message', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['skill:code', 'lang:typescript'],
      payload: new TextEncoder().encode('{"offer": "code review"}'),
      type: MessageType.ADVERTISE,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    expect(msg.id.length).toBe(32);
    expect(msg.signature.length).toBe(64);
    expect(msg.nonce.length).toBe(16);
    expect(msg.tags).toEqual(['skill:code', 'lang:typescript']);
    expect(msg.ttl).toBe(7);
  });

  it('serializes and deserializes round-trip', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['test'],
      payload: new TextEncoder().encode('hello'),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    const bytes = serializeMessage(msg);
    const restored = deserializeMessage(bytes);

    expect(Buffer.from(restored.id).toString('hex')).toBe(Buffer.from(msg.id).toString('hex'));
    expect(restored.tags).toEqual(msg.tags);
    expect(restored.type).toBe(msg.type);
    expect(restored.ttl).toBe(msg.ttl);
  });

  it('validates a correct message', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['test'],
      payload: new TextEncoder().encode('hello'),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    const result = validateMessage(msg);
    expect(result.valid).toBe(true);
  });

  it('rejects oversized payload', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['test'],
      payload: new Uint8Array(MAX_PAYLOAD_SIZE + 1),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Payload exceeds');
  });

  it('verifies message signature', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['test'],
      payload: new TextEncoder().encode('signed data'),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    const valid = await verifyMessageSignature(msg);
    expect(valid).toBe(true);
  });

  it('rejects tampered message signature', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['test'],
      payload: new TextEncoder().encode('original'),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    // Tamper with payload after signing
    msg.payload = new TextEncoder().encode('tampered');
    const valid = await verifyMessageSignature(msg);
    expect(valid).toBe(false);
  });

  it('protobuf round-trip preserves message fields', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['skill:code', 'lang:ts'],
      payload: new TextEncoder().encode('protobuf test'),
      type: MessageType.ADVERTISE,
      ttl: 5,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    const bytes = serializeMessage(msg, 'protobuf');
    const restored = deserializeMessage(bytes, 'protobuf');

    expect(Buffer.from(restored.id).toString('hex')).toBe(Buffer.from(msg.id).toString('hex'));
    expect(Buffer.from(restored.senderPubkey).toString('hex')).toBe(Buffer.from(msg.senderPubkey).toString('hex'));
    expect(Buffer.from(restored.signature).toString('hex')).toBe(Buffer.from(msg.signature).toString('hex'));
    expect(restored.tags).toEqual(msg.tags);
    expect(restored.type).toBe(msg.type);
    expect(restored.ttl).toBe(msg.ttl);
    expect(restored.timestamp).toBe(msg.timestamp);
  });

  it('json format round-trip still works', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['test'],
      payload: new TextEncoder().encode('json test'),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    const bytes = serializeMessageJson(msg);
    const restored = deserializeMessageJson(bytes);

    expect(Buffer.from(restored.id).toString('hex')).toBe(Buffer.from(msg.id).toString('hex'));
    expect(restored.tags).toEqual(msg.tags);
  });

  it('protobuf is more compact than json', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['test'],
      payload: new TextEncoder().encode('size comparison'),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });

    const protoBytes = serializeMessage(msg, 'protobuf');
    const jsonBytes = serializeMessage(msg, 'json');

    expect(protoBytes.length).toBeLessThan(jsonBytes.length);
  });
});
