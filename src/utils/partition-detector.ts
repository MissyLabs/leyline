import { EventEmitter } from 'node:events';
import { Logger } from './logger.js';

export interface PartitionEvent {
  type: 'partition_suspected' | 'partition_resolved' | 'peer_count_low';
  peerCount: number;
  peakPeerCount: number;
  seedsConnected: number;
  seedsTotal: number;
  timestamp: number;
  reason: string;
}

export interface PartitionDetectorConfig {
  /** Fraction of peak peers that must be lost to suspect a partition (0-1). Default: 0.5 */
  dropThreshold: number;
  /** Minimum absolute peers lost before a partition is suspected. Default: 2 */
  minDropCount: number;
  /** Minimum peer count we need to have seen before detecting drops. Default: 3 */
  minPeakBeforeDetection: number;
  /** Duration (ms) after which peakPeerCount decays toward current if stable. Default: 300_000 (5m) */
  peakDecayMs: number;
}

const DEFAULT_CONFIG: PartitionDetectorConfig = {
  dropThreshold: 0.5,
  minDropCount: 2,
  minPeakBeforeDetection: 3,
  peakDecayMs: 300_000,
};

export class PartitionDetector extends EventEmitter {
  private readonly config: PartitionDetectorConfig;
  private readonly log: Logger;
  private peakPeerCount = 0;
  private currentPeerCount = 0;
  private partitionSuspected = false;
  private lastStableTimestamp = Date.now();
  private seedsConnected = 0;
  private seedsTotal = 0;

  constructor(config: Partial<PartitionDetectorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = new Logger('PartitionDetector');
  }

  updatePeerCount(count: number): void {
    this.currentPeerCount = count;

    if (count > this.peakPeerCount) {
      this.peakPeerCount = count;
      this.lastStableTimestamp = Date.now();
    }

    this.decayPeak();
    this.evaluate();
  }

  updateSeedConnectivity(connected: number, total: number): void {
    this.seedsConnected = connected;
    this.seedsTotal = total;
    this.evaluate();
  }

  isPartitionSuspected(): boolean {
    return this.partitionSuspected;
  }

  getPeakPeerCount(): number {
    return this.peakPeerCount;
  }

  getCurrentPeerCount(): number {
    return this.currentPeerCount;
  }

  reset(): void {
    this.peakPeerCount = 0;
    this.currentPeerCount = 0;
    this.partitionSuspected = false;
    this.lastStableTimestamp = Date.now();
    this.seedsConnected = 0;
    this.seedsTotal = 0;
  }

  private decayPeak(): void {
    const elapsed = Date.now() - this.lastStableTimestamp;
    if (elapsed >= this.config.peakDecayMs && this.currentPeerCount < this.peakPeerCount) {
      this.peakPeerCount = Math.max(this.currentPeerCount, Math.floor(this.peakPeerCount * 0.75));
      this.lastStableTimestamp = Date.now();
    }
  }

  private evaluate(): void {
    if (this.peakPeerCount < this.config.minPeakBeforeDetection) return;

    const dropped = this.peakPeerCount - this.currentPeerCount;
    const dropFraction = dropped / this.peakPeerCount;

    const shouldSuspect =
      dropped >= this.config.minDropCount &&
      dropFraction >= this.config.dropThreshold;

    if (shouldSuspect && !this.partitionSuspected) {
      this.partitionSuspected = true;
      const reason = `Lost ${dropped}/${this.peakPeerCount} peers (${(dropFraction * 100).toFixed(0)}% drop). Seeds: ${this.seedsConnected}/${this.seedsTotal}`;
      this.log.warn('Network partition suspected', { dropped, peak: this.peakPeerCount, current: this.currentPeerCount });

      const event: PartitionEvent = {
        type: 'partition_suspected',
        peerCount: this.currentPeerCount,
        peakPeerCount: this.peakPeerCount,
        seedsConnected: this.seedsConnected,
        seedsTotal: this.seedsTotal,
        timestamp: Date.now(),
        reason,
      };
      this.emit('partition', event);
    } else if (!shouldSuspect && this.partitionSuspected) {
      this.partitionSuspected = false;
      this.log.info('Network partition resolved', { current: this.currentPeerCount, peak: this.peakPeerCount });

      const event: PartitionEvent = {
        type: 'partition_resolved',
        peerCount: this.currentPeerCount,
        peakPeerCount: this.peakPeerCount,
        seedsConnected: this.seedsConnected,
        seedsTotal: this.seedsTotal,
        timestamp: Date.now(),
        reason: `Peer count recovered to ${this.currentPeerCount}`,
      };
      this.emit('partition', event);
    }
  }
}
