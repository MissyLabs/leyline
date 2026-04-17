import { describe, it, expect } from 'vitest';
import {
  compressMessage,
  decompressMessage,
  isCompressedMessage,
} from '../src/utils/compression.js';

const enc = new TextEncoder();

describe('Message compression', () => {
  it('round-trips small data without compression', () => {
    const data = enc.encode('hello');
    const compressed = compressMessage(data);
    expect(compressed[0]).toBe(0x00); // uncompressed prefix
    const result = decompressMessage(compressed);
    expect(Buffer.from(result).toString()).toBe('hello');
  });

  it('round-trips large data with compression', () => {
    // Create data larger than MIN_COMPRESS_SIZE (256)
    const data = enc.encode('A'.repeat(1000));
    const compressed = compressMessage(data);
    expect(compressed[0]).toBe(0x01); // compressed prefix
    expect(compressed.length).toBeLessThan(data.length);
    const result = decompressMessage(compressed);
    expect(Buffer.from(result).toString()).toBe('A'.repeat(1000));
  });

  it('skips compression when it does not reduce size', () => {
    // Random data is incompressible
    const data = new Uint8Array(512);
    crypto.getRandomValues(data);
    const compressed = compressMessage(data);
    // Should either be compressed (0x01) or not (0x00), either way round-trips
    const result = decompressMessage(compressed);
    expect(result).toEqual(data);
  });

  it('isCompressedMessage detects compressed data', () => {
    const small = compressMessage(enc.encode('tiny'));
    expect(isCompressedMessage(small)).toBe(false);

    const large = compressMessage(enc.encode('X'.repeat(1000)));
    expect(isCompressedMessage(large)).toBe(true);
  });

  it('handles backwards-compatible raw data (no prefix)', () => {
    // Data that starts with neither 0x00 nor 0x01 treated as raw
    const raw = enc.encode('raw-protobuf-data');
    // Protobuf typically starts with field tags (0x08, 0x0a, etc.)
    const result = decompressMessage(raw);
    expect(result).toEqual(raw);
  });

  it('throws on empty data', () => {
    expect(() => decompressMessage(new Uint8Array(0))).toThrow('Empty compressed message');
  });

  it('rejects zip bombs (data exceeding max decompressed size)', () => {
    // Create a large payload that compresses well (1MB of zeros)
    const huge = new Uint8Array(600 * 1024); // 600KB > 512KB limit
    const compressed = compressMessage(huge);
    // Decompression should fail due to maxOutputLength
    expect(() => decompressMessage(compressed)).toThrow();
  });

  it('round-trips binary protobuf-like data', () => {
    const data = new Uint8Array(400);
    // Simulate protobuf with field tags and repeated content
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 5 === 0 ? 0x0a : (i % 256);
    }
    const compressed = compressMessage(data);
    const result = decompressMessage(compressed);
    expect(result).toEqual(data);
  });
});
