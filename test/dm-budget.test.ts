import { describe, it, expect } from 'vitest';
import { MagicNode } from '../src/node/magic-node.js';
import type { DirectEnvelope } from '../src/node/direct-message.js';

// SEC-2 / RL-1 / FEAT-2: direct messages are governed by the shared inbound
// budget and can be handled by a sequential queued handler.
//
// The MagicNode constructor is side-effect free (no network / DB I/O), so we can
// exercise the DM delivery path directly without standing up libp2p.

function makeEnvelope(i: number, bytes = 10): DirectEnvelope {
  return {
    payload: new Uint8Array(bytes),
    targetPeerId: 'self',
    senderPeerId: `peer-${i}`,
    timestamp: Date.now() + i,
    isRelay: false,
    hopsRemaining: 0,
    encrypted: false,
    senderPubkeyHex: `pk-${i % 3}`,
  };
}

class TestableNode extends MagicNode {
  feedDM(env: DirectEnvelope): void {
    // deliverDirectMessage is private; drive it directly for the test.
    (this as unknown as { deliverDirectMessage(e: DirectEnvelope): void }).deliverDirectMessage(env);
  }
}

describe('MagicNode — DM inbound budget & queued handler', () => {
  it('caps the number of DMs delivered per minute (SEC-2)', () => {
    const delivered: DirectEnvelope[] = [];
    const node = new TestableNode(
      { dataDir: '/tmp/leyline-dmbudget-1', seedNodes: [], maxInboundPerMinute: 3, maxPayloadBytesPerMinute: 0 },
      { onDirectMessage: (env) => delivered.push(env) },
    );
    for (let i = 0; i < 20; i++) node.feedDM(makeEnvelope(i));
    expect(delivered.length).toBe(3);
  });

  it('runs the queued DM handler sequentially, never concurrently (FEAT-2)', async () => {
    const node = new TestableNode(
      { dataDir: '/tmp/leyline-dmbudget-2', seedNodes: [], maxInboundPerMinute: 0, maxPayloadBytesPerMinute: 0 },
      {},
    );

    let active = 0;
    let maxActive = 0;
    let handled = 0;
    node.onDirectMessageQueued(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      handled++;
    }, 100);

    for (let i = 0; i < 8; i++) node.feedDM(makeEnvelope(i));
    // Wait for the queue to drain.
    await new Promise((r) => setTimeout(r, 200));

    expect(maxActive).toBe(1);   // strictly sequential
    expect(handled).toBe(8);
  });

  it('drops oldest queued DMs when the queue is full (drop-oldest)', async () => {
    const node = new TestableNode(
      { dataDir: '/tmp/leyline-dmbudget-3', seedNodes: [], maxInboundPerMinute: 0, maxPayloadBytesPerMinute: 0 },
      {},
    );
    const seen: string[] = [];
    node.onDirectMessageQueued(async (env) => {
      await new Promise((r) => setTimeout(r, 2));
      seen.push(env.senderPeerId);
    }, 2);

    for (let i = 0; i < 10; i++) node.feedDM(makeEnvelope(i));
    await new Promise((r) => setTimeout(r, 200));
    // With a queue cap of 2, far fewer than 10 are handled.
    expect(seen.length).toBeLessThan(10);
    expect(seen.length).toBeGreaterThan(0);
  });
});
