import { describe, it, expect } from 'vitest';
import {
  generateKeypair,
  sign,
  verify,
  publicKeyToHex,
  hexToPublicKey,
  getFingerprint,
} from '../src/identity/keypair.js';

describe('Identity - Ed25519 Keypair', () => {
  it('generates a keypair with correct key sizes', async () => {
    const kp = await generateKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it('signs and verifies data correctly', async () => {
    const kp = await generateKeypair();
    const data = new TextEncoder().encode('hello magic network');
    const sig = await sign(kp.privateKey, data);

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);

    const valid = await verify(kp.publicKey, sig, data);
    expect(valid).toBe(true);
  });

  it('rejects tampered data', async () => {
    const kp = await generateKeypair();
    const data = new TextEncoder().encode('original');
    const sig = await sign(kp.privateKey, data);

    const tampered = new TextEncoder().encode('tampered');
    const valid = await verify(kp.publicKey, sig, tampered);
    expect(valid).toBe(false);
  });

  it('rejects wrong public key', async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const data = new TextEncoder().encode('test');
    const sig = await sign(kp1.privateKey, data);

    const valid = await verify(kp2.publicKey, sig, data);
    expect(valid).toBe(false);
  });

  it('hex round-trips public key', async () => {
    const kp = await generateKeypair();
    const hex = publicKeyToHex(kp.publicKey);
    expect(hex.length).toBe(64);
    const restored = hexToPublicKey(hex);
    expect(Buffer.from(restored).equals(Buffer.from(kp.publicKey))).toBe(true);
  });

  it('rejects invalid hex key length', () => {
    expect(() => hexToPublicKey('aabb')).toThrow(RangeError);
  });

  it('generates consistent fingerprints', async () => {
    const kp = await generateKeypair();
    const fp1 = getFingerprint(kp.publicKey);
    const fp2 = getFingerprint(kp.publicKey);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(16);
  });
});
