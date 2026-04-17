/**
 * Peer reputation scoring system.
 *
 * Tracks per-peer quality signals (successful exchanges, failed exchanges,
 * spam reports, protocol violations) and computes a bounded reputation score.
 *
 * Scores decay toward neutral over time so that peers can recover from
 * transient misbehavior. Persistently bad peers accumulate permanent
 * penalty via violation counts.
 */

export interface PeerReputationRecord {
  peerId: string;
  score: number;
  successCount: number;
  failureCount: number;
  spamCount: number;
  violationCount: number;
  lastUpdated: number;
}

export interface PeerReputationConfig {
  /** Starting score for unknown peers. Default: 50 */
  initialScore: number;
  /** Maximum score a peer can reach. Default: 100 */
  maxScore: number;
  /** Minimum score (floor). Default: -100 */
  minScore: number;
  /** Score added per successful exchange. Default: 1 */
  successReward: number;
  /** Score subtracted per failed exchange. Default: 2 */
  failurePenalty: number;
  /** Score subtracted per spam report. Default: 5 */
  spamPenalty: number;
  /** Score subtracted per protocol violation. Default: 10 */
  violationPenalty: number;
  /** Score below which a peer is considered untrusted. Default: 0 */
  untrustedThreshold: number;
  /** Half-life for score decay toward initial, in milliseconds. Default: 3600000 (1 hour) */
  decayHalfLifeMs: number;
  /** Maximum number of tracked peers. Default: 10000 */
  maxPeers: number;
}

const DEFAULT_CONFIG: PeerReputationConfig = {
  initialScore: 50,
  maxScore: 100,
  minScore: -100,
  successReward: 1,
  failurePenalty: 2,
  spamPenalty: 5,
  violationPenalty: 10,
  untrustedThreshold: 0,
  decayHalfLifeMs: 3_600_000,
  maxPeers: 10_000,
};

export class PeerReputation {
  readonly #config: PeerReputationConfig;
  readonly #peers: Map<string, PeerReputationRecord> = new Map();

  constructor(config: Partial<PeerReputationConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  #getOrCreate(peerId: string): PeerReputationRecord {
    let record = this.#peers.get(peerId);
    if (!record) {
      record = {
        peerId,
        score: this.#config.initialScore,
        successCount: 0,
        failureCount: 0,
        spamCount: 0,
        violationCount: 0,
        lastUpdated: Date.now(),
      };
      this.#peers.set(peerId, record);
      this.#evictIfNeeded();
    }
    return record;
  }

  #clampScore(score: number): number {
    return Math.max(this.#config.minScore, Math.min(this.#config.maxScore, score));
  }

  #applyDecay(record: PeerReputationRecord): void {
    const now = Date.now();
    const elapsed = now - record.lastUpdated;
    if (elapsed <= 0) return;

    const halfLife = this.#config.decayHalfLifeMs;
    const decayFactor = Math.pow(0.5, elapsed / halfLife);
    const initial = this.#config.initialScore;
    record.score = initial + (record.score - initial) * decayFactor;
    record.lastUpdated = now;
  }

  #evictIfNeeded(): void {
    if (this.#peers.size <= this.#config.maxPeers) return;
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, rec] of this.#peers) {
      if (rec.lastUpdated < oldestTime) {
        oldestTime = rec.lastUpdated;
        oldestKey = key;
      }
    }
    if (oldestKey) this.#peers.delete(oldestKey);
  }

  recordSuccess(peerId: string): void {
    const rec = this.#getOrCreate(peerId);
    this.#applyDecay(rec);
    rec.successCount++;
    rec.score = this.#clampScore(rec.score + this.#config.successReward);
    rec.lastUpdated = Date.now();
  }

  recordFailure(peerId: string): void {
    const rec = this.#getOrCreate(peerId);
    this.#applyDecay(rec);
    rec.failureCount++;
    rec.score = this.#clampScore(rec.score - this.#config.failurePenalty);
    rec.lastUpdated = Date.now();
  }

  recordSpam(peerId: string): void {
    const rec = this.#getOrCreate(peerId);
    this.#applyDecay(rec);
    rec.spamCount++;
    rec.score = this.#clampScore(rec.score - this.#config.spamPenalty);
    rec.lastUpdated = Date.now();
  }

  recordViolation(peerId: string): void {
    const rec = this.#getOrCreate(peerId);
    this.#applyDecay(rec);
    rec.violationCount++;
    rec.score = this.#clampScore(rec.score - this.#config.violationPenalty);
    rec.lastUpdated = Date.now();
  }

  getScore(peerId: string): number {
    const rec = this.#peers.get(peerId);
    if (!rec) return this.#config.initialScore;
    this.#applyDecay(rec);
    return rec.score;
  }

  getRecord(peerId: string): PeerReputationRecord | undefined {
    const rec = this.#peers.get(peerId);
    if (rec) this.#applyDecay(rec);
    return rec ? { ...rec } : undefined;
  }

  isTrusted(peerId: string): boolean {
    return this.getScore(peerId) >= this.#config.untrustedThreshold;
  }

  /**
   * Get all peers sorted by score (highest first).
   * Useful for prioritizing which peers to connect to or exchange with.
   */
  getRankedPeers(): PeerReputationRecord[] {
    const records: PeerReputationRecord[] = [];
    for (const rec of this.#peers.values()) {
      this.#applyDecay(rec);
      records.push({ ...rec });
    }
    records.sort((a, b) => b.score - a.score);
    return records;
  }

  /** Get the number of tracked peers. */
  get size(): number {
    return this.#peers.size;
  }

  /** Remove a peer from the reputation tracker. */
  remove(peerId: string): boolean {
    return this.#peers.delete(peerId);
  }

  /** Clear all tracked peers. */
  clear(): void {
    this.#peers.clear();
  }
}
