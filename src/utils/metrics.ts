import { EventEmitter } from 'node:events';

export interface MetricEvent {
  name: string;
  value: number;
  tags?: Record<string, string>;
  timestamp: number;
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
}

export class NodeMetrics extends EventEmitter {
  private counters = new Map<string, number>();
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

  snapshot(): MetricsSnapshot {
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
    };
  }

  reset(): void {
    this.counters.clear();
  }
}
