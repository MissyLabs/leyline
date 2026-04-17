import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PartitionDetector, type PartitionEvent } from '../src/utils/partition-detector.js';

describe('PartitionDetector', () => {
  let detector: PartitionDetector;
  let events: PartitionEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new PartitionDetector({
      dropThreshold: 0.5,
      minDropCount: 2,
      minPeakBeforeDetection: 3,
      peakDecayMs: 300_000,
    });
    events = [];
    detector.on('partition', (e: PartitionEvent) => events.push(e));
  });

  afterEach(() => {
    vi.useRealTimers();
    detector.removeAllListeners();
  });

  it('does not detect partition with too few peers', () => {
    detector.updatePeerCount(2);
    detector.updatePeerCount(0);
    expect(events).toHaveLength(0);
    expect(detector.isPartitionSuspected()).toBe(false);
  });

  it('detects partition when peer count drops >= 50%', () => {
    detector.updatePeerCount(6);
    detector.updatePeerCount(2);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('partition_suspected');
    expect(events[0].peerCount).toBe(2);
    expect(events[0].peakPeerCount).toBe(6);
    expect(detector.isPartitionSuspected()).toBe(true);
  });

  it('does not detect partition for small absolute drops', () => {
    // minDropCount is 2, so losing 1 of 3 peers shouldn't trigger
    detector.updatePeerCount(3);
    detector.updatePeerCount(2);
    expect(events).toHaveLength(0);
  });

  it('resolves partition when peers recover', () => {
    detector.updatePeerCount(6);
    detector.updatePeerCount(2);
    expect(detector.isPartitionSuspected()).toBe(true);

    detector.updatePeerCount(5);
    expect(detector.isPartitionSuspected()).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('partition_resolved');
  });

  it('tracks peak peer count', () => {
    detector.updatePeerCount(4);
    detector.updatePeerCount(8);
    detector.updatePeerCount(6);
    expect(detector.getPeakPeerCount()).toBe(8);
    expect(detector.getCurrentPeerCount()).toBe(6);
  });

  it('does not emit duplicate partition events', () => {
    detector.updatePeerCount(6);
    detector.updatePeerCount(2);
    detector.updatePeerCount(1);
    detector.updatePeerCount(0);
    // Only one partition_suspected event despite multiple low updates
    expect(events.filter(e => e.type === 'partition_suspected')).toHaveLength(1);
  });

  it('decays peak peer count over time', () => {
    detector.updatePeerCount(10);
    detector.updatePeerCount(4);
    expect(detector.isPartitionSuspected()).toBe(true);

    // After peakDecayMs, peak decays toward current
    vi.advanceTimersByTime(300_001);
    detector.updatePeerCount(4);
    // Peak should have decayed: floor(10 * 0.75) = 7
    expect(detector.getPeakPeerCount()).toBe(7);
  });

  it('decays peak enough to resolve partition', () => {
    detector.updatePeerCount(10);
    detector.updatePeerCount(4);
    expect(detector.isPartitionSuspected()).toBe(true);

    // After enough decay cycles, partition resolves
    vi.advanceTimersByTime(300_001);
    detector.updatePeerCount(4);
    vi.advanceTimersByTime(300_001);
    detector.updatePeerCount(4);
    // Peak decayed: floor(7 * 0.75) = 5, current = 4, drop = 1 < minDropCount(2)
    expect(detector.isPartitionSuspected()).toBe(false);
  });

  it('includes seed connectivity in events', () => {
    detector.updatePeerCount(6);
    detector.updateSeedConnectivity(2, 4);
    detector.updatePeerCount(2);

    expect(events[0].seedsConnected).toBe(2);
    expect(events[0].seedsTotal).toBe(4);
  });

  it('seed loss alone can trigger evaluation', () => {
    detector.updatePeerCount(6);
    detector.updatePeerCount(2);
    expect(events).toHaveLength(1);

    detector.updateSeedConnectivity(0, 4);
    // Does not emit a second partition_suspected (already suspected)
    expect(events).toHaveLength(1);
  });

  it('reset clears all state', () => {
    detector.updatePeerCount(6);
    detector.updatePeerCount(2);
    expect(detector.isPartitionSuspected()).toBe(true);

    detector.reset();
    expect(detector.isPartitionSuspected()).toBe(false);
    expect(detector.getPeakPeerCount()).toBe(0);
    expect(detector.getCurrentPeerCount()).toBe(0);
  });

  it('works with custom config', () => {
    const strict = new PartitionDetector({
      dropThreshold: 0.3,
      minDropCount: 1,
      minPeakBeforeDetection: 2,
    });
    const strictEvents: PartitionEvent[] = [];
    strict.on('partition', (e: PartitionEvent) => strictEvents.push(e));

    strict.updatePeerCount(4);
    strict.updatePeerCount(2);
    expect(strict.isPartitionSuspected()).toBe(true);
    expect(strictEvents).toHaveLength(1);
    strict.removeAllListeners();
  });

  it('gradual peer loss does not trigger false positive', () => {
    detector.updatePeerCount(6);
    detector.updatePeerCount(5);
    detector.updatePeerCount(4);
    // Still above 50% threshold (dropped 2, which is 33%)
    expect(detector.isPartitionSuspected()).toBe(false);
  });

  it('gradual peer loss below threshold eventually triggers', () => {
    detector.updatePeerCount(6);
    detector.updatePeerCount(5);
    detector.updatePeerCount(4);
    detector.updatePeerCount(3);
    // Dropped 3 of 6 = 50% — exactly at threshold
    expect(detector.isPartitionSuspected()).toBe(true);
  });

  it('peer count of zero after having many peers triggers partition', () => {
    detector.updatePeerCount(10);
    detector.updatePeerCount(0);
    expect(detector.isPartitionSuspected()).toBe(true);
    expect(events[0].reason).toContain('100%');
  });

  it('growing peer count never triggers partition', () => {
    for (let i = 0; i <= 20; i++) {
      detector.updatePeerCount(i);
    }
    expect(events).toHaveLength(0);
  });
});
