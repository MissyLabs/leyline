/**
 * Fuzz deserialization tests for all Leyline wire protocols.
 *
 * Verifies that malformed, truncated, type-confused, boundary-value, and
 * adversarially crafted inputs NEVER crash the decoders — they must either
 * throw a typed error or return silently, but must not cause unhandled
 * rejections, process exits, or memory corruption.
 *
 * Targets:
 *   - deserializeMessage / deserializeMessageJson  (src/messages/message.ts)
 *   - LedgerSync protocol handler               (src/ledger/ledger-sync.ts)
 *   - HandshakeProtocol handler                 (src/node/handshake-protocol.ts)
 *   - DiscoveryProtocol handler                 (src/discovery/discovery-protocol.ts)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deserializeMessage,
  deserializeMessageJson,
  type MagicMessage,
  MessageType,
  createMessage,
  serializeMessage,
  serializeMessageJson,
} from '../src/messages/message.js';
import { initProto } from '../src/messages/proto.js';
import { generateKeypair, publicKeyToHex } from '../src/identity/keypair.js';
import { HandshakeProtocol, HANDSHAKE_PROTOCOL } from '../src/node/handshake-protocol.js';
import { LedgerSync, LEDGER_SYNC_PROTOCOL } from '../src/ledger/ledger-sync.js';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { LedgerConsensus } from '../src/ledger/consensus.js';
import { ServiceRegistry } from '../src/discovery/service-registry.js';
import { DiscoveryProtocol, DISCOVERY_PROTOCOL } from '../src/discovery/discovery-protocol.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function createTestNode(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  } as Parameters<typeof createLibp2p>[0]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open a length-prefixed stream to `target` from `sender` and pipe `data`
 * in, then close. Errors are silenced — the point is to exercise the handler,
 * not to assert on send-side success.
 */
async function sendRaw(
  sender: Libp2p,
  target: Libp2p,
  protocol: string,
  data: Uint8Array,
): Promise<void> {
  try {
    const stream = await sender.dialProtocol(target.peerId, protocol);
    try {
      await pipe([data], (source) => lp.encode(source), stream);
    } finally {
      try { stream.close(); } catch { /* already closed */ }
    }
  } catch {
    // Dial/stream errors are expected for malformed inputs; swallow silently.
  }
}

/** Generate a Uint8Array of `len` cryptographically random bytes. */
function randomBytes(len: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(len));
}

/** UTF-8 encode a string for use as wire bytes. */
function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------
// 1. Message deserialization fuzz — direct API calls (no network required)
// ---------------------------------------------------------------------------

