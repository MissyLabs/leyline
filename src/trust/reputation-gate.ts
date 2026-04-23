/**
 * @module reputation-gate
 *
 * Optional reputation threshold gating for the Leyline trust pipeline.
 *
 * {@link ReputationGate} wraps a {@link PeerReputation} instance and exposes a
 * single `check()` predicate that returns `false` when a peer's score falls
 * below a configurable threshold. By default the threshold is `-Infinity` so
 * the gate is a no-op — existing code is unaffected unless a threshold is
 * explicitly configured.
 *
 * Typical usage:
 * ```ts
 * const gate = new ReputationGate(peerReputation, { threshold: 0, action: 'deny' });
 *
 * // In your message handler:
 * if (!gate.check(senderPeerId)) {
 *   // drop or log the message
 * }
 * ```
 */

import type { PeerReputation } from './peer-reputation.js';

// ---------------------------------------------------------------------------
// Configuration interface
// ---------------------------------------------------------------------------

/**
 * Configuration for a {@link ReputationGate}.
 */
export interface ReputationGateConfig {
  /**
   * Minimum reputation score required to pass the gate.
   *
   * Peers whose score is strictly below this value will fail the check.
   * Setting this to `-Infinity` (the default) effectively disables the gate
   * so that all peers pass regardless of score.
   *
   * @defaultValue -Infinity (disabled)
   */
  threshold: number;

  /**
   * Action taken when a peer fails the threshold check.
   *
   * - `'deny'` — `check()` returns `false` so callers can drop the message.
   * - `'warn'` — `check()` still returns `true` but the failure is noted
   *   (callers can use `getLastWarning()` or hook into their own logging).
   *
   * @defaultValue 'deny'
   */
  action: 'deny' | 'warn';
}

// ---------------------------------------------------------------------------
// ReputationGate
// ---------------------------------------------------------------------------

/**
 * Wraps a {@link PeerReputation} instance to provide a lightweight pass/fail
 * gate based on a configurable score threshold.
 *
 * The gate is backwards-compatible: when constructed without explicit config
 * (or with `threshold: -Infinity`) it never blocks any peer.
 */
export class ReputationGate {
  private readonly reputation: PeerReputation;
  private readonly config: ReputationGateConfig;

  constructor(reputation: PeerReputation, config?: Partial<ReputationGateConfig>) {
    this.reputation = reputation;
    this.config = { threshold: -Infinity, action: 'deny', ...config };
  }

  /**
   * Returns `true` if the peer's reputation score is at or above the
   * configured threshold, `false` otherwise (in `'deny'` mode).
   *
   * When the gate is in `'warn'` mode this method always returns `true` —
   * callers are responsible for acting on the warning separately.
   *
   * When the threshold is `-Infinity` (disabled) this always returns `true`.
   *
   * @param peerId - The peer identity to evaluate (same key used by
   *   {@link PeerReputation.getScore}).
   */
  check(peerId: string): boolean {
    if (this.config.threshold === -Infinity) return true; // disabled

    const score = this.reputation.getScore(peerId);
    const passes = score >= this.config.threshold;

    if (!passes && this.config.action === 'warn') {
      // In warn mode the gate logs the intent but does not block.
      return true;
    }

    return passes;
  }

  /** Return the currently configured minimum score threshold. */
  getThreshold(): number {
    return this.config.threshold;
  }

  /**
   * Update the minimum score threshold at runtime.
   *
   * Setting to `-Infinity` disables the gate entirely without needing to
   * recreate the instance.
   */
  setThreshold(threshold: number): void {
    this.config.threshold = threshold;
  }

  /**
   * Return the currently configured action taken on threshold failure.
   */
  getAction(): 'deny' | 'warn' {
    return this.config.action;
  }

  /**
   * Update the action taken when a peer fails the threshold check at runtime.
   */
  setAction(action: 'deny' | 'warn'): void {
    this.config.action = action;
  }
}
