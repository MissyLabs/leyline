import { describe, it, expect } from 'vitest';
import { generateKeypair } from '../src/identity/keypair.js';
import { encryptPayload, decryptPayload } from '../src/crypto/envelope.js';

describe('Crypto envelope (X25519 + XChaCha20-Poly1305)', () => {
  it('encrypts and decrypts a payload between two keypairs', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();

    const plaintext = new TextEncoder().encode('secret message from alice to bob');
    const { ciphertext, nonce } = encryptPayload(plaintext, alice.privateKey, bob.publicKey);

    // Ciphertext should differ from plaintext
    expect(Buffer.from(ciphertext).toString('hex'))
      .not.toBe(Buffer.from(plaintext).toString('hex'));

    // Bob decrypts
    const decrypted = decryptPayload(ciphertext, nonce, bob.privateKey, alice.publicKey);
    expect(new TextDecoder().decode(decrypted)).toBe('secret message from alice to bob');
  });

  it('decryption fails with wrong recipient key', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const eve = await generateKeypair();

    const plaintext = new TextEncoder().encode('for bob only');
    const { ciphertext, nonce } = encryptPayload(plaintext, alice.privateKey, bob.publicKey);

    // Eve tries to decrypt — should fail
    expect(() => decryptPayload(ciphertext, nonce, eve.privateKey, alice.publicKey))
      .toThrow();
  });

  it('decryption fails with tampered ciphertext', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();

    const plaintext = new TextEncoder().encode('integrity check');
    const { ciphertext, nonce } = encryptPayload(plaintext, alice.privateKey, bob.publicKey);

    // Tamper with ciphertext
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;

    expect(() => decryptPayload(tampered, nonce, bob.privateKey, alice.publicKey))
      .toThrow();
  });

  it('nonce is 24 bytes', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();

    const { nonce } = encryptPayload(new Uint8Array([1, 2, 3]), alice.privateKey, bob.publicKey);
    expect(nonce.length).toBe(24);
  });

  it('different encryptions produce different ciphertexts (unique nonces)', async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new TextEncoder().encode('same message');

    const r1 = encryptPayload(plaintext, alice.privateKey, bob.publicKey);
    const r2 = encryptPayload(plaintext, alice.privateKey, bob.publicKey);

    expect(Buffer.from(r1.nonce).toString('hex'))
      .not.toBe(Buffer.from(r2.nonce).toString('hex'));
    expect(Buffer.from(r1.ciphertext).toString('hex'))
      .not.toBe(Buffer.from(r2.ciphertext).toString('hex'));
  });
});
