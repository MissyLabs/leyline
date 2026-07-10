/**
 * @module stream-gate
 *
 * Per-peer in-flight stream concurrency limiter for inbound protocol handlers.
 *
 * libp2p stream handlers will happily accept unlimited concurrent streams from
 * a single peer. During churn or abuse this can exhaust memory. A `StreamGate`
 * caps how many inbound streams a single remote peer may have in flight for a
 * given protocol at once; excess streams are rejected (closed) immediately.
 */
export class StreamGate {
  private readonly maxPerPeer: number;
  private readonly counts = new Map<string, number>();

  constructor(maxPerPeer = 32) {
    this.maxPerPeer = Math.max(1, maxPerPeer);
  }

  /**
   * Try to reserve a slot for `peerId`. Returns true if acquired (caller must
   * later call {@link release}), false if the peer is already at the cap.
   */
  tryAcquire(peerId: string): boolean {
    const current = this.counts.get(peerId) ?? 0;
    if (current >= this.maxPerPeer) return false;
    this.counts.set(peerId, current + 1);
    return true;
  }

  /** Release a previously acquired slot for `peerId`. */
  release(peerId: string): void {
    const current = this.counts.get(peerId) ?? 0;
    if (current <= 1) this.counts.delete(peerId);
    else this.counts.set(peerId, current - 1);
  }

  /** Current in-flight count for a peer (mainly for tests/metrics). */
  inFlight(peerId: string): number {
    return this.counts.get(peerId) ?? 0;
  }

  clear(): void {
    this.counts.clear();
  }
}
