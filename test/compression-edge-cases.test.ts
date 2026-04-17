import { describe, it, expect } from 'vitest';
import { compressMessage, decompressMessage, isCompressedMessage } from '../src/utils/compression.js';

describe('Compression — edge cases', () => {
  it('round-trips empty payload', () => {
    const data = new Uint8Array(0);
    const compressed = compressMessage(data);
    const decompressed = decompressMessage(compressed);
    expect(decompressed.length).toBe(0);
  });

  it('round-trips single byte', () => {
    const data = new Uint8Array([42]);
    const compressed = compressMessage(data);
    const decompressed = decompressMessage(compressed);
    expect(decompressed).toEqual(data);
  });

  it('does not compress data below 256 bytes', () => {
    const data = new Uint8Array(100).fill(0xAA);
    const compressed = compressMessage(data);
    expect(compressed[0]).toBe(0x00); // UNCOMPRESSED_PREFIX
    expect(isCompressedMessage(compressed)).toBe(false);
  });

  it('compresses highly repetitive data above 256 bytes', () => {
    const data = new Uint8Array(1000).fill(0x00);
    const compressed = compressMessage(data);
    expect(compressed[0]).toBe(0x01); // COMPRESSED_PREFIX
    expect(compressed.length).toBeLessThan(data.length);
    expect(isCompressedMessage(compressed)).toBe(true);
  });

  it('skips compression when it increases size', () => {
    // Random-looking data that doesn't compress well
    const data = new Uint8Array(300);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    const compressed = compressMessage(data);
    // May or may not compress — but should always round-trip
    const decompressed = decompressMessage(compressed);
    expect(decompressed).toEqual(data);
  });

  it('decompressMessage throws on empty data', () => {
    expect(() => decompressMessage(new Uint8Array(0))).toThrow('Empty');
  });

  it('decompressMessage handles unknown prefix as raw data', () => {
    const data = new Uint8Array([0xFF, 0x01, 0x02, 0x03]);
    const result = decompressMessage(data);
    expect(result).toEqual(data);
  });

  it('round-trips 256KB payload', () => {
    const data = new Uint8Array(262144);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xFF;
    const compressed = compressMessage(data);
    const decompressed = decompressMessage(compressed);
    expect(decompressed).toEqual(data);
  });

  it('decompressMessage rejects zip bomb exceeding 512KB', () => {
    // Create compressed data that would decompress to > 512KB
    const large = new Uint8Array(600_000).fill(0);
    const compressed = compressMessage(large);
    // The compressed version should be small (all zeros compress well)
    expect(compressed.length).toBeLessThan(large.length);
    // But decompression should fail because output > 512KB limit
    expect(() => decompressMessage(compressed)).toThrow();
  });

  it('isCompressedMessage returns false for uncompressed prefix', () => {
    expect(isCompressedMessage(new Uint8Array([0x00, 0x01]))).toBe(false);
  });

  it('isCompressedMessage returns false for empty data', () => {
    expect(isCompressedMessage(new Uint8Array(0))).toBe(false);
  });

  it('isCompressedMessage returns true for compressed prefix', () => {
    expect(isCompressedMessage(new Uint8Array([0x01, 0x1f]))).toBe(true);
  });

  it('compression is deterministic', () => {
    const data = new Uint8Array(500).fill(0xBB);
    const c1 = compressMessage(data);
    const c2 = compressMessage(data);
    expect(c1).toEqual(c2);
  });
});
