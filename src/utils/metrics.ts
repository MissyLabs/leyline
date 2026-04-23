import { EventEmitter } from 'node:events';

export interface MetricEvent {
  name: string;
  value: number;
  tags?: Record<string, string>;
  timestamp: number;
}

export interface HistogramStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricsSnapshot {
  messagesReceived: number;
  messagesBlocked: number;
  messagesSent: number;
  peerConnections: number;
  peerDisconnections: number;
  trustDenials: number;
  rateLimitHits: number;
  signatureFailures: number;
  ledgerSubmissions: number;
  ledgerConfirmations: number;
  discoveryQueries: number;
  dmSent: number;
  dmReceived: number;
  uptime: number;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramStats>;
}

const MAX_HISTOGRAM_SAMPLES = 1000;

export class NodeMetrics extends EventEmitter {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  private readonly startTime = Date.now();

  increment(name: string, amount: number = 1, tags?: Record<string, string>): void {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + amount);

    const event: MetricEvent = {
      name,
      value: current + amount,
      tags,
      timestamp: Date.now(),
    };
    this.emit('metric', event);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  getGauge(name: string): number {
    return this.gauges.get(name) ?? 0;
  }

  observe(name: string, value: number): void {
    let samples = this.histograms.get(name);
    if (!samples) {
      samples = [];
      this.histograms.set(name, samples);
    }
    samples.push(value);
    if (samples.length > MAX_HISTOGRAM_SAMPLES) {
      samples.splice(0, samples.length - MAX_HISTOGRAM_SAMPLES);
    }
  }

  histogram(name: string): HistogramStats | null {
    const samples = this.histograms.get(name);
    if (!samples || samples.length === 0) return null;

    const sorted = [...samples].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      count,
      min: sorted[0]!,
      max: sorted[count - 1]!,
      mean: sum / count,
      p50: sorted[Math.floor(count * 0.5)]!,
      p95: sorted[Math.floor(count * 0.95)]!,
      p99: sorted[Math.min(Math.floor(count * 0.99), count - 1)]!,
    };
  }

  /** Get all counter values as a plain object for operator diagnostics. */
  allCounters(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) out[k] = v;
    return out;
  }

  snapshot(): MetricsSnapshot {
    const gaugeEntries: Record<string, number> = {};
    for (const [k, v] of this.gauges) gaugeEntries[k] = v;

    const histogramEntries: Record<string, HistogramStats> = {};
    for (const name of this.histograms.keys()) {
      const stats = this.histogram(name);
      if (stats) histogramEntries[name] = stats;
    }

    return {
      messagesReceived: this.get('messages.received'),
      messagesBlocked: this.get('messages.blocked'),
      messagesSent: this.get('messages.sent'),
      peerConnections: this.get('peers.connected'),
      peerDisconnections: this.get('peers.disconnected'),
      trustDenials: this.get('trust.denied'),
      rateLimitHits: this.get('ratelimit.hit'),
      signatureFailures: this.get('signature.failed'),
      ledgerSubmissions: this.get('ledger.submitted'),
      ledgerConfirmations: this.get('ledger.confirmed'),
      discoveryQueries: this.get('discovery.queries'),
      dmSent: this.get('dm.sent'),
      dmReceived: this.get('dm.received'),
      uptime: Date.now() - this.startTime,
      gauges: gaugeEntries,
      histograms: histogramEntries,
    };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  /**
   * Export all metrics in the
   * [Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/).
   *
   * Each well-known counter from {@link snapshot} is exported as a Prometheus
   * `counter`, all gauge values as `gauge`, and all histogram samples as a
   * `summary` (with count, mean, p50, p95, and p99 quantiles).
   *
   * Metric names follow the `leyline_<name>` convention and `.` separators in
   * internal names are replaced with `_` to comply with Prometheus naming rules.
   *
   * @returns A UTF-8 string in Prometheus text format, terminated with a
   *   trailing newline as required by the specification.
   */
  toPrometheus(): string {
    const lines: string[] = [];
    const snap = this.snapshot();

    // Export the named snapshot counter fields
    const counterFields: [string, number][] = [
      ['messages_received', snap.messagesReceived],
      ['messages_blocked', snap.messagesBlocked],
      ['messages_sent', snap.messagesSent],
      ['peer_connections', snap.peerConnections],
      ['peer_disconnections', snap.peerDisconnections],
      ['trust_denials', snap.trustDenials],
      ['ratelimit_hits', snap.rateLimitHits],
      ['signature_failures', snap.signatureFailures],
      ['ledger_submissions', snap.ledgerSubmissions],
      ['ledger_confirmations', snap.ledgerConfirmations],
      ['discovery_queries', snap.discoveryQueries],
      ['dm_sent', snap.dmSent],
      ['dm_received', snap.dmReceived],
    ];
    for (const [name, value] of counterFields) {
      lines.push(`# TYPE leyline_${name} counter`);
      lines.push(`leyline_${name} ${value}`);
    }

    // Uptime is a gauge (resets on restart), not a counter
    lines.push('# TYPE leyline_uptime_ms gauge');
    lines.push(`leyline_uptime_ms ${snap.uptime}`);

    // Gauges
    for (const [name, value] of Object.entries(snap.gauges)) {
      const promName = name.replace(/\./g, '_');
      lines.push(`# TYPE leyline_${promName} gauge`);
      lines.push(`leyline_${promName} ${value}`);
    }

    // Histograms — exported as Prometheus summary metrics
    for (const [name, stats] of Object.entries(snap.histograms)) {
      const promName = name.replace(/\./g, '_');
      lines.push(`# TYPE leyline_${promName} summary`);
      lines.push(`leyline_${promName}_count ${stats.count}`);
      lines.push(`leyline_${promName}{quantile="0.5"} ${stats.p50.toFixed(3)}`);
      lines.push(`leyline_${promName}{quantile="0.95"} ${stats.p95.toFixed(3)}`);
      lines.push(`leyline_${promName}{quantile="0.99"} ${stats.p99.toFixed(3)}`);
    }

    return lines.join('\n') + '\n';
  }
}
