import { describe, it, expect, afterEach } from 'vitest';
import { HealthCheckServer } from '../src/node/health-check.js';

// SEC-4: metrics endpoints must be authable and bindable to loopback.
describe('HealthCheckServer — auth & bind (SEC-4)', () => {
  let server: HealthCheckServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  const deps = {
    libp2p: { getPeers: () => [] } as any,
    getTopicCount: () => 0,
    getBufferedMessageCount: () => 0,
    getKnownPeerCount: () => 0,
    getLedgerEntryCount: async () => 0,
    getMetrics: () => ({ 'messages.received': 5 }),
    getPrometheusMetrics: () => 'leyline_messages_received 5\n',
  };

  const port = 18000 + Math.floor(Math.random() * 1000);

  it('rejects /metrics without the bearer token and allows /health', async () => {
    server = new HealthCheckServer(port, deps, { bind: '127.0.0.1', authToken: 'secret-token' });
    await server.start();

    const noAuth = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(noAuth.status).toBe(401);

    const badAuth = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { Authorization: 'Bearer wrong' } });
    expect(badAuth.status).toBe(401);

    const good = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { Authorization: 'Bearer secret-token' } });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ 'messages.received': 5 });

    // /health stays open.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  });

  it('protects /metrics/prometheus with the same token', async () => {
    server = new HealthCheckServer(port + 1, deps, { authToken: 'tok' });
    await server.start();
    const noAuth = await fetch(`http://127.0.0.1:${port + 1}/metrics/prometheus`);
    expect(noAuth.status).toBe(401);
    const good = await fetch(`http://127.0.0.1:${port + 1}/metrics/prometheus`, { headers: { Authorization: 'Bearer tok' } });
    expect(good.status).toBe(200);
  });

  it('serves metrics openly when no token is configured (back-compat)', async () => {
    server = new HealthCheckServer(port + 2, deps, { bind: '127.0.0.1' });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${port + 2}/metrics`);
    expect(res.status).toBe(200);
  });

  // FEAT-3: authenticated server-rendered dashboard.
  it('renders an authenticated /dashboard with health data', async () => {
    const dashDeps = {
      ...deps,
      getDashboard: async () => ({
        version: '0.3.0', uptimeSeconds: 3661, peers: 4, connectedSeeds: 3, totalSeeds: 4,
        degraded: false, mirroredTopics: 12, bufferedMessages: 30, knownPeers: 100,
        ledgerEntries: 42, versionDistribution: { '0.3.0': 3, '0.2.0': 1 },
        recentEvents: ['2026-07-10T00:00:00Z — recovered: seed connectivity restored'],
      }),
    };
    server = new HealthCheckServer(port + 3, dashDeps, { authToken: 'tok' });
    await server.start();

    const noAuth = await fetch(`http://127.0.0.1:${port + 3}/dashboard`);
    expect(noAuth.status).toBe(401);

    const good = await fetch(`http://127.0.0.1:${port + 3}/dashboard`, { headers: { Authorization: 'Bearer tok' } });
    expect(good.status).toBe(200);
    expect(good.headers.get('content-type')).toContain('text/html');
    const html = await good.text();
    expect(html).toContain('Leyline seed health');
    expect(html).toContain('3/4');       // seeds reachable
    expect(html).toContain('42');        // ledger height
    expect(html).toContain('0.3.0');     // version distribution
  });
});
