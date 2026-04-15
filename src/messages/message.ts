/**
 * @module message
 *
 * Message creation, signing, and validation for the Magic P2P network.
 *
 * Works with plain TypeScript interfaces. Binary serialization is available in
 * two formats:
 *
 *   - **protobuf** (default) — compact binary encoding via `./proto.js`.
 *     {@link initProto} must be called once before using the default format.
 *   - **json** — legacy JSON-hex format retained for debugging and backwards
 *     compatibility. Available via the `format` parameter on the new
 *     {@link serializeMessage} / {@link deserializeMessage} overloads, or
 *     directly through the explicit {@link serializeMessageJson} /
 *     {@link deserializeMessageJson} functions.
 *
 * Cryptographic operations delegate to:
 *   - Node.js built-in `crypto` module for SHA-256 and random bytes
 *   - `../identity/keypair` for Ed25519 signing and verification
 */

import { randomBytes, createHash } from "node:crypto";
import { sign, verify } from "../identity/keypair.js";
import { encodeMessage as protoEncode, decodeMessage as protoDecode } from "./proto.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed payload size: 256 KB. */
export const MAX_PAYLOAD_SIZE = 262144;

/** Maximum number of routing tags per message. */
const MAX_TAGS = 20;

/** Maximum character length of a single routing tag. */
const MAX_TAG_LENGTH = 100;

/** Maximum clock skew tolerated for incoming messages (5 minutes in ms). */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Required nonce length in bytes. */
const NONCE_LENGTH = 16;

/** Required Ed25519 signature length in bytes. */
const SIGNATURE_LENGTH = 64;

/** Default TTL assigned to newly created messages (hops remaining). */
const DEFAULT_TTL = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discriminates the purpose of a {@link MagicMessage} and drives routing
 * behaviour inside the network.
 */
export enum MessageType {
  BROADCAST = 1,
  DIRECT = 2,
  ADVERTISE = 3,
  DISCOVER = 4,
  DISCOVER_RESPONSE = 5,
}

/**
 * The canonical wire-level representation of a message on the Magic P2P
 * network.
 *
 * All binary fields are raw `Uint8Array` buffers. The message is intentionally
 * kept framework-agnostic so it can be adapted to any transport layer.
 */
export interface MagicMessage {
  /** SHA-256 digest of the canonical content fields. */
  id: Uint8Array;

  /** Ed25519 public key of the originating peer (32 bytes). */
  senderPubkey: Uint8Array;

  /** Ed25519 signature over the canonical content fields (64 bytes). */
  signature: Uint8Array;

  /** Routing tags used by the network to direct or filter the message. */
  tags: string[];

  /** Application-level data carried by the message (max {@link MAX_PAYLOAD_SIZE} bytes). */
  payload: Uint8Array;

  /** Creation time as Unix milliseconds. */
  timestamp: number;

  /** 16 random bytes included in the signed digest to prevent replays. */
  nonce: Uint8Array;

  /** Classifies the message and drives network routing logic. */
  type: MessageType;

  /**
   * Application-level hop limit. For broadcast messages, GossipSub handles
   * hop limiting internally via its mesh overlay — this field is not
   * decremented by GossipSub relay nodes. It IS decremented by the
   * DirectMessageProtocol relay path. Validated on receive to reject
   * messages with exhausted TTL.
   */
  ttl: number;
}

// ---------------------------------------------------------------------------
// Internal serialization wire type
// ---------------------------------------------------------------------------

/**
 * JSON-safe representation used internally during serialization.
 * All `Uint8Array` fields are stored as lowercase hex strings.
 */
