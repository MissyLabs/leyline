/**
 * @module keypair
 *
 * Ed25519 identity primitives for the Magic P2P network.
 *
 * Wraps @noble/ed25519 v2 for all signing and verification operations.
 * SHA-256 fingerprinting uses the Node.js built-in `crypto` module.
 *
 * All key material is represented as raw `Uint8Array` buffers:
 *   - Private key: 32 bytes (scalar seed)
 *   - Public key:  32 bytes (compressed Edwards point)
 *   - Signature:   64 bytes
 */

import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A generated Ed25519 keypair with raw byte representations. */
export interface Keypair {
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  /** 32-byte Ed25519 private key seed. */
  privateKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Generates a new random Ed25519 keypair.
 *
 * Uses `@noble/ed25519`'s CSPRNG-backed `utils.randomPrivateKey()` to produce
 * a 32-byte private key seed, then derives the corresponding public key.
 *
 * @returns A `Keypair` containing both the 32-byte public and private keys.
 */
export async function generateKeypair(): Promise<Keypair> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { publicKey, privateKey };
}

// ---------------------------------------------------------------------------
// Signing & verification
// ---------------------------------------------------------------------------

/**
 * Signs arbitrary data with an Ed25519 private key.
 *
 * @param privateKey - 32-byte Ed25519 private key seed.
 * @param data - Raw bytes to sign.
 * @returns A 64-byte Ed25519 signature.
 */
export async function sign(
  privateKey: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  return ed.signAsync(data, privateKey);
}

/**
 * Verifies an Ed25519 signature against a public key and the original data.
 *
 * @param publicKey - 32-byte Ed25519 public key.
 * @param signature - 64-byte Ed25519 signature to verify.
 * @param data - The original data that was signed.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export async function verify(
  publicKey: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  return ed.verifyAsync(signature, data, publicKey);
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/**
 * Encodes a public key as a lowercase hex string.
 *
 * @param pubkey - 32-byte Ed25519 public key.
 * @returns 64-character lowercase hex string.
 */
export function publicKeyToHex(pubkey: Uint8Array): string {
  return Buffer.from(pubkey).toString("hex");
}

/**
 * Decodes a hex string back into a raw public key `Uint8Array`.
 *
 * @param hex - 64-character hex string produced by {@link publicKeyToHex}.
 * @returns 32-byte `Uint8Array` representing the Ed25519 public key.
 * @throws {RangeError} If the decoded buffer is not exactly 32 bytes.
 */
export function hexToPublicKey(hex: string): Uint8Array {
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length !== 32) {
    throw new RangeError(
      `Expected 32 bytes for an Ed25519 public key, got ${bytes.length}`,
    );
  }
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Produces a short human-readable fingerprint of a public key for display
 * or logging purposes. Not suitable for cryptographic identity comparison —
 * use the full public key bytes for that.
 *
 * The fingerprint is the first 16 hex characters (8 bytes) of the SHA-256
 * digest of the raw public key bytes.
 *
 * @param pubkey - 32-byte Ed25519 public key.
 * @returns 16-character lowercase hex string (e.g. `"a3f0c1b2d4e56789"`).
 */
export function getFingerprint(pubkey: Uint8Array): string {
  return createHash("sha256").update(pubkey).digest("hex").slice(0, 16);
}
