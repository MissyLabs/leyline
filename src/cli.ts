import { MagicNode } from './node/magic-node.js';
import { SeedNode } from './node/seed-node.js';
import { type MagicConfig, DEFAULT_SEED_NODES } from './config/config.js';
import { publicKeyToHex } from './identity/keypair.js';
import { MessageType } from './messages/message.js';
import { Logger } from './utils/logger.js';
import { promises as fs } from 'node:fs';
import { createConnection } from 'node:net';
import { execSync } from 'node:child_process';

const log = new Logger('CLI');

const args = process.argv.slice(2);
const isSeed = args.includes('--seed');
const noSeeds = args.includes('--no-seeds');
const enableMdns = args.includes('--mdns');
const autoPort = args.includes('--auto-port');
const portFlag = args.indexOf('--port');
let port = portFlag !== -1 ? parseInt(args[portFlag + 1], 10) : 9876;

/**
 * Check if a TCP port is already in use. Returns the PID of the owner if
 * detectable, or true if in use but PID unknown, or false if free.
 */
async function checkPortInUse(p: number): Promise<string | boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port: p, host: '127.0.0.1' });
    sock.once('connect', () => {
      sock.destroy();
      // Try to find owning PID
      try {
        const out = execSync(`ss -tlnp sport = :${p} 2>/dev/null || lsof -ti :${p} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
        const pidMatch = out.match(/pid=(\d+)/);
        resolve(pidMatch ? `PID ${pidMatch[1]}` : (out.trim() || true));
      } catch {
        resolve(true);
      }
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.setTimeout(1000, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Find a free port starting from the given port, incrementing up to 100.
 */
async function findFreePort(startPort: number): Promise<number> {
  for (let p = startPort; p < startPort + 100; p++) {
    const inUse = await checkPortInUse(p);
    if (!inUse) return p;
  }
  throw new Error(`No free port found in range ${startPort}-${startPort + 99}`);
}

// --seeds overrides default seeds; --no-seeds disables bootstrap entirely
const seedNodesFlag = args.indexOf('--seeds');
let seedNodes: string[] | undefined;
if (noSeeds) {
  seedNodes = [];
} else if (seedNodesFlag !== -1) {
  seedNodes = args[seedNodesFlag + 1].split(',');
}
// If neither --seeds nor --no-seeds is given, seedNodes stays undefined
// and mergeConfig will use DEFAULT_SEED_NODES.

const tagsFlag = args.indexOf('--tags');
const tags: string[] = [];
if (tagsFlag !== -1) {
  tags.push(...args[tagsFlag + 1].split(','));
}

// Optional trigger file for send-on-demand from a persistent CLI node.
// JSON format:
// { "tag": "e2e:test", "payload": { ... } }
// If payload is omitted, the whole object is sent as payload.
const sendTriggerFlag = args.indexOf('--send-trigger-file');
const sendTriggerFile = sendTriggerFlag !== -1 ? args[sendTriggerFlag + 1] : undefined;
const sendPollFlag = args.indexOf('--send-poll-ms');
const parsedSendPollMs = sendPollFlag !== -1 ? parseInt(args[sendPollFlag + 1], 10) : 300;
const sendPollMs = Number.isFinite(parsedSendPollMs) && parsedSendPollMs > 0 ? parsedSendPollMs : 300;

const config: Partial<MagicConfig> = {
  listenPort: port,
  listenAddresses: [`/ip4/0.0.0.0/tcp/${port}`],
  ...(seedNodes !== undefined ? { seedNodes } : {}),
  subscribedTags: tags,
  dataDir: `./data/node-${port}`,
  enableMdns,
};

async function main() {
  // --- #1: EADDRINUSE guard ---
  const portOwner = await checkPortInUse(port);
  if (portOwner) {
    const ownerStr = typeof portOwner === 'string' ? ` (owner: ${portOwner})` : '';
    if (autoPort) {
      log.warn(`Port ${port} is already in use${ownerStr} — finding a free port (--auto-port)`);
      port = await findFreePort(port + 1);
      config.listenPort = port;
      config.listenAddresses = [`/ip4/0.0.0.0/tcp/${port}`];
      config.dataDir = `./data/node-${port}`;
      log.info(`Auto-selected port ${port}`);
    } else {
      log.error(`Port ${port} is already in use${ownerStr}`);
      log.error('Remediation: stop the existing node, choose another port with --port <N>, or use --auto-port for automatic fallback');
      process.exit(1);
    }
  }

  const node = isSeed ? new SeedNode(config) : new MagicNode(config);

  const activeTimers: ReturnType<typeof setInterval>[] = [];

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    for (const t of activeTimers) clearInterval(t);
    activeTimers.length = 0;
    await node.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await node.start();

  if (!isSeed) {
    // Open all subscribed tags so messages from anyone can arrive
    for (const tag of tags) {
      await node.allowTagOpen(tag);
    }

    // Register receive handlers for all subscribed tags — log to stdout
    for (const tag of tags) {
      node.onTag(tag, (msg, t) => {
        const sender = publicKeyToHex(msg.senderPubkey).slice(0, 16);
        let payload: string;
        try {
          payload = new TextDecoder().decode(msg.payload);
        } catch {
          payload = `<binary ${msg.payload.length} bytes>`;
        }
        log.info(`[${t}] ${sender}...: ${payload}`);
      });
    }

    // Wait for mesh formation
    const peers = await node.waitForPeers(1, 10_000);

    log.info('Node is ready', { peers, tags, openTags: node.getOpenTags() });

    const health = log.child('health');
    activeTimers.push(setInterval(() => {
      const snap = node.getMetrics().snapshot();
      health.info('Status', {
        peers: node.getPeerCount(),
        openTags: node.getOpenTags(),
        paused: node.isPaused(),
        msgRecv: snap.messagesReceived,
        msgBlocked: snap.messagesBlocked,
        rateLimitHits: snap.rateLimitHits,
        trustDenials: snap.trustDenials,
        sigFails: snap.signatureFailures,
      });
    }, 30_000));

    if (sendTriggerFile) {
      log.info('Send trigger watching', { file: sendTriggerFile, pollMs: sendPollMs });

      activeTimers.push(setInterval(async () => {
        try {
          const raw = await fs.readFile(sendTriggerFile, 'utf8');
          const req = JSON.parse(raw);
          const tag = typeof req?.tag === 'string' ? req.tag : tags[0] ?? 'skill:general';
          const payloadObj = req?.payload ?? req;
          const bytes = new TextEncoder().encode(JSON.stringify(payloadObj));

          await node.broadcast([tag], bytes, MessageType.BROADCAST);
          log.info('Message sent', { tag, payload: payloadObj });

          await fs.unlink(sendTriggerFile).catch(() => {});
        } catch {
          // Ignore missing/invalid trigger file and keep polling.
        }
      }, sendPollMs));
    }
  }
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});
