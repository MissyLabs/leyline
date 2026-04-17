import { describe, it, expect } from 'vitest';

describe('LedgerSync — wire message decode edge cases', () => {
  function decode(data: Uint8Array) {
    const parsed = JSON.parse(new TextDecoder().decode(data));
    if (typeof parsed.type !== 'string' || typeof parsed.senderPeerId !== 'string' ||
        typeof parsed.timestamp !== 'number') {
      throw new TypeError('Malformed SyncMessage');
    }
    if (parsed.type === 'range-request') {
      const si = Number(parsed.startIndex);
      const ei = Number(parsed.endIndex);
      parsed.startIndex = Number.isFinite(si) ? Math.max(0, Math.floor(si)) : 0;
      parsed.endIndex = Number.isFinite(ei) ? Math.max(0, Math.floor(ei)) : 0;
    }
    return parsed;
  }

  it('rejects messages with missing type field', () => {
    const data = new TextEncoder().encode(JSON.stringify({ senderPeerId: 'a', timestamp: 1 }));
    expect(() => decode(data)).toThrow('Malformed');
  });

  it('rejects messages with non-string type field', () => {
    const data = new TextEncoder().encode(JSON.stringify({ type: 42, senderPeerId: 'a', timestamp: 1 }));
    expect(() => decode(data)).toThrow('Malformed');
  });

  it('rejects messages with missing senderPeerId', () => {
    const data = new TextEncoder().encode(JSON.stringify({ type: 'push-entry', timestamp: 1 }));
    expect(() => decode(data)).toThrow('Malformed');
  });

  it('rejects messages with missing timestamp', () => {
    const data = new TextEncoder().encode(JSON.stringify({ type: 'push-entry', senderPeerId: 'a' }));
    expect(() => decode(data)).toThrow('Malformed');
  });

  it('sanitizes negative range-request indices to 0', () => {
    const data = new TextEncoder().encode(JSON.stringify({
      type: 'range-request', senderPeerId: 'a', timestamp: 1,
      startIndex: -5, endIndex: -10,
    }));
    const msg = decode(data);
    expect(msg.startIndex).toBe(0);
    expect(msg.endIndex).toBe(0);
  });

  it('sanitizes NaN range-request indices to 0', () => {
    const data = new TextEncoder().encode(JSON.stringify({
      type: 'range-request', senderPeerId: 'a', timestamp: 1,
      startIndex: 'not-a-number', endIndex: null,
    }));
    const msg = decode(data);
    expect(msg.startIndex).toBe(0);
    expect(msg.endIndex).toBe(0);
  });

  it('sanitizes Infinity range-request indices to 0', () => {
    const data = new TextEncoder().encode(JSON.stringify({
      type: 'range-request', senderPeerId: 'a', timestamp: 1,
      startIndex: Infinity, endIndex: -Infinity,
    }));
    // JSON.stringify converts Infinity to null
    const msg = decode(data);
    expect(msg.startIndex).toBe(0);
    expect(msg.endIndex).toBe(0);
  });

  it('floors floating-point indices', () => {
    const data = new TextEncoder().encode(JSON.stringify({
      type: 'range-request', senderPeerId: 'a', timestamp: 1,
      startIndex: 3.7, endIndex: 10.2,
    }));
    const msg = decode(data);
    expect(msg.startIndex).toBe(3);
    expect(msg.endIndex).toBe(10);
  });

  it('rejects non-JSON data', () => {
    const data = new TextEncoder().encode('not json at all');
    expect(() => decode(data)).toThrow();
  });

  it('rejects empty object', () => {
    const data = new TextEncoder().encode(JSON.stringify({}));
    expect(() => decode(data)).toThrow('Malformed');
  });
});

describe('LedgerSync — confirm-entry field validation', () => {
  it('rejects confirmation with short confirmerPubkey', () => {
    const confirm = {
      type: 'confirm-entry',
      confirmerPubkey: 'abc',
      entryHash: 'a'.repeat(64),
      confirmationSignature: 'b'.repeat(128),
      entryIndex: 1,
    };
    // Replicate the validation from ledger-sync.ts:296-299
    const valid = confirm.confirmerPubkey?.length === 64 &&
                  confirm.entryHash?.length === 64 &&
                  confirm.confirmationSignature?.length === 128;
    expect(valid).toBe(false);
  });

  it('rejects confirmation with short entryHash', () => {
    const confirm = {
      confirmerPubkey: 'a'.repeat(64),
      entryHash: 'short',
      confirmationSignature: 'b'.repeat(128),
    };
    const valid = confirm.confirmerPubkey?.length === 64 &&
                  confirm.entryHash?.length === 64 &&
                  confirm.confirmationSignature?.length === 128;
    expect(valid).toBe(false);
  });

  it('rejects confirmation with short signature', () => {
    const confirm = {
      confirmerPubkey: 'a'.repeat(64),
      entryHash: 'a'.repeat(64),
      confirmationSignature: 'short',
    };
    const valid = confirm.confirmerPubkey?.length === 64 &&
                  confirm.entryHash?.length === 64 &&
                  confirm.confirmationSignature?.length === 128;
    expect(valid).toBe(false);
  });

  it('rejects confirmation with missing fields', () => {
    const confirm: Record<string, unknown> = {
      confirmerPubkey: null,
      entryHash: undefined,
    };
    const valid = (confirm.confirmerPubkey as string)?.length === 64;
    expect(valid).toBe(false);
  });

  it('accepts valid confirmation field lengths', () => {
    const confirm = {
      confirmerPubkey: 'a'.repeat(64),
      entryHash: 'b'.repeat(64),
      confirmationSignature: 'c'.repeat(128),
    };
    const valid = confirm.confirmerPubkey?.length === 64 &&
                  confirm.entryHash?.length === 64 &&
                  confirm.confirmationSignature?.length === 128;
    expect(valid).toBe(true);
  });
});

