import { describe, it, expect, afterEach } from 'vitest';
import { HealthCheckServer, type HealthCheckDeps } from '../src/index.js';

function makeDeps(overrides: Partial<HealthCheckDeps> = {}): HealthCheckDeps {
  return {
    libp2p: {
      getPeers: () => [],
    } as unknown as HealthCheckDeps['libp2p'],
    getTopicCount: () => 5,
    getBufferedMessageCount: () => 42,
    getKnownPeerCount: () => 10,
    getLedgerEntryCount: async () => 100,
    ...overrides,
  };
}

describe('HealthCheckServer', () => {
  let server: HealthCheckServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('responds with health status on /health', async () => {
    const port = 19100 + Math.floor(Math.random() * 900);
    server = new HealthCheckServer(port, makeDeps());
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('degraded'); // no peers
    expect(body.version).toBeDefined();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.topics).toBe(5);
    expect(body.bufferedMessages).toBe(42);
    expect(body.knownPeers).toBe(10);
    expect(body.ledgerEntries).toBe(100);
  });

  it('reports ok status when peers are connected', async () => {
    const port = 19100 + Math.floor(Math.random() * 900);
    const deps = makeDeps({
      libp2p: {
        getPeers: () => ['peer1', 'peer2'] as unknown[],
      } as unknown as HealthCheckDeps['libp2p'],
    });
    server = new HealthCheckServer(port, deps);
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.peers).toBe(2);
  });

  it('returns 404 for unknown paths', async () => {
    const port = 19100 + Math.floor(Math.random() * 900);
    server = new HealthCheckServer(port, makeDeps());
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('responds on root path', async () => {
    const port = 19100 + Math.floor(Math.random() * 900);
    server = new HealthCheckServer(port, makeDeps());
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBeDefined();
  });

  it('does not start when port is 0', async () => {
    server = new HealthCheckServer(0, makeDeps());
    await server.start(); // should be a no-op
    // no HTTP server should be listening
    await expect(fetch('http://127.0.0.1:0/health')).rejects.toThrow();
  });

  it('handles ledger error gracefully', async () => {
    const port = 19100 + Math.floor(Math.random() * 900);
    const deps = makeDeps({
      getLedgerEntryCount: async () => { throw new Error('db closed'); },
    });
    server = new HealthCheckServer(port, deps);
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ledgerEntries).toBe(0);
  });
});
