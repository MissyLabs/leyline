import { Logger } from './logger.js';

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  cooldownMs?: number;
  maxTrackedPeers?: number;
}

interface PeerCircuit {
  failures: number;
  openUntil: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_TRACKED = 5000;

export class CircuitBreaker {
  readonly #circuits = new Map<string, PeerCircuit>();
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;
  readonly #maxTracked: number;
  readonly #log = new Logger('CircuitBreaker');

  constructor(config: CircuitBreakerConfig = {}) {
    this.#failureThreshold = config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.#cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#maxTracked = config.maxTrackedPeers ?? DEFAULT_MAX_TRACKED;
  }

  isOpen(peerId: string): boolean {
    const circuit = this.#circuits.get(peerId);
    if (!circuit) return false;
    if (circuit.openUntil === 0) return false;
    if (Date.now() >= circuit.openUntil) {
      circuit.openUntil = 0;
      circuit.failures = 0;
      return false;
    }
    return true;
  }

  recordFailure(peerId: string): void {
    let circuit = this.#circuits.get(peerId);
    if (!circuit) {
      if (this.#circuits.size >= this.#maxTracked) {
        this.#evictOldest();
      }
      circuit = { failures: 0, openUntil: 0 };
      this.#circuits.set(peerId, circuit);
    }
    circuit.failures++;
    if (circuit.failures >= this.#failureThreshold) {
      circuit.openUntil = Date.now() + this.#cooldownMs;
      this.#log.debug('Circuit opened for peer', { peerId: peerId.slice(0, 16), cooldownMs: this.#cooldownMs });
    }
  }

  recordSuccess(peerId: string): void {
    const circuit = this.#circuits.get(peerId);
    if (circuit) {
      circuit.failures = 0;
      circuit.openUntil = 0;
    }
  }

  reset(peerId: string): void {
    this.#circuits.delete(peerId);
  }

  clear(): void {
    this.#circuits.clear();
  }

  get size(): number {
    return this.#circuits.size;
  }

  getOpenPeers(): string[] {
    const now = Date.now();
    const result: string[] = [];
    for (const [peerId, circuit] of this.#circuits) {
      if (circuit.openUntil > 0 && now < circuit.openUntil) {
        result.push(peerId);
      }
    }
    return result;
  }

  #evictOldest(): void {
    const first = this.#circuits.keys().next();
    if (!first.done) {
      this.#circuits.delete(first.value);
    }
  }
}