interface WireMessage {
  id: string;
  senderPubkey: string;
  signature: string;
  tags: string[];
  payload: string;
  timestamp: number;
  nonce: string;
  type: number;
  ttl: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Concatenates an arbitrary number of `Uint8Array` instances into a single
 * contiguous buffer.
 *
 * @param arrays - Zero or more arrays to concatenate.
 * @returns A new `Uint8Array` containing all input bytes in order.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

/**
 * Builds the canonical byte sequence that is both hashed to produce the
 * message id and signed by the sender.
 *
 * The layout is:
 *   payload | tagsUtf8 | timestampBigEndianUint64 | nonce
 *
 * @param payload   - Raw application data.
 * @param tags      - Routing tags, joined with `","` before encoding.
 * @param timestamp - Unix milliseconds.
 * @param nonce     - 16-byte random value.
 * @returns The canonical byte sequence.
 */
function buildSignableBytes(
  payload: Uint8Array,
  tags: string[],
  timestamp: number,
  nonce: Uint8Array,
): Uint8Array {
  const tagsBytes = new TextEncoder().encode(tags.join(","));

  // Encode the 64-bit timestamp as a big-endian 8-byte buffer using BigInt so
  // that values larger than Number.MAX_SAFE_INTEGER remain accurate (future-
  // proofing) while staying compatible with standard JS number timestamps.
  const timestampBuffer = new Uint8Array(8);
  const view = new DataView(timestampBuffer.buffer);
  view.setBigUint64(0, BigInt(timestamp), false /* big-endian */);

  return concatBytes(payload, tagsBytes, timestampBuffer, nonce);
}

/**
 * Computes the SHA-256 message id over the canonical content fields.
 *
 * @param payload   - Raw application data.
 * @param tags      - Routing tags.
 * @param timestamp - Unix milliseconds.
 * @param nonce     - 16-byte random value.
 * @returns 32-byte SHA-256 digest.
 */
function computeId(
  payload: Uint8Array,
  tags: string[],
  timestamp: number,
  nonce: Uint8Array,
): Uint8Array {
  const signable = buildSignableBytes(payload, tags, timestamp, nonce);
  return new Uint8Array(createHash("sha256").update(signable).digest());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link createMessage}.
 */
export interface CreateMessageOptions {
  /** Routing tags; must contain at least one entry. */
  tags: string[];

  /** Application payload; must not exceed {@link MAX_PAYLOAD_SIZE}. */
  payload: Uint8Array;

  /** Message classification. */
  type: MessageType;

  /**
   * Hop limit.
   * @defaultValue 7
   */
  ttl?: number;

  /** 32-byte Ed25519 private key used to sign the message. */
  privateKey: Uint8Array;