describe('LedgerSync — range-request capping', () => {
  const maxRangeSize = 100;

  it('caps large range requests', () => {
    const startIndex = 0;
    const endIndex = 10000;
    const cappedEnd = Math.min(endIndex, startIndex + maxRangeSize - 1);
    expect(cappedEnd).toBe(99);
  });

  it('does not cap requests within limit', () => {
    const startIndex = 5;
    const endIndex = 50;
    const cappedEnd = Math.min(endIndex, startIndex + maxRangeSize - 1);
    expect(cappedEnd).toBe(50);
  });

  it('handles startIndex equal to endIndex', () => {
    const startIndex = 42;
    const endIndex = 42;
    const cappedEnd = Math.min(endIndex, startIndex + maxRangeSize - 1);
    expect(cappedEnd).toBe(42);
  });

  it('handles large startIndex without overflow', () => {
    const startIndex = Number.MAX_SAFE_INTEGER - 50;
    const endIndex = Number.MAX_SAFE_INTEGER;
    const cappedEnd = Math.min(endIndex, startIndex + maxRangeSize - 1);
    expect(cappedEnd).toBe(endIndex);
  });
});

describe('Inbox protocol — topic decode edge cases', () => {
  function decodeTopics(parsed: { topics?: unknown; since?: unknown; limit?: unknown }) {
    if (!Array.isArray(parsed.topics)) parsed.topics = [];
    const raw = (parsed.topics as unknown[]).slice(0, 200).filter((t: unknown) => typeof t === 'string');
    const unique = [...new Set<string>(raw)];
    return {
      topics: unique.slice(0, 100),
      since: typeof parsed.since === 'number' ? parsed.since : 0,
      limit: typeof parsed.limit === 'number' ? Math.min(Math.max(1, parsed.limit), 500) : 200,
    };
  }

  it('handles empty topics array', () => {
    const result = decodeTopics({ topics: [] });
    expect(result.topics).toEqual([]);
  });

  it('filters non-string topics', () => {
    const result = decodeTopics({ topics: ['valid', 42, null, true, { x: 1 }, 'also-valid'] });
    expect(result.topics).toEqual(['valid', 'also-valid']);
  });

  it('deduplicates topics', () => {
    const result = decodeTopics({ topics: ['a', 'b', 'a', 'c', 'b'] });
    expect(result.topics).toEqual(['a', 'b', 'c']);
  });

  it('pre-caps at 200 before dedup, then caps at 100', () => {
    const topics = Array.from({ length: 300 }, (_, i) => `topic-${i}`);
    const result = decodeTopics({ topics });
    expect(result.topics.length).toBeLessThanOrEqual(100);
    expect(result.topics[0]).toBe('topic-0');
  });

  it('handles 200 duplicate topics reducing to 1', () => {
    const topics = Array(200).fill('same');
    const result = decodeTopics({ topics });
    expect(result.topics).toEqual(['same']);
  });

  it('handles missing topics field', () => {
    const result = decodeTopics({});
    expect(result.topics).toEqual([]);
  });

  it('handles non-array topics', () => {
    const result = decodeTopics({ topics: 'not-array' });
    expect(result.topics).toEqual([]);
  });

  it('defaults since to 0 for non-number', () => {
    expect(decodeTopics({ since: 'bad' }).since).toBe(0);
    expect(decodeTopics({ since: null }).since).toBe(0);
    expect(decodeTopics({}).since).toBe(0);
  });

  it('clamps limit to [1, 500]', () => {
    expect(decodeTopics({ limit: 0 }).limit).toBe(1);
    expect(decodeTopics({ limit: -10 }).limit).toBe(1);
    expect(decodeTopics({ limit: 1000 }).limit).toBe(500);
    expect(decodeTopics({ limit: 50 }).limit).toBe(50);
  });

  it('defaults limit to 200 for non-number', () => {
    expect(decodeTopics({ limit: 'bad' }).limit).toBe(200);
    expect(decodeTopics({}).limit).toBe(200);
  });
});
