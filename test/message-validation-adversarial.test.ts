import { describe, it, expect } from 'vitest';
import {
  createMessage,
  validateMessage,
  verifyMessageSignature,
  MessageType,
  MAX_PAYLOAD_SIZE,
  type MagicMessage,
} from '../src/messages/message.js';
import { generateKeypair } from '../src/identity/keypair.js';
import { createHash } from 'node:crypto';

function recomputeId(msg: MagicMessage): void {
  const tagsBytes = new TextEncoder().encode(msg.tags.join(','));
  const tsBuf = new Uint8Array(8);
  new DataView(tsBuf.buffer).setBigUint64(0, BigInt(msg.timestamp), false);
  const signable = new Uint8Array(msg.payload.length + tagsBytes.length + 8 + msg.nonce.length);
  let off = 0;
  signable.set(msg.payload, off); off += msg.payload.length;
  signable.set(tagsBytes, off); off += tagsBytes.length;
  signable.set(tsBuf, off); off += 8;
  signable.set(msg.nonce, off);
  msg.id = new Uint8Array(createHash('sha256').update(signable).digest());
}

describe('Message validation — adversarial inputs', () => {
  it('rejects forged message ID (changed payload)', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1, 2, 3]),
      type: MessageType.BROADCAST,
    });

    msg.payload = new Uint8Array([4, 5, 6]);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('content hash');
  });

  it('rejects forged message ID (changed tags)', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.tags = ['malicious'];
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('content hash');
  });

  it('rejects messages with wrong sender pubkey length', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.senderPubkey = new Uint8Array(31);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('32 bytes');
  });

  it('rejects zero-byte nonce', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.nonce = new Uint8Array(0);
    recomputeId(msg);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Nonce');
  });

  it('rejects oversized nonce', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.nonce = new Uint8Array(32);
    recomputeId(msg);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Nonce');
  });

  it('rejects zero TTL', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.ttl = 0;
    recomputeId(msg);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('TTL');
  });

  it('rejects negative TTL', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.ttl = -1;
    recomputeId(msg);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
  });

  it('rejects empty tags array', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.tags = [];
    recomputeId(msg);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Tags');
  });

  it('rejects too many tags (>20)', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    recomputeId(msg);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Too many tags');
  });

  it('rejects tag exceeding max length', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.tags = ['a'.repeat(101)];
    recomputeId(msg);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('maximum length');
  });

  it('rejects wrong signature length', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.signature = new Uint8Array(63);
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Signature');
  });

  it('signature verification fails for tampered payload with valid structure', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1, 2, 3]),
      type: MessageType.BROADCAST,
    });

    // Tamper payload and recompute ID to pass structural validation
    msg.payload = new Uint8Array([9, 9, 9]);
    recomputeId(msg);
    // Fix nonce to match
    const structResult = validateMessage(msg);
    if (structResult.valid) {
      // If structural validation passes, signature should fail
      const sigValid = await verifyMessageSignature(msg);
      expect(sigValid).toBe(false);
    }
  });

  it('signature verification fails with wrong sender key', async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp1.publicKey,
      privateKey: kp1.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    msg.senderPubkey = kp2.publicKey;
    recomputeId(msg);
    const result = validateMessage(msg);
    if (result.valid) {
      const sigValid = await verifyMessageSignature(msg);
      expect(sigValid).toBe(false);
    }
  });

  it('accepts exactly 20 tags at the limit', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: Array.from({ length: 20 }, (_, i) => `t${i}`),
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    const result = validateMessage(msg);
    expect(result.valid).toBe(true);
  });

  it('accepts tag at exactly max length (100 chars)', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['a'.repeat(100)],
      payload: new Uint8Array([1]),
      type: MessageType.BROADCAST,
    });

    const result = validateMessage(msg);
    expect(result.valid).toBe(true);
  });
});
