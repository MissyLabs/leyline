/**
 * @module jitter
 *
 * Small helpers for de-synchronizing fleet-wide periodic timers.
 *
 * Fixed-interval timers cause a thundering herd: many nodes that started
 * together (e.g. after a coordinated redeploy) fire on the same boundaries and
 * hit the seeds in lockstep. Applying a per-node random period offset spreads
 * that load out over time.
 */

/**
 * Return `baseMs` perturbed by ±`frac` (default ±15%).
 *
 * Used once per timer creation so that each node runs its periodic tasks on a
 * slightly different cadence, avoiding fleet-wide synchronization.
 */
export function jitteredPeriod(baseMs: number, frac = 0.15): number {
  const span = baseMs * frac;
  return Math.max(1, Math.round(baseMs - span + Math.random() * span * 2));
}
