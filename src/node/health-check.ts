import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Libp2p } from 'libp2p';
import { LEYLINE_VERSION } from '../config/compat.js';
import { Logger } from '../utils/logger.js';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number;
  peers: number;
  topics: number;
  bufferedMessages: number;
  knownPeers: number;
  ledgerEntries: number;
}

export interface HealthCheckDeps {
  libp2p: Libp2p;
  getTopicCount: () => number;
  getBufferedMessageCount: () => number;
  getKnownPeerCount: () => number;
  getLedgerEntryCount: () => Promise<number>;
  /** Optional: return all metric counters for the /metrics endpoint (JSON format). */
  getMetrics?: () => Record<string, number>;
  /**
   * Optional: return metrics in Prometheus text exposition format.
   *
   * When provided, requests to `/metrics` that include `Accept: text/plain`
   * (or any request to `/metrics/prometheus`) will receive the Prometheus
   * text format with `Content-Type: text/plain; version=0.0.4` instead of
   * the default JSON response.
   */
  getPrometheusMetrics?: () => string;
}

export class HealthCheckServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly deps: HealthCheckDeps;
  private readonly startedAt = Date.now();
  private readonly log = new Logger('HealthCheckServer');

  constructor(port: number, deps: HealthCheckDeps) {
    this.port = port;
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.port <= 0) return;

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '0.0.0.0', () => resolve());
      this.server!.once('error', reject);
    });

    this.log.info('HTTP health check listening', { port: this.port });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === '/health' || req.url === '/') {
      this.getHealth().then((health) => {
        const statusCode = health.status === 'ok' ? 200 : health.status === 'degraded' ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
      }).catch(() => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error' }));
      });
    } else if (req.url === '/metrics/prometheus') {
      // Explicit Prometheus endpoint — always returns text format.
      if (this.deps.getPrometheusMetrics) {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(this.deps.getPrometheusMetrics());
      } else if (this.deps.getMetrics) {
        // Fallback: convert JSON counters to a simple Prometheus text response.
        const counters = this.deps.getMetrics();
        const lines: string[] = [];
        for (const [name, value] of Object.entries(counters)) {
          const promName = `leyline_${name.replace(/\./g, '_')}`;
          lines.push(`# TYPE ${promName} counter`);
          lines.push(`${promName} ${value}`);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(lines.join('\n') + '\n');
      } else {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'metrics not available' }));
      }
    } else if (req.url === '/metrics') {
      // Check whether the client prefers Prometheus text format via Accept header.
      const acceptHeader = req.headers['accept'] ?? '';
      const wantsText = acceptHeader.includes('text/plain');

      if (wantsText && this.deps.getPrometheusMetrics) {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(this.deps.getPrometheusMetrics());
      } else if (this.deps.getMetrics) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.deps.getMetrics()));
      } else {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'metrics not available' }));
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  private async getHealth(): Promise<HealthStatus> {
    const peerCount = this.deps.libp2p.getPeers().length;
    let ledgerEntries = 0;
    try {
      ledgerEntries = await this.deps.getLedgerEntryCount();
    } catch { /* ignore */ }

    const status: HealthStatus['status'] = peerCount > 0 ? 'ok' : 'degraded';

    return {
      status,
      version: LEYLINE_VERSION,
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      peers: peerCount,
      topics: this.deps.getTopicCount(),
      bufferedMessages: this.deps.getBufferedMessageCount(),
      knownPeers: this.deps.getKnownPeerCount(),
      ledgerEntries,
    };
  }
}
