import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createMessage,
  validateMessage,
  MessageType,
  type MagicMessage,
} from '../src/messages/message.js';
import { generateKeypair } from '../src/identity/keypair.js';

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

describe('Message — staleness validation', () => {
  it('rejects messages older than 10 minutes', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1, 2, 3]),
      type: MessageType.BROADCAST,
    });

    msg.timestamp = Date.now() - 11 * 60 * 1000;
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too old');
  });

  it('accepts messages within 10 minute window', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1, 2, 3]),
      type: MessageType.BROADCAST,
    });

    msg.timestamp = Date.now() - 9 * 60 * 1000;
    recomputeId(msg);
    const result = validateMessage(msg);
    expect(result.valid).toBe(true);
  });

  it('accepts fresh messages', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1, 2, 3]),
      type: MessageType.BROADCAST,
    });

    const result = validateMessage(msg);
    expect(result.valid).toBe(true);
  });

  it('rejects messages far in the future', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1, 2, 3]),
      type: MessageType.BROADCAST,
    });

    msg.timestamp = Date.now() + 10 * 60 * 1000;
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('future');
  });

  it('accepts messages slightly in the future (within 5 min skew)', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      tags: ['test'],
      payload: new Uint8Array([1, 2, 3]),
      type: MessageType.BROADCAST,
    });

    msg.timestamp = Date.now() + 3 * 60 * 1000;
    recomputeId(msg);
    const result = validateMessage(msg);
    expect(result.valid).toBe(true);
  });
});
