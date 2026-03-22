/**
 * @module crypto/envelope
 *
 * End-to-end encryption for direct messages using X25519 key exchange and
 * XChaCha20-Poly1305 authenticated encryption.
 *
 * Flow:
 * 1. Sender converts their Ed25519 private key → X25519 private key.
 * 2. Sender converts recipient's Ed25519 public key → X25519 public key.
 * 3. X25519 shared secret is computed.
 * 4. Payload is encrypted with XChaCha20-Poly1305 using the shared secret.
 * 5. Recipient reverses the process to decrypt.
 */

import { x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from 'node:crypto';

/**
 * Convert an Ed25519 public key (32 bytes) to an X25519 public key.
 */
export function ed25519PubToX25519(edPub: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPub(edPub);
}

/**
 * Convert an Ed25519 private key seed (32 bytes) to an X25519 private key.
 */
export function ed25519PrivToX25519(edPriv: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPriv(edPriv);
}

/**
 * Compute the X25519 shared secret between a local private key and a remote
 * public key (both already in Montgomery form).
 */
export function computeSharedSecret(
  localX25519Priv: Uint8Array,
  remoteX25519Pub: Uint8Array,
): Uint8Array {
  return x25519.getSharedSecret(localX25519Priv, remoteX25519Pub);
}

/**
 * Encrypt a plaintext payload for a specific recipient.
 *
 * @param plaintext       - Raw bytes to encrypt.
 * @param senderEdPriv    - Sender's Ed25519 private key (32 bytes).
 * @param recipientEdPub  - Recipient's Ed25519 public key (32 bytes).
 * @returns Object with `ciphertext` and `nonce` (24 bytes for XChaCha20).
 */
export function encryptPayload(
  plaintext: Uint8Array,
  senderEdPriv: Uint8Array,
  recipientEdPub: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const senderX = ed25519PrivToX25519(senderEdPriv);
  const recipientX = ed25519PubToX25519(recipientEdPub);
  const sharedSecret = computeSharedSecret(senderX, recipientX);

  const nonce = new Uint8Array(randomBytes(24));
  const cipher = xchacha20poly1305(sharedSecret, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  return { ciphertext, nonce };
}

/**
 * Decrypt a ciphertext from a specific sender.
 *
 * @param ciphertext      - Encrypted bytes (includes Poly1305 tag).
 * @param nonce           - 24-byte nonce used during encryption.
 * @param recipientEdPriv - Recipient's Ed25519 private key (32 bytes).
 * @param senderEdPub     - Sender's Ed25519 public key (32 bytes).
 * @returns Decrypted plaintext bytes.
 * @throws If authentication fails (tampered or wrong key).
 */
export function decryptPayload(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  recipientEdPriv: Uint8Array,
  senderEdPub: Uint8Array,
): Uint8Array {
  const recipientX = ed25519PrivToX25519(recipientEdPriv);
  const senderX = ed25519PubToX25519(senderEdPub);
  const sharedSecret = computeSharedSecret(recipientX, senderX);

  const cipher = xchacha20poly1305(sharedSecret, nonce);
  return cipher.decrypt(ciphertext);
}
