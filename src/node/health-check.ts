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

/** Operational snapshot rendered by the `/dashboard` endpoint (FEAT-3). */
export interface DashboardData {
  version: string;
  uptimeSeconds: number;
  peers: number;
  connectedSeeds: number;
  totalSeeds: number;
  degraded: boolean;
  mirroredTopics: number;
  bufferedMessages: number;
  knownPeers: number;
  ledgerEntries: number;
  /** version → count across connected peers. */
  versionDistribution: Record<string, number>;
  /** Most recent degraded/partition/recovery events, newest first. */
  recentEvents: string[];
}

export interface HealthCheckDeps {
  libp2p: Libp2p;
  getTopicCount: () => number;
  getBufferedMessageCount: () => number;
  getKnownPeerCount: () => number;
  getLedgerEntryCount: () => Promise<number>;
  /** Optional: return all metric counters for the /metrics endpoint (JSON format). */
  getMetrics?: () => Record<string, number>;
  /** Optional: return the seed-mesh / network health snapshot for /dashboard (FEAT-3). */
  getDashboard?: () => Promise<DashboardData>;
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

/** Options controlling the health-check server's exposure (SEC-4). */
export interface HealthCheckOptions {
  /** Bind address. Defaults to `127.0.0.1` so metrics are not exposed publicly. */
  bind?: string;
  /**
   * Optional bearer token. When set, `/metrics` and `/metrics/prometheus`
   * require `Authorization: Bearer <token>`. `/health` stays unauthenticated.
   */
  authToken?: string;
}

export class HealthCheckServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly deps: HealthCheckDeps;
  private readonly startedAt = Date.now();
  private readonly log = new Logger('HealthCheckServer');
  private readonly bind: string;
  private readonly authToken?: string;

  constructor(port: number, deps: HealthCheckDeps, opts: HealthCheckOptions = {}) {
    this.port = port;
    this.deps = deps;
    this.bind = opts.bind ?? '127.0.0.1';
    this.authToken = opts.authToken;
  }

  async start(): Promise<void> {
    if (this.port <= 0) return;

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.bind, () => resolve());
      this.server!.once('error', reject);
    });

    if (this.bind === '0.0.0.0' && !this.authToken) {
      this.log.warn('Health server bound to 0.0.0.0 without an auth token — /metrics is publicly readable', { port: this.port });
    }
    this.log.info('HTTP health check listening', { port: this.port, bind: this.bind, auth: this.authToken ? 'bearer' : 'none' });
  }

  /** True if the request carries the required bearer token (or none is required). */
  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.authToken) return true;
    const header = req.headers['authorization'] ?? '';
    return header === `Bearer ${this.authToken}`;
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
      if (!this.isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
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
    } else if (req.url === '/dashboard') {
      // FEAT-3: authenticated, server-rendered seed-mesh & network health page.
      if (!this.isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer' });
        res.end('unauthorized');
        return;
      }
      if (!this.deps.getDashboard) {
        res.writeHead(501, { 'Content-Type': 'text/plain' });
        res.end('dashboard not available');
        return;
      }
      this.deps.getDashboard().then((data) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDashboard(data));
      }).catch(() => {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('dashboard error');
      });
    } else if (req.url === '/metrics') {
      if (!this.isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
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

/** Minimal HTML escaping for values interpolated into the dashboard. */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the seed-mesh & network health dashboard as a fully self-contained HTML
 * page (inline CSS, no external assets) — safe to serve behind the bearer token.
 */
function renderDashboard(d: DashboardData): string {
  const seedPct = d.totalSeeds > 0 ? Math.round((d.connectedSeeds / d.totalSeeds) * 100) : 0;
  const versionRows = Object.entries(d.versionDistribution)
    .sort((a, b) => b[1] - a[1])
    .map(([v, c]) => `<tr><td>${esc(v)}</td><td>${esc(c)}</td></tr>`)
    .join('') || '<tr><td colspan="2">no peers</td></tr>';
  const events = d.recentEvents.length > 0
    ? d.recentEvents.map((e) => `<li>${esc(e)}</li>`).join('')
    : '<li>none</li>';
  const uptimeH = Math.floor(d.uptimeSeconds / 3600);
  const uptimeM = Math.floor((d.uptimeSeconds % 3600) / 60);

  const card = (label: string, value: unknown, accent = '#4b5563') =>
    `<div class="card"><div class="v" style="color:${accent}">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leyline seed health</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#0f1115;color:#e6e6e6}
  h1{font-size:18px;margin:0 0 4px}
  .sub{color:#9aa0aa;margin:0 0 20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:24px}
  .card{background:#191c24;border:1px solid #262a34;border-radius:10px;padding:14px}
  .card .v{font-size:24px;font-weight:600}
  .card .l{color:#9aa0aa;font-size:12px;margin-top:4px}
  .bar{height:8px;background:#262a34;border-radius:5px;overflow:hidden;margin-top:8px}
  .bar>span{display:block;height:100%;background:${d.degraded ? '#dc2626' : '#16a34a'}}
  table{border-collapse:collapse;width:100%;max-width:420px}
  td{border-bottom:1px solid #262a34;padding:6px 10px}
  .sec{margin:22px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#9aa0aa}
  ul{margin:0;padding-left:18px}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}
</style></head><body>
<h1>Leyline seed health <span class="badge" style="background:${d.degraded ? '#7f1d1d' : '#14532d'};color:#fff">${d.degraded ? 'DEGRADED' : 'HEALTHY'}</span></h1>
<p class="sub">v${esc(d.version)} · uptime ${uptimeH}h ${uptimeM}m</p>
<div class="grid">
  ${card('Connected peers', d.peers)}
  ${card('Seeds reachable', `${d.connectedSeeds}/${d.totalSeeds}`, d.connectedSeeds > 0 ? '#16a34a' : '#dc2626')}
  ${card('Ledger height', d.ledgerEntries, '#2563eb')}
  ${card('Mirrored topics', d.mirroredTopics)}
  ${card('Buffered messages', d.bufferedMessages)}
  ${card('Known peers', d.knownPeers)}
</div>
<div class="sec">Seed mesh reachability (${seedPct}%)</div>
<div class="bar"><span style="width:${seedPct}%"></span></div>
<div class="sec">Version distribution</div>
<table>${versionRows}</table>
<div class="sec">Recent events</div>
<ul>${events}</ul>
</body></html>`;
}