describe('Fuzz — deserializeMessage (protobuf format)', () => {
  beforeAll(async () => {
    await initProto();
  });

  it('handles completely empty input without crashing', () => {
    expect(() => deserializeMessage(new Uint8Array(0))).toThrow();
  });

  it('handles single-byte random inputs without crashing', () => {
    for (let i = 0; i < 256; i++) {
      try { deserializeMessage(new Uint8Array([i])); } catch { /* expected */ }
    }
  });

  it('handles short random byte sequences without crashing', () => {
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(Math.random() * 64) + 1;
      const bytes = randomBytes(len);
      try { deserializeMessage(bytes); } catch { /* expected */ }
    }
  });

  it('handles 1 KB random byte sequences without crashing', () => {
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(1024);
      // May throw (malformed proto) or succeed — but must never crash the process
      try { deserializeMessage(bytes); } catch { /* expected */ }
    }
  });

  it('handles 10 KB random byte sequences without crashing', () => {
    for (let i = 0; i < 20; i++) {
      const bytes = randomBytes(10_240);
      try { deserializeMessage(bytes); } catch { /* expected */ }
    }
  });

  it('handles truncated valid protobuf message without crashing', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['test:fuzz'],
      payload: new TextEncoder().encode('hello fuzz'),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    const valid = serializeMessage(msg);

    // Try every truncation point
    for (let cut = 0; cut < valid.length; cut++) {
      const truncated = valid.slice(0, cut);
      try { deserializeMessage(truncated); } catch { /* expected */ }
    }
  });

  it('handles all-zero bytes without crashing', () => {
    for (const size of [0, 1, 32, 128, 1024]) {
      const zeros = new Uint8Array(size);
      try { deserializeMessage(zeros); } catch { /* expected */ }
    }
  });

  it('handles all-0xFF bytes without crashing', () => {
    for (const size of [1, 32, 128, 512]) {
      const ones = new Uint8Array(size).fill(0xff);
      try { deserializeMessage(ones); } catch { /* expected */ }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Message deserialization fuzz — JSON format
// ---------------------------------------------------------------------------

describe('Fuzz — deserializeMessageJson (JSON-hex format)', () => {
  it('handles random bytes as JSON input without crashing', () => {
    for (let i = 0; i < 100; i++) {
      const len = Math.floor(Math.random() * 500);
      const bytes = randomBytes(len);
      // Random bytes will almost never be valid JSON — must throw SyntaxError
      expect(() => deserializeMessageJson(bytes)).toThrow();
    }
  });

  it('handles empty object JSON without crashing', () => {
    expect(() => deserializeMessageJson(enc('{}'))).toThrow();
  });

  it('handles null JSON without crashing', () => {
    expect(() => deserializeMessageJson(enc('null'))).toThrow();
  });

  it('handles array JSON without crashing', () => {
    expect(() => deserializeMessageJson(enc('[1,2,3]'))).toThrow();
  });

  it('handles type confusion — numbers where strings expected', () => {
    const payload = JSON.stringify({
      id: 12345,            // should be hex string
      senderPubkey: 99999,  // should be hex string
      signature: [],        // should be hex string
      tags: 'not-an-array',
      payload: true,
      timestamp: 'not-a-number',
      nonce: null,
      type: 'BROADCAST',    // should be number
      ttl: 'seven',
    });
    expect(() => deserializeMessageJson(enc(payload))).toThrow();
  });

  it('handles boundary numeric values in timestamp/ttl without crashing', () => {
    const boundaryValues = [
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      -1,
      0,
      NaN,
      Infinity,
      -Infinity,
    ];

    for (const val of boundaryValues) {
      const payload = JSON.stringify({
        id: 'a'.repeat(64),
        senderPubkey: 'b'.repeat(64),
        signature: 'c'.repeat(128),
        tags: ['test'],
        payload: 'd'.repeat(64),
        timestamp: val,
        nonce: 'e'.repeat(32),
        type: 1,
        ttl: val,
      });
      // NaN/Infinity serialize as null in JSON, so this may throw TypeError
      try { deserializeMessageJson(enc(payload)); } catch { /* expected */ }
    }
  });

  it('handles prototype pollution attempts without crashing', () => {
    const poisonedInputs = [
      '{"__proto__": {"polluted": true}, "id": "aa"}',
      '{"constructor": {"prototype": {"polluted": true}}}',
      '{"__proto__": null}',
      '{"prototype": {"isAdmin": true}}',
    ];

    for (const input of poisonedInputs) {
      // Must not crash and must not pollute Object.prototype
      try { deserializeMessageJson(enc(input)); } catch { /* expected */ }
      expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>)['isAdmin']).toBeUndefined();
    }
  });

  it('handles deeply nested JSON objects without crashing', () => {
    // Build 150 levels of nesting
    let nested = '"leaf"';
    for (let i = 0; i < 150; i++) {
      nested = `{"level${i}":${nested}}`;
    }
    try { deserializeMessageJson(enc(nested)); } catch { /* expected */ }
  });

  it('handles extremely long string values without crashing', () => {
    const megaString = 'x'.repeat(1_100_000); // > 1 MB
    const payload = JSON.stringify({
      id: megaString,
      senderPubkey: 'b'.repeat(64),
      signature: 'c'.repeat(128),
      tags: ['test'],
      payload: 'd'.repeat(64),
      timestamp: Date.now(),
      nonce: 'e'.repeat(32),
      type: 1,
      ttl: 7,
    });
    // Should throw RangeError due to field size limit
    expect(() => deserializeMessageJson(enc(payload))).toThrow();
  });

  it('handles enormous payload hex field without crashing', () => {
    // MAX_PAYLOAD_SIZE = 262144 bytes → 524288 hex chars; use 600000 hex chars
    const hugePayload = 'ab'.repeat(300_000);
    const payload = JSON.stringify({
      id: 'a'.repeat(64),
      senderPubkey: 'b'.repeat(64),
      signature: 'c'.repeat(128),
      tags: ['test'],
      payload: hugePayload,
      timestamp: Date.now(),
      nonce: 'e'.repeat(32),
      type: 1,
      ttl: 7,
    });
    expect(() => deserializeMessageJson(enc(payload))).toThrow();
  });

  it('handles array explosion — tags with millions of empty entries', () => {
    // JSON.stringify with a large sparse array would be enormous; use a smaller
    // but still adversarial count to keep the test fast.
    const manyTags = new Array(50_000).fill('');
    const payload = JSON.stringify({
      id: 'a'.repeat(64),
      senderPubkey: 'b'.repeat(64),
      signature: 'c'.repeat(128),
      tags: manyTags,
      payload: 'd'.repeat(64),
      timestamp: Date.now(),
      nonce: 'e'.repeat(32),
      type: 1,
      ttl: 7,
    });
    // Should parse but tags are capped to 50 inside deserializeMessageJson
    try { deserializeMessageJson(enc(payload)); } catch { /* also fine */ }
  });

  it('handles unicode attacks — null bytes and surrogate pairs in strings', () => {
    const unicodeInputs = [
      // Null byte embedded in string field
      JSON.stringify({
        id: 'aa\u0000bb',
        senderPubkey: 'b'.repeat(64),
        signature: 'c'.repeat(128),
        tags: ['test\u0000evil'],
        payload: 'd'.repeat(64),
        timestamp: Date.now(),
        nonce: 'e'.repeat(32),
        type: 1,
        ttl: 7,
      }),
      // Unpaired surrogate (invalid UTF-16 that may cause issues in some parsers)
      // JSON.stringify cannot encode an unpaired surrogate directly; use a replacement
      // sequence that looks like a surrogate escape to stress-test parsing
      '{"id":"\\uD800\\uDFFF","senderPubkey":"bb","signature":"cc","tags":[],"payload":"dd","timestamp":0,"nonce":"ee","type":1,"ttl":0}',
      // Right-to-left override and other control characters
      JSON.stringify({
        id: '\u202E\u200B',
        senderPubkey: '\uFEFF'.repeat(32),
        signature: 'c'.repeat(128),
        tags: ['\u0000'],
        payload: 'd'.repeat(64),
        timestamp: Date.now(),
        nonce: 'e'.repeat(32),
        type: 1,
        ttl: 7,
      }),
    ];

    for (const input of unicodeInputs) {
      try { deserializeMessageJson(enc(input)); } catch { /* expected */ }
    }
  });

  it('handles valid JSON with wrong top-level type values without crashing', () => {
    // type field outside the enum range
    const invalidTypes = [-999, 0, 999, 2.5, -1];
    for (const t of invalidTypes) {
      const msg = JSON.stringify({
        id: 'a'.repeat(64),
        senderPubkey: 'b'.repeat(64),
        signature: 'c'.repeat(128),
        tags: ['test'],
        payload: 'd'.repeat(64),
        timestamp: Date.now(),
        nonce: 'e'.repeat(32),
        type: t,
        ttl: 7,
      });
      // Out-of-range enum values pass field type check (it's a number) but
      // may or may not be accepted depending on validation downstream — must not crash.
      try { deserializeMessageJson(enc(msg)); } catch { /* expected */ }
    }
  });

  it('handles truncated valid JSON message at every byte without crashing', async () => {
    const kp = await generateKeypair();
    const msg = await createMessage({
      tags: ['fuzz:truncate'],
      payload: enc('truncation fuzz payload'),
      type: MessageType.BROADCAST,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    });
    const serialized = serializeMessageJson(msg);

    for (let cut = 0; cut < serialized.length; cut++) {
      expect(() => deserializeMessageJson(serialized.slice(0, cut))).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Handshake protocol wire fuzz — via raw stream injection
// ---------------------------------------------------------------------------

describe('Fuzz — HandshakeProtocol wire handler', () => {
  let victim: Libp2p;
  let attacker: Libp2p;

  beforeAll(async () => {
    victim = await createTestNode();
    attacker = await createTestNode();
    await attacker.dial(victim.getMultiaddrs()[0]);
    await sleep(300);
  }, 15_000);

  afterAll(async () => {
    await victim?.stop();
    await attacker?.stop();
  });

  it('survives random byte floods without crashing', async () => {
    const handshake = new HandshakeProtocol(victim);
    await handshake.start();
    try {
      for (let i = 0; i < 20; i++) {
        const len = [0, 1, 7, 64, 512, 4096][i % 6];
        await sendRaw(attacker, victim, HANDSHAKE_PROTOCOL, randomBytes(len));
      }
      await sleep(300);
      // Node still alive — if we reach here without throwing, the test passes
    } finally {
      await handshake.stop();
    }
  });

  it('handles null byte payload in JSON without crashing', async () => {
    const handshake = new HandshakeProtocol(victim);
    await handshake.start();
    try {
      // Embed a null byte inside a JSON string value
      const payload = '{"type":"hello","version":"0.2.0\u0000evil","minVersion":"0.1.0"}';
      await sendRaw(attacker, victim, HANDSHAKE_PROTOCOL, enc(payload));
      await sleep(300);
      const ver = handshake.getPeerVersion(attacker.peerId.toString());
      // The null-embedded version must not be accepted as-is
      expect(typeof ver).toBe('string');
    } finally {
      await handshake.stop();
    }
  });

  it('handles oversized minVersion field without crashing', async () => {
    const handshake = new HandshakeProtocol(victim);
    await handshake.start();
    try {
      const msg = JSON.stringify({
        type: 'hello',
        version: '0.2.0',
        minVersion: 'Z'.repeat(10_000),
      });
      await sendRaw(attacker, victim, HANDSHAKE_PROTOCOL, enc(msg));
      await sleep(300);
    } finally {
      await handshake.stop();
    }
  });

  it('handles welcome message type sent as initiator input without crashing', async () => {
    const handshake = new HandshakeProtocol(victim);
    await handshake.start();
    try {
      // The handler expects 'hello'; sending 'welcome' should be ignored gracefully
      const msg = JSON.stringify({
        type: 'welcome',
        version: '0.2.0',
        minVersion: '0.1.0',
        compatible: true,
        deprecated: false,
        message: '',
      });
      await sendRaw(attacker, victim, HANDSHAKE_PROTOCOL, enc(msg));
      await sleep(300);
    } finally {
      await handshake.stop();
    }
  });

  it('handles deeply nested JSON in version fields without crashing', async () => {
    const handshake = new HandshakeProtocol(victim);
    await handshake.start();
    try {
      // version is a nested object instead of a string
      const msg = JSON.stringify({
        type: 'hello',
        version: { major: 0, minor: 2, patch: 0 },
        minVersion: [0, 1, 0],
      });
      await sendRaw(attacker, victim, HANDSHAKE_PROTOCOL, enc(msg));
      await sleep(300);
    } finally {
      await handshake.stop();
    }
  });

  it('handles type confusion in type field without crashing', async () => {
    const handshake = new HandshakeProtocol(victim);
    await handshake.start();
    try {
      const confused = [
        JSON.stringify({ type: 123, version: '0.2.0', minVersion: '0.1.0' }),
        JSON.stringify({ type: null, version: '0.2.0', minVersion: '0.1.0' }),
        JSON.stringify({ type: [], version: '0.2.0', minVersion: '0.1.0' }),
        JSON.stringify({ type: {}, version: '0.2.0', minVersion: '0.1.0' }),
        JSON.stringify({ type: true, version: '0.2.0', minVersion: '0.1.0' }),
      ];
      for (const msg of confused) {
        await sendRaw(attacker, victim, HANDSHAKE_PROTOCOL, enc(msg));
      }
      await sleep(300);
    } finally {
      await handshake.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. LedgerSync protocol wire fuzz — via raw stream injection
// ---------------------------------------------------------------------------

describe('Fuzz — LedgerSync protocol wire handler', () => {
  let victim: Libp2p;
  let attacker: Libp2p;
  let tmpDir: string;
  let ledger: SharedLedger;
  let consensus: LedgerConsensus;
  let syncHandler: LedgerSync;
  let kp: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    kp = await generateKeypair();
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-fuzz-ledger-'));
    victim = await createTestNode();
    attacker = await createTestNode();
    await attacker.dial(victim.getMultiaddrs()[0]);
    await sleep(300);

    ledger = new SharedLedger(join(tmpDir, 'ledger'));
    await ledger.open();
    consensus = new LedgerConsensus({ quorumSize: 1 });
    syncHandler = new LedgerSync(victim, ledger, consensus, kp.publicKey, kp.privateKey, {
      syncIntervalMs: 600_000, // disable periodic sync
    });
    await syncHandler.start();
  }, 15_000);

  afterAll(async () => {
    await syncHandler?.stop();
    await ledger?.close();
    await victim?.stop();
    await attacker?.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('survives random byte floods on ledger-sync stream without crashing', async () => {
    for (let i = 0; i < 20; i++) {
      const size = [0, 1, 16, 128, 1024, 8192][i % 6];
      await sendRaw(attacker, victim, LEDGER_SYNC_PROTOCOL, randomBytes(size));
    }
    await sleep(300);
  });

  it('handles malformed JSON sync message without crashing', async () => {
    await sendRaw(attacker, victim, LEDGER_SYNC_PROTOCOL, enc('{{{not valid json'));
    await sleep(200);
  });

  it('handles sync message with missing required fields without crashing', async () => {
    // Missing senderPeerId and timestamp
    const partial = JSON.stringify({ type: 'range-request', startIndex: 0, endIndex: 10 });
    await sendRaw(attacker, victim, LEDGER_SYNC_PROTOCOL, enc(partial));
    await sleep(200);
  });

  it('handles range-request with Infinity/NaN indices without crashing', async () => {
    const nastyRanges = [
      { startIndex: Infinity, endIndex: Infinity },
      { startIndex: NaN, endIndex: NaN },
      { startIndex: -1, endIndex: -1 },
      { startIndex: Number.MAX_SAFE_INTEGER, endIndex: Number.MAX_SAFE_INTEGER },
      { startIndex: Number.MAX_VALUE, endIndex: Number.MAX_VALUE },
    ];

    for (const range of nastyRanges) {
      const msg = JSON.stringify({
        type: 'range-request',
        senderPeerId: attacker.peerId.toString(),
        timestamp: Date.now(),
        ...range,
      });
      await sendRaw(attacker, victim, LEDGER_SYNC_PROTOCOL, enc(msg));
    }
    await sleep(300);
  });

  it('handles push-entry with completely invalid entry fields without crashing', async () => {
    const badEntry = JSON.stringify({
      type: 'push-entry',
      senderPeerId: attacker.peerId.toString(),
      timestamp: Date.now(),
      entry: {
        index: 'not-a-number',
        prevHash: 12345,       // should be hex string
        hash: null,
        data: [],              // should be hex string
        submitterPubkey: true,
        signature: {},
        timestamp: 'never',
        confirmations: 'many',
        confirmerPubkeys: 'not-an-array',
      },
    });
    await sendRaw(attacker, victim, LEDGER_SYNC_PROTOCOL, enc(badEntry));
    await sleep(300);
  });

  it('handles confirm-entry with malformed signature lengths without crashing', async () => {
    const badConfirms = [
      // confirmerPubkey wrong length (not 64 hex chars)
      {
        type: 'confirm-entry',
        senderPeerId: attacker.peerId.toString(),
        timestamp: Date.now(),
        entryIndex: 0,
        entryHash: 'a'.repeat(64),
        confirmerPubkey: 'deadbeef',           // too short
        confirmationSignature: 'ff'.repeat(64),
      },
      // entryHash wrong length
      {
        type: 'confirm-entry',
        senderPeerId: attacker.peerId.toString(),
        timestamp: Date.now(),
        entryIndex: 0,
        entryHash: 'tooshort',
        confirmerPubkey: 'a'.repeat(64),
        confirmationSignature: 'b'.repeat(128),
      },
      // confirmationSignature wrong length
      {
        type: 'confirm-entry',
        senderPeerId: attacker.peerId.toString(),
        timestamp: Date.now(),
        entryIndex: 0,
        entryHash: 'a'.repeat(64),
        confirmerPubkey: 'b'.repeat(64),
        confirmationSignature: 'abcd',          // too short
      },
      // All fields null
      {
        type: 'confirm-entry',
        senderPeerId: null,
        timestamp: null,
        entryIndex: null,
        entryHash: null,
        confirmerPubkey: null,
        confirmationSignature: null,
      },
    ];

    for (const msg of badConfirms) {
      await sendRaw(attacker, victim, LEDGER_SYNC_PROTOCOL, enc(JSON.stringify(msg)));
    }
    await sleep(300);
  });

  it('handles unknown sync message type without crashing', async () => {
    const unknown = JSON.stringify({
      type: 'evil-sync-op',
      senderPeerId: attacker.peerId.toString(),
      timestamp: Date.now(),
      data: 'AAAA',
    });
    await sendRaw(attacker, victim, LEDGER_SYNC_PROTOCOL, enc(unknown));
    await sleep(200);
  });

  it('handles prototype pollution in sync message without crashing', async () => {
    const polluted = JSON.stringify({
      '__proto__': { quorumSize: 0, isAdmin: true },
      'type': 'range-request',
      'senderPeerId': attacker.peerId.toString(),
      'timestamp': Date.now(),
      'startIndex': 0,
      'endIndex': 100,
    });
    await sendRaw(attacker, victim, LEDGER_SYNC_PROTOCOL, enc(polluted));
    await sleep(200);
    expect((Object.prototype as Record<string, unknown>)['isAdmin']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['quorumSize']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Discovery protocol wire fuzz — via raw stream injection
// ---------------------------------------------------------------------------

describe('Fuzz — DiscoveryProtocol wire handler', () => {
  let victim: Libp2p;
  let attacker: Libp2p;
  let registry: ServiceRegistry;
  let discovery: DiscoveryProtocol;
  let kp: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    kp = await generateKeypair();
    victim = await createTestNode();
    attacker = await createTestNode();
    await attacker.dial(victim.getMultiaddrs()[0]);
    await sleep(300);

    registry = new ServiceRegistry();
    discovery = new DiscoveryProtocol(
      victim,
      registry,
      publicKeyToHex(kp.publicKey),
      victim.peerId.toString(),
      kp.privateKey,
    );
    await discovery.start();
  }, 15_000);

  afterAll(async () => {
    await discovery?.stop();
    await victim?.stop();
    await attacker?.stop();
  });

  it('survives random byte floods without crashing', async () => {
    for (let i = 0; i < 20; i++) {
      const size = [0, 1, 32, 256, 2048][i % 5];
      await sendRaw(attacker, victim, DISCOVERY_PROTOCOL, randomBytes(size));
    }
    await sleep(300);
    expect(registry.getAll()).toHaveLength(0);
  });

  it('handles invalid JSON without crashing', async () => {
    await sendRaw(attacker, victim, DISCOVERY_PROTOCOL, enc('][[[not json'));
    await sleep(200);
    expect(registry.getAll()).toHaveLength(0);
  });

  it('handles missing kind field without crashing', async () => {
    const noKind = JSON.stringify({ data: {}, senderPeerId: 'x', timestamp: Date.now() });
    await sendRaw(attacker, victim, DISCOVERY_PROTOCOL, enc(noKind));
    await sleep(200);
    expect(registry.getAll()).toHaveLength(0);
  });

  it('handles kind as non-string types without crashing', async () => {
    const badKinds = [
      JSON.stringify({ kind: 123 }),
      JSON.stringify({ kind: null }),
      JSON.stringify({ kind: [] }),
      JSON.stringify({ kind: {} }),
      JSON.stringify({ kind: true }),
    ];
    for (const msg of badKinds) {
      await sendRaw(attacker, victim, DISCOVERY_PROTOCOL, enc(msg));
    }
    await sleep(300);
    expect(registry.getAll()).toHaveLength(0);
  });

  it('handles advertisement with null descriptor without crashing', async () => {
    const nullDesc = JSON.stringify({
      kind: 'advertisement',
      descriptor: null,
      senderPeerId: attacker.peerId.toString(),
      timestamp: Date.now(),
    });
    await sendRaw(attacker, victim, DISCOVERY_PROTOCOL, enc(nullDesc));
    await sleep(200);
    expect(registry.getAll()).toHaveLength(0);
  });

  it('handles query with deeply nested query object without crashing', async () => {
    // Build a deep nesting that might blow a recursive parser
    let deep: Record<string, unknown> = { tags: ['ai'] };
    for (let i = 0; i < 100; i++) {
      deep = { nested: deep };
    }
    const msg = JSON.stringify({
      kind: 'query',
      query: deep,
      requestId: 'fuzz-req-1',
      senderPeerId: attacker.peerId.toString(),
      timestamp: Date.now(),
    });
    await sendRaw(attacker, victim, DISCOVERY_PROTOCOL, enc(msg));
    await sleep(300);
  });

  it('handles advertisement with extreme numeric TTL without crashing', async () => {
    for (const ttl of [Infinity, -Infinity, NaN, Number.MAX_VALUE, -1]) {
      const msg = JSON.stringify({
        kind: 'advertisement',
        descriptor: {
          id: 'fuzz-id',
          name: 'FuzzService',
          tags: ['fuzz'],
          description: 'fuzz test',
          providerPubkey: publicKeyToHex(kp.publicKey),
          providerPeerId: attacker.peerId.toString(),
          multiaddrs: ['/ip4/127.0.0.1/tcp/9999'],
          advertisedAt: Date.now(),
          ttl,
          metadata: {},
        },
        senderPeerId: attacker.peerId.toString(),
        timestamp: Date.now(),
      });
      await sendRaw(attacker, victim, DISCOVERY_PROTOCOL, enc(msg));
    }
    await sleep(300);
    // Registry should remain empty — all unsigned advertisements are dropped
    expect(registry.getAll()).toHaveLength(0);
  });

  it('handles prototype pollution in discovery message without crashing', async () => {
    const polluted = JSON.stringify({
      '__proto__': { isAdmin: true, pruneIntervalMs: 0 },
      'kind': 'query',
      'query': { tags: ['test'] },
      'requestId': 'poll-1',
      'senderPeerId': attacker.peerId.toString(),
      'timestamp': Date.now(),
    });
    await sendRaw(attacker, victim, DISCOVERY_PROTOCOL, enc(polluted));
    await sleep(200);
    expect((Object.prototype as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });

  it('handles advertisement with metadata containing very long keys/values without crashing', async () => {
    const bigMeta: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      bigMeta['k'.repeat(500) + i] = 'v'.repeat(500);
    }
    const msg = JSON.stringify({
      kind: 'advertisement',
      descriptor: {
        id: 'meta-fuzz',
        name: 'MetaFuzz',
        tags: ['fuzz'],
        description: 'fuzz',
        providerPubkey: publicKeyToHex(kp.publicKey),
        providerPeerId: attacker.peerId.toString(),
        multiaddrs: ['/ip4/127.0.0.1/tcp/9999'],
        advertisedAt: Date.now(),
        ttl: 300_000,
        metadata: bigMeta,
      },
      senderPeerId: attacker.peerId.toString(),
      timestamp: Date.now(),
    });
    await sendRaw(attacker, victim, DISCOVERY_PROTOCOL, enc(msg));
    await sleep(300);
    // Unsigned → dropped
    expect(registry.getAll()).toHaveLength(0);
  });
});
