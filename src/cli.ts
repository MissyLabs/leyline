import { MagicNode } from './node/magic-node.js';
import { SeedNode } from './node/seed-node.js';
import { type MagicConfig, DEFAULT_SEED_NODES } from './config/config.js';
import { publicKeyToHex } from './identity/keypair.js';
import { MessageType } from './messages/message.js';
import { promises as fs } from 'node:fs';

const args = process.argv.slice(2);
const isSeed = args.includes('--seed');
const noSeeds = args.includes('--no-seeds');
const portFlag = args.indexOf('--port');
const port = portFlag !== -1 ? parseInt(args[portFlag + 1], 10) : 9876;

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
};

async function main() {
  const node = isSeed ? new SeedNode(config) : new MagicNode(config);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Magic] Shutting down...');
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
        console.log(`[${t}] ${sender}...: ${payload}`);
      });
    }

    // Wait for mesh formation
    const peers = await node.waitForPeers(1, 10_000);

    console.log(`[Magic] Node is ready — ${peers} peer(s) connected`);
    console.log(`[Magic] Listening for messages on: ${tags.join(', ') || '(no tags)'}`);
    console.log(`[Magic] Open tags: ${node.getOpenTags().join(', ') || '(none)'}`);

    // Health probe every 30 seconds
    setInterval(() => {
      console.log(`[health] peers: ${node.getPeerCount()} | open tags: ${node.getOpenTags().join(', ')} | paused: ${node.isPaused()}`);
    }, 30_000);

    if (sendTriggerFile) {
      console.log(`[Magic] Send trigger watching: ${sendTriggerFile} (poll ${sendPollMs}ms)`);

      setInterval(async () => {
        try {
          const raw = await fs.readFile(sendTriggerFile, 'utf8');
          const req = JSON.parse(raw);
          const tag = typeof req?.tag === 'string' ? req.tag : tags[0] ?? 'skill:general';
          const payloadObj = req?.payload ?? req;
          const bytes = new TextEncoder().encode(JSON.stringify(payloadObj));

          await node.broadcast([tag], bytes, MessageType.BROADCAST);
          console.log(`[Magic][SEND][${tag}] ${JSON.stringify(payloadObj)}`);

          await fs.unlink(sendTriggerFile).catch(() => {});
        } catch {
          // Ignore missing/invalid trigger file and keep polling.
        }
      }, sendPollMs);
    }
  }
}

main().catch((err) => {
  console.error('[Magic] Fatal error:', err);
  process.exit(1);
});
