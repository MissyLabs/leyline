import { gzipSync, gunzipSync } from 'node:zlib';

const COMPRESSED_PREFIX = 0x01;
const UNCOMPRESSED_PREFIX = 0x00;

/** Payloads smaller than this are not compressed (overhead > savings). */
const MIN_COMPRESS_SIZE = 256;

/** Maximum decompressed size to prevent zip bombs. */
const MAX_DECOMPRESSED_SIZE = 512 * 1024;

export function compressMessage(data: Uint8Array): Uint8Array {
  if (data.length < MIN_COMPRESS_SIZE) {
    const result = new Uint8Array(1 + data.length);
    result[0] = UNCOMPRESSED_PREFIX;
    result.set(data, 1);
    return result;
  }

  const compressed = gzipSync(data, { level: 6 });

  // Only use compression if it actually saves space
  if (compressed.length >= data.length) {
    const result = new Uint8Array(1 + data.length);
    result[0] = UNCOMPRESSED_PREFIX;
    result.set(data, 1);
    return result;
  }

  const result = new Uint8Array(1 + compressed.length);
  result[0] = COMPRESSED_PREFIX;
  result.set(compressed, 1);
  return result;
}

export function decompressMessage(data: Uint8Array): Uint8Array {
  if (data.length === 0) {
    throw new Error('Empty compressed message');
  }

  const prefix = data[0];

  if (prefix === UNCOMPRESSED_PREFIX) {
    return data.subarray(1);
  }

  if (prefix === COMPRESSED_PREFIX) {
    const decompressed = gunzipSync(data.subarray(1), {
      maxOutputLength: MAX_DECOMPRESSED_SIZE,
    });
    return new Uint8Array(decompressed);
  }

  // No prefix byte — treat as raw uncompressed data (backwards compatibility)
  return data;
}

export function isCompressedMessage(data: Uint8Array): boolean {
  return data.length > 0 && data[0] === COMPRESSED_PREFIX;
}
