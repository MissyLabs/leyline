import { describe, it, expect } from 'vitest';
import { InboundBudget } from '../src/utils/inbound-budget.js';

// FEAT-2 / SEC-2 / RL-1: the unified inbound cost governor shared across the
// GossipSub, direct-message, and inbox delivery paths.
describe('InboundBudget', () => {
  it('enforces the global per-minute cap across all senders', () => {
    const budget = new InboundBudget({ maxInboundPerMinute: 5, maxPayloadBytesPerMinute: 0 });
    let admitted = 0;
    for (let i = 0; i < 20; i++) {
      if (budget.admit(`sender-${i % 3}`, 10).admitted) admitted++;
    }
    expect(admitted).toBe(5);
  });

  it('sheds with global_rate reason once the window is full', () => {
    const budget = new InboundBudget({ maxInboundPerMinute: 1, maxPayloadBytesPerMinute: 0 });
    expect(budget.admit('a', 1).admitted).toBe(true);
    const second = budget.admit('a', 1);
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe('global_rate');
  });

  it('enforces the per-sender payload byte budget', () => {
    const budget = new InboundBudget({ maxInboundPerMinute: 0, maxPayloadBytesPerMinute: 100 });
    expect(budget.admit('big', 60).admitted).toBe(true);  // 60 total
    const over = budget.admit('big', 60);                  // 120 total > 100
    expect(over.admitted).toBe(false);
    expect(over.reason).toBe('payload_bytes');
    // A different sender has its own budget.
    expect(budget.admit('other', 90).admitted).toBe(true);
  });

  it('invokes the onShed callback with the reason and sender', () => {
    const shed: Array<{ reason: string; sender: string }> = [];
    const budget = new InboundBudget(
      { maxInboundPerMinute: 1, maxPayloadBytesPerMinute: 0 },
      (reason, sender) => shed.push({ reason, sender }),
    );
    budget.admit('x', 1);
    budget.admit('x', 1);
    expect(shed).toEqual([{ reason: 'global_rate', sender: 'x' }]);
  });

  it('hasGlobalCapacity reflects remaining room without recording', () => {
    const budget = new InboundBudget({ maxInboundPerMinute: 2, maxPayloadBytesPerMinute: 0 });
    expect(budget.hasGlobalCapacity()).toBe(true);
    budget.admit('a', 1);
    budget.admit('a', 1);
    expect(budget.hasGlobalCapacity()).toBe(false);
    // Peeking did not consume capacity or throw.
    expect(budget.getInboundCount()).toBe(2);
  });

  it('prunes the global window as time advances', () => {
    const budget = new InboundBudget({ maxInboundPerMinute: 2, maxPayloadBytesPerMinute: 0 });
    const t0 = 1_000_000;
    expect(budget.admit('a', 1, t0).admitted).toBe(true);
    expect(budget.admit('a', 1, t0).admitted).toBe(true);
    expect(budget.admit('a', 1, t0).admitted).toBe(false);
    // 61s later the earlier timestamps have aged out of the window.
    expect(budget.admit('a', 1, t0 + 61_000).admitted).toBe(true);
  });

  it('disables checks when limits are zero', () => {
    const budget = new InboundBudget({ maxInboundPerMinute: 0, maxPayloadBytesPerMinute: 0 });
    for (let i = 0; i < 1000; i++) {
      expect(budget.admit('a', 1_000_000).admitted).toBe(true);
    }
  });
});
