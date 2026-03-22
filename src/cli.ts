import { MagicNode } from './node/magic-node.js';
import { SeedNode } from './node/seed-node.js';
import { type MagicConfig } from './config/config.js';

const args = process.argv.slice(2);
const isSeed = args.includes('--seed');
const portFlag = args.indexOf('--port');
const port = portFlag !== -1 ? parseInt(args[portFlag + 1], 10) : 9876;

const seedNodesFlag = args.indexOf('--seeds');
const seedNodes: string[] = [];
if (seedNodesFlag !== -1) {
  // Comma-separated multiaddrs
  seedNodes.push(...args[seedNodesFlag + 1].split(','));
}

const tagsFlag = args.indexOf('--tags');
const tags: string[] = [];
if (tagsFlag !== -1) {
  tags.push(...args[tagsFlag + 1].split(','));
}

const config: Partial<MagicConfig> = {
  listenPort: port,
  listenAddresses: [`/ip4/0.0.0.0/tcp/${port}`],
  seedNodes,
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
    console.log('[Magic] Node is ready. Use as a library or extend with custom handlers.');
  }
}

main().catch((err) => {
  console.error('[Magic] Fatal error:', err);
  process.exit(1);
});