  /** 32-byte Ed25519 public key matching `privateKey`. */
  publicKey: Uint8Array;
}

/**
 * Creates a fully formed, signed {@link MagicMessage}.
 *
 * Steps performed:
 *  1. Generates a 16-byte cryptographically random nonce.
 *  2. Captures the current wall-clock time as a Unix millisecond timestamp.
 *  3. Computes the message id as SHA-256(payload | tagsUtf8 | timestamp | nonce).
 *  4. Signs the same byte sequence with the provided Ed25519 private key.
 *
 * @param opts - Creation options including key material and content fields.
 * @returns A fully populated {@link MagicMessage} ready for transport.
 */
export async function createMessage(
  opts: CreateMessageOptions,
): Promise<MagicMessage> {
  const { tags, payload, type, privateKey, publicKey } = opts;
  const ttl = opts.ttl ?? DEFAULT_TTL;

  const nonce = new Uint8Array(randomBytes(NONCE_LENGTH));
  const timestamp = Date.now();

  const id = computeId(payload, tags, timestamp, nonce);

  const signableBytes = buildSignableBytes(payload, tags, timestamp, nonce);
  const signature = await sign(privateKey, signableBytes);

  return {
    id,
    senderPubkey: publicKey,
    signature,
    tags,
    payload,
    timestamp,
    nonce,
    type,
    ttl,
  };
}

/**
 * Serializes a {@link MagicMessage} to UTF-8-encoded JSON bytes (legacy
 * JSON-hex wire format).
 *
 * All `Uint8Array` fields are hex-encoded before JSON stringification, keeping
 * the output human-inspectable and easy to debug.
 *
 * @param msg - The message to serialize.
 * @returns UTF-8 encoded JSON bytes.
 */
export function serializeMessageJson(msg: MagicMessage): Uint8Array {
  const wire: WireMessage = {
    id: Buffer.from(msg.id).toString("hex"),
    senderPubkey: Buffer.from(msg.senderPubkey).toString("hex"),
    signature: Buffer.from(msg.signature).toString("hex"),
    tags: msg.tags,
    payload: Buffer.from(msg.payload).toString("hex"),
    timestamp: msg.timestamp,
    nonce: Buffer.from(msg.nonce).toString("hex"),
    type: msg.type,
    ttl: msg.ttl,
  };

  return new TextEncoder().encode(JSON.stringify(wire));
}

/**
 * Deserializes bytes produced by {@link serializeMessageJson} back into a
 * {@link MagicMessage}.
 *
 * @param data - UTF-8 encoded JSON bytes.
 * @returns The reconstructed {@link MagicMessage}.
 * @throws {SyntaxError}  If `data` is not valid JSON.
 * @throws {TypeError}    If a required field is missing or has the wrong shape.
 */
export function deserializeMessageJson(data: Uint8Array): MagicMessage {
  const json = new TextDecoder().decode(data);
  const wire = JSON.parse(json) as WireMessage;

  if (
    typeof wire.id !== "string" ||
    typeof wire.senderPubkey !== "string" ||
    typeof wire.signature !== "string" ||
    !Array.isArray(wire.tags) ||
    typeof wire.payload !== "string" ||
    typeof wire.timestamp !== "number" ||
    typeof wire.nonce !== "string" ||
    typeof wire.type !== "number" ||
    typeof wire.ttl !== "number"
  ) {
    throw new TypeError("Malformed wire message: missing or incorrectly typed field(s)");
  }

  const MAX_HEX_FIELD = MAX_PAYLOAD_SIZE * 2 + 128;
  if (wire.id.length > 128 || wire.senderPubkey.length > 128 ||
      wire.signature.length > 256 || wire.nonce.length > 128 ||
      wire.payload.length > MAX_HEX_FIELD) {
    throw new RangeError("Wire message field exceeds size limit");
  }

  return {
    id: new Uint8Array(Buffer.from(wire.id, "hex")),
    senderPubkey: new Uint8Array(Buffer.from(wire.senderPubkey, "hex")),
    signature: new Uint8Array(Buffer.from(wire.signature, "hex")),
    tags: wire.tags.filter((t): t is string => typeof t === 'string').slice(0, 50),
    payload: new Uint8Array(Buffer.from(wire.payload, "hex")),
    timestamp: wire.timestamp,
    nonce: new Uint8Array(Buffer.from(wire.nonce, "hex")),
    type: wire.type as MessageType,
    ttl: wire.ttl,
  };
}

// ---------------------------------------------------------------------------
// Unified serialize / deserialize (protobuf default, JSON-hex fallback)
// ---------------------------------------------------------------------------

/**
 * The wire encoding format accepted by {@link serializeMessage} and
 * {@link deserializeMessage}.
 *
 * - `"protobuf"` — compact binary protobuf encoding (default).
 *   Requires {@link initProto} to have been called beforehand.
 * - `"json"` — legacy UTF-8 JSON-hex encoding, fully self-contained.
 */
export type SerializationFormat = "protobuf" | "json";

/**
 * Serializes a {@link MagicMessage} to binary for network transport.
 *
 * @param msg    - The message to serialize.
 * @param format - Wire format to use. Defaults to `"protobuf"`.
 * @returns Serialized bytes in the requested format.
 *
 * @example Protobuf (default)
 * ```ts
 * await initProto();
 * const bytes = serializeMessage(msg);
 * ```
 *
 * @example Explicit JSON-hex fallback
 * ```ts
 * const bytes = serializeMessage(msg, 'json');
 * ```
 */
export function serializeMessage(
  msg: MagicMessage,
  format: SerializationFormat = "protobuf",
): Uint8Array {
  if (format === "json") {
    return serializeMessageJson(msg);
  }
  return protoEncode(msg);
}

/**
 * Deserializes bytes back into a {@link MagicMessage}.
 *
 * The `format` parameter **must** match the format used when serializing — the
 * two wire formats are not auto-detected.
 *
 * @param data   - The serialized bytes.
 * @param format - Wire format of `data`. Defaults to `"protobuf"`.
 * @returns The reconstructed {@link MagicMessage}.
 *
 * @throws {Error}      If `format` is `"protobuf"` and {@link initProto} has
 *                      not been called.
 * @throws {SyntaxError} If `format` is `"json"` and `data` is not valid JSON.
 * @throws {TypeError}   If a required field is missing or malformed.
 */
export function deserializeMessage(
  data: Uint8Array,
  format: SerializationFormat = "protobuf",
): MagicMessage {
  if (format === "json") {
    return deserializeMessageJson(data);
  }
  return protoDecode(data);
}

/**
 * Result returned by {@link validateMessage}.
 */
export interface ValidationResult {
  /** `true` when all structural and policy checks pass. */
  valid: boolean;

