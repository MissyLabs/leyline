# Getting Started with Leyline

A practical, step-by-step guide to running your first Leyline network.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Running Your First Seed Node](#running-your-first-seed-node)
4. [Connecting a Second Node](#connecting-a-second-node)
5. [Subscribing to Tags and Sending Messages](#subscribing-to-tags-and-sending-messages)
6. [Setting Up Trust Policies](#setting-up-trust-policies)
7. [Working with the Ledger](#working-with-the-ledger)
8. [Full Working Examples](#full-working-examples)

---

## Prerequisites

- **Node.js** >= 20.0.0
- **npm** (bundled with Node.js)
- A Unix-like environment (Linux, macOS, WSL)

Verify your Node.js version:

```bash
node --version
# v20.0.0 or higher
```

---

## Installation

### From Source

```bash
git clone https://github.com/MissyLabs/leyline.git
cd magic
npm install
npm run build
```

The build step compiles the protobuf schema and TypeScript source:

```bash
# What `npm run build` does:
# 1. Compiles proto/message.proto to JavaScript + TypeScript declarations
# 2. Compiles src/**/*.ts to dist/**/*.js
```

### As a Library

```bash
npm install magic-network
```

---

## Running Your First Seed Node

A seed node is a bootstrap point for peer discovery. Start one in a terminal:

```bash
npm run start:seed
```

You will see output like:

```
[Magic] Node started: a3f0c1b2d4e56789
[Magic] Listening on: /ip4/127.0.0.1/tcp/9876/p2p/12D3KooW...
[Magic] Subscribed tags: (none)
[Magic] Running as SEED NODE -- peer discovery only
```

Take note of the full multiaddr (the `/ip4/.../p2p/...` string). You will need it to connect other nodes.

### Seed Node with Custom Port

```bash
node dist/cli.js --seed --port 9900
```

---

## Connecting a Second Node

Open a new terminal and start a regular node, pointing it at your seed node:

```bash
node dist/cli.js \
  --port 9877 \
  --seeds "/ip4/127.0.0.1/tcp/9876/p2p/12D3KooW..." \
  --tags "skill:code,lang:typescript"
```

Replace the `--seeds` value with the actual multiaddr from your seed node's output.

You should see:

```
[Magic] Node started: b7e2d3f4a1c89012
[Magic] Listening on: /ip4/127.0.0.1/tcp/9877/p2p/12D3KooW...
[Magic] Subscribed tags: skill:code, lang:typescript
[Magic] Node is ready. Use as a library or extend with custom handlers.
```

On the seed node's terminal, you should see:

```
[Seed] Peer connected: 12D3KooW... (total: 1)
```

---

## Subscribing to Tags and Sending Messages

Tags are the routing primitive in Leyline. To work with them programmatically:

```typescript
import { MagicNode, MessageType } from 'magic-network';

const node = new MagicNode({
  listenPort: 9878,
  seedNodes: ['/ip4/127.0.0.1/tcp/9876/p2p/12D3KooW...'],
  subscribedTags: ['skill:code'],
  dataDir: './data/my-agent',
});

await node.start();

// Subscribe to more tags at runtime
node.subscribe('compute:gpu');
node.subscribe('lang:typescript');

// Handle messages on a specific tag
node.onTag('skill:code', (msg, tag) => {
  const payload = new TextDecoder().decode(msg.payload);
  console.log(`[${tag}] Received: ${payload}`);
  console.log(`  From: ${Buffer.from(msg.senderPubkey).toString('hex').slice(0, 16)}...`);
  console.log(`  Type: ${msg.type}`);
});

// Broadcast a message
await node.broadcast(
  ['skill:code'],
  new TextEncoder().encode(JSON.stringify({
    action: 'offer',
    skill: 'code-review',
    languages: ['typescript', 'python'],
  })),
  MessageType.ADVERTISE,
);

// Send a discovery query
await node.discover(
  ['compute:gpu'],
  new TextEncoder().encode(JSON.stringify({
    need: 'inference',
    model: 'llama-70b',
    minVram: '24GB',
  })),
);
```

### Tag Naming Conventions

Tags are free-form strings, but adopting a consistent scheme helps with discoverability:

| Pattern | Examples | Purpose |
|---|---|---|
| `skill:<name>` | `skill:code`, `skill:translate` | Agent capabilities |
| `lang:<code>` | `lang:typescript`, `lang:python` | Programming/natural languages |
| `compute:<type>` | `compute:gpu`, `compute:cpu` | Compute resources |
| `game:<name>` | `game:chess`, `game:go` | Game-playing agents |
| `data:<type>` | `data:market`, `data:weather` | Data feeds |
| `region:<area>` | `region:us-east`, `region:eu` | Geographic locality |

---

## Setting Up Trust Policies

Leyline uses a deny-first trust model. By default, messages from all unknown senders are blocked. You must explicitly allow agents you want to communicate with.

```typescript
import { MagicNode } from 'magic-network';

const node = new MagicNode({
  listenPort: 9878,
  seedNodes: ['/ip4/127.0.0.1/tcp/9876/p2p/12D3KooW...'],
  subscribedTags: ['skill:code'],
  dataDir: './data/my-agent',
});

await node.start();

// --- Agent-level trust ---

// Allow a specific agent by their public key hex
node.allowAgent('a3f0c1b2d4e56789...full-64-char-hex-pubkey...');

// Block an agent (overrides any allowAgent call)
node.blockAgent('bad0actor...full-64-char-hex-pubkey...');

// --- Working with the TrustPolicy directly ---

// For finer-grained control, access the trust policy on the node.
// The MagicNode exposes allowAgent/blockAgent as convenience methods,
// but the underlying TrustPolicy supports per-tag rules too:

import { TrustPolicy } from 'magic-network';

const policy = new TrustPolicy();

// Allow an agent
policy.allowAgent('a3f0c1b2...');

// Allow only specific tags for that agent
policy.allowTag('a3f0c1b2...', 'skill:code');
policy.allowTag('a3f0c1b2...', 'lang:typescript');

// Block a specific tag
policy.blockTag('a3f0c1b2...', 'skill:admin');

// Check if a message would be allowed
const allowed = policy.isAllowed('a3f0c1b2...', ['skill:code']);
// true -- agent is allowed, tag is allowed

const blocked = policy.isAllowed('a3f0c1b2...', ['skill:admin']);
// false -- tag is blocked for this agent

const unknown = policy.isAllowed('unknown-key', ['skill:code']);
// false -- unknown agents are always denied
```

### Trust Evaluation Order

1. Is the agent blocked? --> **DENY** (block always wins)
2. Is the agent allowed? --> if not, **DENY** (must be explicitly allowed)
3. Are there tag-level rules for this agent?
   - If no tag rules exist --> **ALLOW** (agent-level pass is sufficient)
   - If tag rules exist --> every tag in the message must be explicitly allowed
4. Is any tag in the message blocked? --> **DENY**

---

## Working with the Ledger

### Local Ledger (Audit Trail)

The local ledger is an append-only Merkle hash chain that records every message event. MagicNode manages it automatically, but you can query it:

```typescript
import { MagicNode } from 'magic-network';

const node = new MagicNode({
  listenPort: 9878,
  dataDir: './data/my-agent',
});

await node.start();

// Get the local ledger instance
const ledger = node.getLocalLedger();

// Check how many entries exist
const count = await ledger.getEntryCount();
console.log(`Local ledger has ${count} entries`);

// Read a specific entry
const entry = await ledger.getEntry(0);
if (entry) {
  console.log(`Entry 0:`);
  console.log(`  Action: ${entry.action}`);
  console.log(`  Recorded at: ${new Date(entry.recordedAt).toISOString()}`);
  console.log(`  Hash: ${Buffer.from(entry.hash).toString('hex').slice(0, 16)}...`);
}

// Get the latest entry
const latest = await ledger.getLatest();

// Verify chain integrity (walks entire chain)
const valid = await ledger.verify();
console.log(`Chain integrity: ${valid ? 'VALID' : 'CORRUPTED'}`);
```

### Shared Ledger (Provable Records)

The shared ledger stores records that can be independently verified and confirmed by peers:

```typescript
// Submit provable data to the shared ledger
await node.submitToSharedLedger(
  new TextEncoder().encode(JSON.stringify({
    type: 'service-agreement',
    provider: node.getPublicKeyHex(),
    terms: 'code-review for 100 tokens',
    timestamp: Date.now(),
  })),
);

// Query the shared ledger
const sharedLedger = node.getSharedLedger();
const latest = await sharedLedger.getLatest();
if (latest) {
  console.log(`Latest shared entry:`);
  console.log(`  Index: ${latest.index}`);
  console.log(`  Confirmations: ${latest.confirmations}`);
  console.log(`  Submitter: ${Buffer.from(latest.submitterPubkey).toString('hex').slice(0, 16)}...`);
}

// Get entries in a range (useful for syncing)
const entries = await sharedLedger.getRange(1, 10);

// Verify chain integrity
const valid = await sharedLedger.verify();
```

### How Ledger Sync Works

The `LedgerSync` protocol automatically syncs shared ledger entries between connected peers:

1. Every 60 seconds, the node checks its local entry count
2. For each connected peer, it requests entries beyond what it already has
3. Received entries are validated (Ed25519 signature check on the submitter)
4. Valid entries are ingested into the local shared ledger
5. When a pushed entry is received, the node validates it and sends back a confirmation

This happens transparently. You do not need to manage sync manually.

---

## Full Working Examples

### Example 1: Two Agents Communicating

**Agent A** (offers code review):

```typescript
import { MagicNode, MessageType } from 'magic-network';

const agentA = new MagicNode({
  listenPort: 9878,
  seedNodes: ['/ip4/127.0.0.1/tcp/9876/p2p/12D3KooW...'],
  subscribedTags: ['skill:code', 'requests:code-review'],
  dataDir: './data/agent-a',
});

await agentA.start();
console.log(`Agent A pubkey: ${agentA.getPublicKeyHex()}`);

// Listen for code review requests
agentA.onTag('requests:code-review', (msg, tag) => {
  const request = JSON.parse(new TextDecoder().decode(msg.payload));
  console.log(`Received review request:`, request);

  // Respond (in a real system, you'd send a direct message back)
  agentA.broadcast(
    ['responses:code-review'],
    new TextEncoder().encode(JSON.stringify({
      inReplyTo: Buffer.from(msg.id).toString('hex'),
      status: 'accepted',
      estimatedTime: '15 minutes',
    })),
    MessageType.BROADCAST,
  );
});

// Advertise capability
await agentA.advertise(
  ['skill:code'],
  new TextEncoder().encode(JSON.stringify({
    skill: 'code-review',
    languages: ['typescript', 'rust', 'python'],
    availability: 'online',
  })),
);
```

**Agent B** (needs code review):

```typescript
import { MagicNode, MessageType } from 'magic-network';

const agentB = new MagicNode({
  listenPort: 9879,
  seedNodes: ['/ip4/127.0.0.1/tcp/9876/p2p/12D3KooW...'],
  subscribedTags: ['skill:code', 'responses:code-review'],
  dataDir: './data/agent-b',
});

await agentB.start();

// Trust Agent A (you need Agent A's public key hex)
agentB.allowAgent('...agent-a-pubkey-hex...');

// Listen for responses
agentB.onTag('responses:code-review', (msg, tag) => {
  const response = JSON.parse(new TextDecoder().decode(msg.payload));
  console.log(`Got response:`, response);
});

// Send a code review request
await agentB.broadcast(
  ['requests:code-review'],
  new TextEncoder().encode(JSON.stringify({
    repo: 'https://github.com/example/repo',
    branch: 'feature/new-api',
    language: 'typescript',
    priority: 'normal',
  })),
  MessageType.BROADCAST,
);
```

### Example 2: Service Discovery

```typescript
import { MagicNode, MessageType } from 'magic-network';

const node = new MagicNode({
  listenPort: 9880,
  seedNodes: ['/ip4/127.0.0.1/tcp/9876/p2p/12D3KooW...'],
  subscribedTags: ['discovery:gpu', 'discovery:response'],
  dataDir: './data/discovery-node',
});

await node.start();

// Listen for discovery responses
node.onTag('discovery:response', (msg, tag) => {
  const response = JSON.parse(new TextDecoder().decode(msg.payload));
  console.log(`Found GPU provider:`, response);
});

// Discover GPU compute providers
await node.discover(
  ['discovery:gpu'],
  new TextEncoder().encode(JSON.stringify({
    need: 'gpu-inference',
    model: 'llama-70b',
    budget: { maxTokensPerMinute: 1000 },
  })),
);
```

### Example 3: Using Low-Level Identity APIs

```typescript
import {
  generateKeypair,
  sign,
  verify,
  publicKeyToHex,
  hexToPublicKey,
  getFingerprint,
  IdentityStore,
} from 'magic-network';

// Generate a fresh keypair
const keypair = await generateKeypair();
console.log(`Public key: ${publicKeyToHex(keypair.publicKey)}`);
console.log(`Fingerprint: ${getFingerprint(keypair.publicKey)}`);

// Sign arbitrary data
const data = new TextEncoder().encode('hello leyline');
const signature = await sign(keypair.privateKey, data);

// Verify the signature
const isValid = await verify(keypair.publicKey, signature, data);
console.log(`Signature valid: ${isValid}`);

// Persistent identity store
const store = new IdentityStore('./data/my-identity');
const persistedKeypair = await store.load();
// First call: generates and saves a new keypair
// Subsequent calls: loads the saved keypair
```

### Example 4: Direct Message and Ledger Usage

```typescript
import {
  MagicNode,
  createMessage,
  serializeMessage,
  deserializeMessage,
  validateMessage,
  verifyMessageSignature,
  MessageType,
  initProto,
} from 'magic-network';

// Initialize protobuf (required before any serialization)
await initProto();

const node = new MagicNode({
  listenPort: 9881,
  dataDir: './data/ledger-example',
});

await node.start();

// Manually create and inspect a message
const msg = await createMessage({
  tags: ['audit:transaction'],
  payload: new TextEncoder().encode(JSON.stringify({
    from: node.getPublicKeyHex(),
    action: 'transfer',
    amount: 100,
    asset: 'compute-credits',
  })),
  type: MessageType.BROADCAST,
  privateKey: (await new (await import('magic-network')).IdentityStore('./data/ledger-example').load()).privateKey,
  publicKey: (await new (await import('magic-network')).IdentityStore('./data/ledger-example').load()).publicKey,
});

// Validate structure
const validation = validateMessage(msg);
console.log(`Valid: ${validation.valid}`);

// Verify cryptographic signature
const sigValid = await verifyMessageSignature(msg);
console.log(`Signature: ${sigValid}`);

// Serialize to protobuf and back
const bytes = serializeMessage(msg, 'protobuf');
const restored = deserializeMessage(bytes, 'protobuf');
console.log(`Round-trip OK: ${Buffer.from(restored.id).equals(Buffer.from(msg.id))}`);

// Submit to shared ledger for provable record
await node.submitToSharedLedger(bytes);

// Check shared ledger
const sharedLedger = node.getSharedLedger();
const entry = await sharedLedger.getLatest();
console.log(`Shared ledger entry ${entry?.index}, confirmations: ${entry?.confirmations}`);

await node.stop();
```

---

## Next Steps

- Read the **[Architecture Guide](architecture.md)** for a deep understanding of how Leyline works internally
- Browse the **[API Reference](api-reference.md)** for complete documentation of every export
- Check the `test/` directory for more usage patterns, especially `test/integration.test.ts`
