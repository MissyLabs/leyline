#!/usr/bin/env npx tsx
/**
 * Test plan verification: Health check endpoint responds on seed nodes.
 *
 * Starts a seed node with a health check port, connects to the live network,
 * and verifies the HTTP endpoint returns valid JSON with expected fields.
 */

import { SeedNode } from '../src/node/seed-node.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const tmpDir = await mkdtemp(join(tmpdir(), 'leyline-verify-health-'));
  const healthPort = 18080 + Math.floor(Math.random() * 1000);

  const node = new SeedNode({
    listenPort: 0,
    listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
    dataDir: join(tmpDir, 'seed'),
    healthCheckPort: healthPort,
  });

  await node.start();
  console.log(`Seed node started, health check on port ${healthPort}`);

  // Wait for peers
  try { await node.waitForPeers(1, 8000); } catch { /* proceed */ }
  await new Promise(r => setTimeout(r, 2000));

  let pass = true;
  const results: string[] = [];

  // Test /health endpoint
  try {
    const res = await fetch(`http://127.0.0.1:${healthPort}/health`);
    const body = await res.json();
    console.log('\nGET /health response:');
    console.log(JSON.stringify(body, null, 2));

    const checks = [
      ['status code 200', res.status === 200],
      ['status field exists', typeof body.status === 'string'],
      ['status is ok or degraded', body.status === 'ok' || body.status === 'degraded'],
      ['version field', typeof body.version === 'string' && body.version.length > 0],
      ['uptime is number >= 0', typeof body.uptime === 'number' && body.uptime >= 0],
      ['peers is number', typeof body.peers === 'number'],
      ['topics is number', typeof body.topics === 'number'],
      ['bufferedMessages is number', typeof body.bufferedMessages === 'number'],
      ['knownPeers is number', typeof body.knownPeers === 'number'],
      ['ledgerEntries is number', typeof body.ledgerEntries === 'number'],
    ] as const;

    for (const [label, ok] of checks) {
      const status = ok ? 'PASS' : 'FAIL';
      results.push(`  ${status}: ${label}`);
      if (!ok) pass = false;
    }
  } catch (err) {
    results.push(`  FAIL: /health request failed: ${err}`);
    pass = false;
  }

  // Test / endpoint (should also work)
  try {
    const res = await fetch(`http://127.0.0.1:${healthPort}/`);
    const body = await res.json();
    results.push(`  ${res.status === 200 ? 'PASS' : 'FAIL'}: GET / returns 200`);
    results.push(`  ${body.status ? 'PASS' : 'FAIL'}: GET / returns health JSON`);
    if (res.status !== 200 || !body.status) pass = false;
  } catch (err) {
    results.push(`  FAIL: / request failed: ${err}`);
    pass = false;
  }

  // Test 404
  try {
    const res = await fetch(`http://127.0.0.1:${healthPort}/nonexistent`);
    results.push(`  ${res.status === 404 ? 'PASS' : 'FAIL'}: GET /nonexistent returns 404 (got ${res.status})`);
    if (res.status !== 404) pass = false;
  } catch (err) {
    results.push(`  FAIL: /nonexistent request failed: ${err}`);
    pass = false;
  }

  console.log('\nResults:');
  for (const r of results) console.log(r);

  console.log(`\n${'='.repeat(50)}`);
  console.log(pass
    ? 'PASS: Health check endpoint works correctly'
    : 'FAIL: Health check endpoint has issues');
  console.log(`${'='.repeat(50)}`);

  await node.stop();
  await rm(tmpDir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