  /**
   * Human-readable description of the first failing check.
   * Absent when `valid` is `true`.
   */
  error?: string;
}

/**
 * Validates the structural integrity and policy constraints of a
 * {@link MagicMessage}.
 *
 * Checks performed (in order):
 *  - Payload size does not exceed {@link MAX_PAYLOAD_SIZE}.
 *  - Tags array is non-empty, contains at most {@link MAX_TAGS} entries, and
 *    each tag is at most {@link MAX_TAG_LENGTH} characters.
 *  - TTL is greater than zero.
 *  - Timestamp is not more than 5 minutes in the future.
 *  - Nonce is exactly 16 bytes.
 *  - Signature buffer is exactly 64 bytes.
 *
 * Note: this function does NOT verify the cryptographic signature. Use
 * {@link verifyMessageSignature} for that purpose.
 *
 * @param msg - The message to validate.
 * @returns A {@link ValidationResult} indicating pass or the first failure.
 */
export function validateMessage(msg: MagicMessage): ValidationResult {
  // Verify sender public key length (must be 32-byte Ed25519 key)
  if (msg.senderPubkey.length !== 32) {
    return {
      valid: false,
      error: `Sender public key must be 32 bytes, got ${msg.senderPubkey.length}`,
    };
  }

  // Recompute message ID to prevent forgery (attacker changing ID to bypass dedup)
  const expectedId = computeId(msg.payload, msg.tags, msg.timestamp, msg.nonce);
  if (!buffersEqual(msg.id, expectedId)) {
    return {
      valid: false,
      error: 'Message ID does not match content hash — possible forgery',
    };
  }

  if (msg.payload.length > MAX_PAYLOAD_SIZE) {
    return {
      valid: false,
      error: `Payload exceeds maximum size: ${msg.payload.length} > ${MAX_PAYLOAD_SIZE} bytes`,
    };
  }

  if (msg.tags.length === 0) {
    return { valid: false, error: "Tags array must not be empty" };
  }

  if (msg.tags.length > MAX_TAGS) {
    return {
      valid: false,
      error: `Too many tags: ${msg.tags.length} > ${MAX_TAGS}`,
    };
  }

  for (const tag of msg.tags) {
    if (tag.length > MAX_TAG_LENGTH) {
      return {
        valid: false,
        error: `Tag "${tag.slice(0, 20)}..." exceeds maximum length of ${MAX_TAG_LENGTH} characters`,
      };
    }
  }

  if (msg.ttl <= 0) {
    return { valid: false, error: `TTL must be greater than zero, got ${msg.ttl}` };
  }

  const now = Date.now();
  if (msg.timestamp > now + MAX_FUTURE_SKEW_MS) {
    return {
      valid: false,
      error: `Timestamp is too far in the future: ${msg.timestamp - now}ms ahead`,
    };
  }

  if (msg.nonce.length !== NONCE_LENGTH) {
    return {
      valid: false,
      error: `Nonce must be ${NONCE_LENGTH} bytes, got ${msg.nonce.length}`,
    };
  }

  if (msg.signature.length !== SIGNATURE_LENGTH) {
    return {
      valid: false,
      error: `Signature must be ${SIGNATURE_LENGTH} bytes, got ${msg.signature.length}`,
    };
  }

  return { valid: true };
}

/**
 * Verifies the Ed25519 signature on a {@link MagicMessage}.
 *
 * The signed byte sequence is reconstructed from the message fields using the
 * same deterministic layout as {@link createMessage}, then verified against
 * `msg.senderPubkey`.
 *
 * @param msg - The message whose signature should be verified.
 * @returns `true` if the signature is cryptographically valid, `false` otherwise.
 */
function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Use constant-time comparison to avoid timing side channels
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function verifyMessageSignature(msg: MagicMessage): Promise<boolean> {
  const signableBytes = buildSignableBytes(
    msg.payload,
    msg.tags,
    msg.timestamp,
    msg.nonce,
  );

  return verify(msg.senderPubkey, msg.signature, signableBytes);
}
