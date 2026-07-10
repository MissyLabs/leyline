import { describe, it, expect } from 'vitest';
import { generateKeypair } from '../src/identity/keypair.js';
import { encryptPayload, decryptPayload } from '../src/crypto/envelope.js';

describe('Crypto envelope — edge cases', () => {
  it('encrypts and decrypts empty payload', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new Uint8Array(0);

    const { ciphertext, nonce } = encryptPayload(plaintext, alice.privateKey, bob.publicKey);
    const decrypted = decryptPayload(ciphertext, nonce, bob.privateKey, alice.publicKey);
    expect(decrypted.length).toBe(0);
  });

  it('encrypts and decrypts single byte', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new Uint8Array([0x42]);

    const { ciphertext, nonce } = encryptPayload(plaintext, alice.privateKey, bob.publicKey);
    const decrypted = decryptPayload(ciphertext, nonce, bob.privateKey, alice.publicKey);
    expect(decrypted).toEqual(plaintext);
  });

  it('encrypts and decrypts large payload (64KB)', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new Uint8Array(65536);
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i & 0xff;

    const { ciphertext, nonce } = encryptPayload(plaintext, alice.privateKey, bob.publicKey);
    const decrypted = decryptPayload(ciphertext, nonce, bob.privateKey, alice.publicKey);
    expect(decrypted).toEqual(plaintext);
  });

  it('decryption fails with tampered nonce', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();

    const { ciphertext, nonce } = encryptPayload(
      new TextEncoder().encode('test'),
      alice.privateKey,
      bob.publicKey,
    );

    const badNonce = new Uint8Array(nonce);
    badNonce[0] ^= 0xff;
    expect(() => decryptPayload(ciphertext, badNonce, bob.privateKey, alice.publicKey)).toThrow();
  });

  it('decryption fails with wrong sender public key', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const eve = await generateKeypair();

    const { ciphertext, nonce } = encryptPayload(
      new TextEncoder().encode('from alice'),
      alice.privateKey,
      bob.publicKey,
    );

    expect(() => decryptPayload(ciphertext, nonce, bob.privateKey, eve.publicKey)).toThrow();
  });

  it('communication is bidirectional', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();

    const msg1 = new TextEncoder().encode('hello bob');
    const e1 = encryptPayload(msg1, alice.privateKey, bob.publicKey);
    const d1 = decryptPayload(e1.ciphertext, e1.nonce, bob.privateKey, alice.publicKey);
    expect(new TextDecoder().decode(d1)).toBe('hello bob');

    const msg2 = new TextEncoder().encode('hello alice');
    const e2 = encryptPayload(msg2, bob.privateKey, alice.publicKey);
    const d2 = decryptPayload(e2.ciphertext, e2.nonce, alice.privateKey, bob.publicKey);
    expect(new TextDecoder().decode(d2)).toBe('hello alice');
  });

  it('all-zero payload encrypts and decrypts correctly', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new Uint8Array(100);

    const { ciphertext, nonce } = encryptPayload(plaintext, alice.privateKey, bob.publicKey);
    const decrypted = decryptPayload(ciphertext, nonce, bob.privateKey, alice.publicKey);
    expect(decrypted).toEqual(plaintext);
  });

  it('all-0xff payload encrypts and decrypts correctly', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new Uint8Array(100).fill(0xff);

    const { ciphertext, nonce } = encryptPayload(plaintext, alice.privateKey, bob.publicKey);
    const decrypted = decryptPayload(ciphertext, nonce, bob.privateKey, alice.publicKey);
    expect(decrypted).toEqual(plaintext);
  });

  it('ciphertext is longer than plaintext (includes auth tag)', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new Uint8Array(32);

    const { ciphertext } = encryptPayload(plaintext, alice.privateKey, bob.publicKey);
    expect(ciphertext.length).toBeGreaterThan(plaintext.length);
  });

  it('truncated ciphertext fails decryption', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();

    const { ciphertext, nonce } = encryptPayload(
      new TextEncoder().encode('test data'),
      alice.privateKey,
      bob.publicKey,
    );

    const truncated = ciphertext.slice(0, ciphertext.length - 1);
    expect(() => decryptPayload(truncated, nonce, bob.privateKey, alice.publicKey)).toThrow();
  });
});
