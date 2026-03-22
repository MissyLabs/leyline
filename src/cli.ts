import { MagicNode } from './node/magic-node.js';
import { SeedNode } from './node/seed-node.js';
import { type MagicConfig, DEFAULT_SEED_NODES } from './config/config.js';

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
    console.log('[Magic] Node is ready. Use as a library or extend with custom handlers.');
  }
}

main().catch((err) => {
  console.error('[Magic] Fatal error:', err);
  process.exit(1);
});
