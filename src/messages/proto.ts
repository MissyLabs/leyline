/**
 * @module proto
 *
 * Protobuf encode/decode for {@link MagicMessage} using `protobufjs` runtime
 * schema loading.
 *
 * Call {@link initProto} once at application startup before invoking
 * {@link encodeMessage} or {@link decodeMessage}.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import protobuf from "protobufjs";
import { MessageType, type MagicMessage } from "./message.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(__dirname, "../../proto/message.proto");

// ---------------------------------------------------------------------------
// Proto enum name tables
// ---------------------------------------------------------------------------

/**
 * Maps the TypeScript {@link MessageType} numeric values to the proto enum
 * names (which carry the `MESSAGE_TYPE_` prefix).
 */
const TS_TO_PROTO_TYPE: Readonly<Record<MessageType, string>> = {
  [MessageType.BROADCAST]: "MESSAGE_TYPE_BROADCAST",
  [MessageType.DIRECT]: "MESSAGE_TYPE_DIRECT",
  [MessageType.ADVERTISE]: "MESSAGE_TYPE_ADVERTISE",
  [MessageType.DISCOVER]: "MESSAGE_TYPE_DISCOVER",
  [MessageType.DISCOVER_RESPONSE]: "MESSAGE_TYPE_DISCOVER_RESPONSE",
};

/**
 * Maps proto MessageType enum string names back to the TypeScript
 * {@link MessageType} numeric values.
 *
 * The proto numeric values happen to be identical (1–5), but we build this
 * table explicitly so the mapping is resilient to any future proto renumbering.
 */
const PROTO_NAME_TO_TS_TYPE: Readonly<Record<string, MessageType>> = {
  MESSAGE_TYPE_BROADCAST: MessageType.BROADCAST,
  MESSAGE_TYPE_DIRECT: MessageType.DIRECT,
  MESSAGE_TYPE_ADVERTISE: MessageType.ADVERTISE,
  MESSAGE_TYPE_DISCOVER: MessageType.DISCOVER,
  MESSAGE_TYPE_DISCOVER_RESPONSE: MessageType.DISCOVER_RESPONSE,
};

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

/** Cached protobuf Root, populated by {@link initProto}. */
let cachedRoot: protobuf.Root | null = null;

/** Cached MagicMessage type descriptor. */
let cachedType: protobuf.Type | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads and caches the protobuf schema from `proto/message.proto`.
 *
 * This function is idempotent — calling it multiple times is safe and
 * subsequent calls return immediately without re-loading the schema.
 *
 * @throws {Error} If the proto file cannot be found or parsed.
 */
export async function initProto(): Promise<void> {
  if (cachedRoot !== null) {
    return;
  }

  const root = await protobuf.load(PROTO_PATH);
  cachedType = root.lookupType("magic.MagicMessage");
  cachedRoot = root;
}

/**
 * Returns the cached {@link protobuf.Type} descriptor, throwing a descriptive
 * error when {@link initProto} has not yet been called.
 */
function getType(): protobuf.Type {
  if (cachedType === null) {
    throw new Error(
      "Proto schema has not been initialised. Call initProto() before encoding or decoding messages.",
    );
  }
  return cachedType;
}

/**
 * Encodes a {@link MagicMessage} to protobuf binary format.
 *
 * The TypeScript camelCase field names and the TypeScript {@link MessageType}
 * enum values are mapped to their proto equivalents before encoding.
 *
 * @param msg - The message to encode.
 * @returns A `Uint8Array` containing the serialised protobuf bytes.
 * @throws {Error} If {@link initProto} has not been called.
 * @throws {protobuf.util.ProtocolError} If the message fails protobuf verification.
 */
export function encodeMessage(msg: MagicMessage): Uint8Array {
  const type = getType();

  // Build the proto-shaped plain object. protobufjs accepts Buffer/Uint8Array
  // directly for `bytes` fields, so no conversion is required there.
  // The proto enum values match our TypeScript enum values (1-5), so we pass
  // the numeric value directly.
  const protoObj = {
    id: msg.id,
    senderPubkey: msg.senderPubkey,
    signature: msg.signature,
    tags: msg.tags,
    payload: msg.payload,
    // protobufjs encodes uint64 from a JS number or Long; ordinary ms
    // timestamps are well within Number.MAX_SAFE_INTEGER until the year 2255.
    timestamp: msg.timestamp,
    nonce: msg.nonce,
    type: msg.type as number,
    ttl: msg.ttl,
  };

  const errMsg = type.verify(protoObj);
  if (errMsg) {
    throw new Error(`Proto verification failed: ${errMsg}`);
  }

  const encoded = type.encode(type.create(protoObj)).finish();
  return encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
}

/**
 * Decodes protobuf binary data produced by {@link encodeMessage} back into a
 * {@link MagicMessage}.
 *
 * Proto field names (snake_case, `MESSAGE_TYPE_` prefixed enum names) are
 * translated back to the TypeScript interface conventions.
 *
 * @param data - The raw protobuf bytes.
 * @returns The reconstructed {@link MagicMessage}.
 * @throws {Error}   If {@link initProto} has not been called.
 * @throws {Error}   If `data` cannot be decoded or a required field is absent.
 */
export function decodeMessage(data: Uint8Array): MagicMessage {
  const type = getType();

  const decoded = type.decode(data);
  const obj = type.toObject(decoded, {
    // Keep bytes as Uint8Array rather than converting to base64 strings.
    bytes: Uint8Array,
    // Return enum values as string names so we can map them explicitly.
    enums: String,
    // Use camelCase keys — protobufjs will convert snake_case proto field names
    // (sender_pubkey, etc.) to camelCase automatically when this is set.
    defaults: true,
    // Convert Long values to JS numbers (safe for timestamps until year 2255).
    longs: Number,
  }) as Record<string, unknown>;

  // protobufjs camelCases proto field names: sender_pubkey → senderPubkey, etc.
  // Retrieve the type enum value — may be a string name or a number depending
  // on the toObject options and protobufjs version.
  const rawType = obj["type"];
  let tsType: MessageType;
  if (typeof rawType === 'string') {
    tsType = PROTO_NAME_TO_TS_TYPE[rawType] ??
      (() => { throw new Error(`Unknown proto MessageType string: "${rawType}"`); })();
  } else if (typeof rawType === 'number') {
    tsType = rawType as MessageType;
  } else {
    throw new Error(`Unexpected proto MessageType value: ${rawType}`);
  }

  return {
    id: ensureUint8Array(obj["id"]),
    senderPubkey: ensureUint8Array(obj["senderPubkey"]),
    signature: ensureUint8Array(obj["signature"]),
    tags: obj["tags"] as string[],
    payload: ensureUint8Array(obj["payload"]),
    timestamp: obj["timestamp"] as number,
    nonce: ensureUint8Array(obj["nonce"]),
    type: tsType,
    ttl: obj["ttl"] as number,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerces a value returned by `protobuf.Type.toObject` to a `Uint8Array`.
 *
 * When `{ bytes: Uint8Array }` is passed to `toObject`, protobufjs should
 * already return `Uint8Array` instances, but the option was added in v7 and
 * some versions still return `Buffer`. This guard ensures a consistent type.
 *
 * @param value - The raw value from the decoded object.
 * @returns A `Uint8Array` view over the data.
 */
function ensureUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return new Uint8Array(value as number[]);
  }
  throw new TypeError(
    `Expected bytes field to be Uint8Array or Buffer, got ${typeof value}`,
  );
}
