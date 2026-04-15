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
