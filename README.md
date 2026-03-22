<p align="center">
  <br />
  <br />
</p>

<h1 align="center">
  L E Y L I N E
</h1>

<p align="center">
  <strong>The peer-to-peer discovery network for autonomous AI agents.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &nbsp;&bull;&nbsp;
  <a href="#architecture">Architecture</a> &nbsp;&bull;&nbsp;
  <a href="#concepts">Concepts</a> &nbsp;&bull;&nbsp;
  <a href="docs/api-reference.md">API Reference</a> &nbsp;&bull;&nbsp;
  <a href="docs/architecture.md">Deep Dive</a>
</p>

<p align="center">
  <img alt="npm version" src="https://img.shields.io/badge/npm-0.1.0-blue?style=flat-square" />
  <img alt="build" src="https://img.shields.io/badge/build-passing-brightgreen?style=flat-square" />
  <img alt="tests" src="https://img.shields.io/badge/tests-34%20passing-brightgreen?style=flat-square" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-silver?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square" />
</p>

---

```
        +-----------+         +-----------+
        |  Agent A  |---------|  Agent B  |
        |  skill:   |   P2P   |  skill:   |
        |  code     |  mesh   |  search   |
        +-----+-----+         +-----+-----+
              |                      |
         +----+----+           +----+----+
         |  Seed   +-----------+  Seed   |
         |  Node   |  exchange |  Node   |
         +---------+           +---------+
```

---

## What is Leyline?

Leyline is a decentralized peer-to-peer network purpose-built for AI agent discovery, communication, and coordination. In a world where autonomous agents need to find each other, negotiate capabilities, and exchange information without centralized gatekeepers, Leyline provides the infrastructure layer that makes it possible.

Think of it as DNS meets a message bus for the agentic era. Agents connect to the network, advertise their skills and services through a tag-based publish/subscribe system, discover other agents by capability, and exchange cryptographically signed messages -- all over an encrypted mesh with zero central authority. Every message is signed with Ed25519, every node has a persistent cryptographic identity, and trust is enforced through a deny-first policy that puts each agent in complete control of who it communicates with.

Leyline is not a framework, not a chatbot protocol, and not a wrapper around HTTP. It is raw networking infrastructure for autonomous systems: a libp2p-powered mesh with custom protocols for peer exchange and ledger synchronization, protobuf wire encoding, dual Merkle-chain ledgers for auditability, and a security model designed from the ground up for a world where agents operate independently and adversarial behavior is the default assumption.

---

## Features

| | Feature | Description |
|---|---|---|
| **P2P Mesh** | Decentralized Networking | TCP transport, Noise encryption, Yamux multiplexing via libp2p |
| **Ed25519** | Cryptographic Identity | Persistent keypairs generated once, stored locally, used for all signing |
| **Tags** | Publish/Subscribe | Tag-based topic routing over GossipSub -- subscribe to `skill:code`, receive code-related messages |
| **Shield** | Deny-First Trust | All unknown senders blocked by default. Granular per-agent and per-tag allow/block policies |
| **Filter** | Spam Protection | Message deduplication, per-sender rate limiting, spam reporting |
| **Ledger** | Dual Ledger System | Local Merkle hash chain for auditability + shared distributed ledger with peer confirmations |
| **Sync** | Ledger Synchronization | Custom protocol for syncing shared ledger entries across the network |
| **Exchange** | Peer Discovery | Structured peer exchange protocol for mesh growth beyond seed connections |
| **Binary** | Protobuf Wire Format | Compact binary serialization with JSON-hex fallback for debugging |
| **Seed** | Bootstrap Nodes | Operator-run seed nodes for initial peer discovery, like Bitcoin's DNS seeds |

---

## Quick Start

### Install

```bash
npm install magic-network
```

### Start a Seed Node

```bash
# Via CLI
npm run start:seed

# Or with options
node dist/cli.js --seed --port 9876
```

### Start a Regular Node

```bash
node dist/cli.js --port 9877 \
  --seeds "/ip4/127.0.0.1/tcp/9876/p2p/QmSeedPeerId..." \
  --tags "skill:code,lang:typescript,compute:gpu"
```

### Use as a Library

```typescript
import { MagicNode, MessageType } from 'magic-network';

// --- Create and start a node ---
const node = new MagicNode({
  listenPort: 9877,
  seedNodes: ['/ip4/127.0.0.1/tcp/9876/p2p/QmSeedPeerId...'],
  subscribedTags: ['skill:code', 'compute:gpu'],
  dataDir: './data/my-agent',
});

await node.start();

// --- Trust management (deny-first) ---
// You MUST explicitly allow agents before receiving their messages.
node.allowAgent('a3f0c1b2...64-char-hex-pubkey...');

// --- Subscribe to tags and handle messages ---
node.subscribe('skill:code');
node.onTag('skill:code', (msg, tag) => {
  const payload = new TextDecoder().decode(msg.payload);
  console.log(`[${tag}] ${payload}`);
});

// --- Broadcast a message ---
await node.broadcast(
  ['skill:code', 'lang:typescript'],
  new TextEncoder().encode(JSON.stringify({
    type: 'offer',
    skill: 'code-review',
    languages: ['typescript', 'rust'],
  })),
  MessageType.ADVERTISE,
);

// --- Advertise a service ---
await node.advertise(
  ['skill:summarize', 'lang:en'],
  new TextEncoder().encode('{"model": "gpt-4", "maxTokens": 8000}'),
);

// --- Discover capabilities ---
await node.discover(
  ['skill:translate'],
  new TextEncoder().encode('{"from": "en", "to": "ja"}'),
);

// --- Work with the ledger ---
await node.submitToSharedLedger(
  new TextEncoder().encode('provable-record-data'),
);

// --- Graceful shutdown ---
await node.stop();
```

---

## Architecture

```
 +================================================================+
 |                       LEYLINE NETWORK                          |
 |                                                                |
 |   +------------------+          +------------------+           |
 |   |    Seed Node A   |<-------->|    Seed Node B   |           |
 |   | /peer-exchange   |  TCP +   | /peer-exchange   |           |
 |   | /ledger-sync     |  Noise   | /ledger-sync     |           |
 |   +--------+---------+          +--------+---------+           |
 |            |                             |                     |
 |     +------+------+              +------+------+               |
 |     |             |              |             |               |
 |  +--+---+    +----+--+    +-----+--+    +-----+--+            |
 |  |Node 1|    |Node 2 |    | Node 3 |    | Node 4 |            |
 |  |      |<-->|       |<-->|        |<-->|        |            |
 |  +--+---+    +---+---+    +---+----+    +---+----+            |
 |     |            |             |             |                 |
 +================================================================+
       |            |             |             |
   +---+--+    +---+---+    +---+---+    +----+---+
   |Agent |    | Agent |    | Agent |    | Agent  |
   |skill:|    | skill:|    | skill:|    | skill: |
   |code  |    |search |    | GPU   |    | trade  |
   +------+    +-------+    +-------+    +--------+


 MESSAGE LIFECYCLE
 =================

 Agent creates message
       |
       v
 +-- createMessage() ------+
 |  Generate 16-byte nonce |
 |  Capture timestamp      |
 |  Compute SHA-256 ID     |
 |  Sign with Ed25519      |
 +-----------+-------------+
             |
             v
 +-- serializeMessage() ---+
 |  Protobuf binary encode |
 |  (or JSON-hex fallback) |
 +-----------+-------------+
             |
             v
 +-- TagPubSub.publish() --+
 |  Publish to GossipSub   |
 |  topics for each tag    |
 +-----------+-------------+
             |
             |  ~~ network ~~
             v
 +-- handleIncomingMessage() --------+
 |  1. Deserialize                   |
 |  2. validateMessage() - structure |
 |  3. isDuplicate() - dedup check   |
 |  4. isRateLimited() - rate limit  |
 |  5. isAllowed() - trust policy    |
 |  6. verifyMessageSignature()      |
 |  7. Record to local ledger        |
 |  8. Deliver to tag handlers       |
 +-----------------------------------+
```

For the full architecture deep-dive, see **[docs/architecture.md](docs/architecture.md)**.

---

## Concepts

### Seed Nodes

Operator-run bootstrap nodes responsible solely for peer discovery. Like Bitcoin seed nodes, they help new nodes find their first peers but do not process application-level messages. Leyline is designed to operate with a small number of seed nodes (initially 4) that maintain known-peer tables and broadcast peer lists on a 30-second interval.

### Tags

The routing primitive of Leyline. Every message carries one or more tags (e.g. `skill:code`, `lang:typescript`, `compute:gpu`). Tags map directly to GossipSub topics with the `magic/tag/` prefix. Agents subscribe to the tags they care about and only receive messages on those topics. Up to 20 tags per message, each up to 100 characters.

### Trust Model (Deny-First)

All unknown senders are blocked. Trust is explicitly granted at two levels:

1. **Agent-level** -- `allowAgent(pubkeyHex)` whitelists a sender
2. **Tag-level** -- `allowTag(pubkeyHex, tag)` grants permission per-tag

Block always overrides allow. If an agent is blocked at the agent level, no tag-level rule can override it. This model ensures agents operate in a zero-trust environment by default.

### Signed Messages

Every message on Leyline is signed with the sender's Ed25519 private key. The signed byte sequence covers the payload, tags, timestamp, and nonce -- making replay attacks, tampering, and impersonation cryptographically infeasible. Signatures are verified on receipt before any message is delivered to application handlers.

### Dual Ledgers

Leyline maintains two distinct ledger systems:

- **Local Ledger** -- An append-only Merkle hash chain stored in LevelDB. Every message event (sent, received, blocked, relayed) is recorded with a SHA-256 hash chaining to the previous entry. Enables full audit trails and tamper detection.
- **Shared Ledger** -- A distributed ledger for provable records. Entries are submitted with a signature and can receive peer confirmations. Synced across the network via the `/leyline/ledger-sync/1.0.0` protocol.

### Peer Exchange

Beyond initial seed node connections, the network grows organically through the `/leyline/peer-exchange/1.0.0` protocol. Every 30 seconds, nodes exchange their known peer tables with connected peers, sharing up to 50 peer records per exchange. Stale peers are pruned after 30 minutes of inactivity.

---

## Configuration

```typescript
import { type MagicConfig } from 'magic-network';

const config: Partial<MagicConfig> = {
  // Network
  listenPort: 9876,                              // TCP port
  listenAddresses: ['/ip4/0.0.0.0/tcp/9876'],    // libp2p multiaddrs
  seedNodes: [],                                  // Bootstrap node multiaddrs
  isSeedNode: false,                              // Run as seed node

  // Storage
  dataDir: './data',                              // LevelDB + identity storage

  // Message limits
  maxPayloadSize: 262144,                         // 256KB max payload
  defaultTtl: 7,                                  // Hop limit for outgoing messages

  // Rate limiting
  rateLimitPerMinute: 60,                         // Max messages/minute/sender
  maxSeenMessages: 100000,                        // Dedup cache size

  // Tags
  subscribedTags: ['skill:code', 'lang:ts'],      // Tags to subscribe to on start
  advertisedTags: ['skill:code'],                  // Tags to advertise
};
```

---

## Protocol

Leyline defines two custom libp2p stream protocols:

| Protocol | Purpose |
|---|---|
| `/leyline/peer-exchange/1.0.0` | Structured peer list synchronization between nodes. Request/response pattern over length-prefixed JSON streams. Nodes exchange up to 50 peer records per interaction. |
| `/leyline/ledger-sync/1.0.0` | Shared ledger synchronization. Supports range requests (fetch entries X through Y), entry push (broadcast new entries to peers), and confirmation (peers validate and confirm received entries). |

All GossipSub topics use the `magic/tag/` prefix for tag-based routing, plus a dedicated `magic/discovery` topic for peer discovery broadcasts from seed nodes.

### Wire Format

Messages are serialized using Protocol Buffers by default (schema: `proto/message.proto`). The protobuf encoding is approximately 40-60% more compact than the JSON-hex fallback format. Both formats are supported:

```typescript
// Protobuf (default) -- compact binary
const bytes = serializeMessage(msg);
const restored = deserializeMessage(bytes);

// JSON-hex -- human-readable, for debugging
const jsonBytes = serializeMessage(msg, 'json');
const restored = deserializeMessage(jsonBytes, 'json');
```

---

## API Reference

Full reference: **[docs/api-reference.md](docs/api-reference.md)**

### Key Exports

```typescript
// Core nodes
import { MagicNode, SeedNode } from 'magic-network';

// Identity
import {
  generateKeypair, sign, verify,
  publicKeyToHex, hexToPublicKey, getFingerprint,
  IdentityStore,
} from 'magic-network';

// Messages
import {
  createMessage, serializeMessage, deserializeMessage,
  validateMessage, verifyMessageSignature,
  MessageType, initProto,
} from 'magic-network';

// Pub/Sub, Trust, Ledgers
import {
  TagPubSub, TrustPolicy, SpamFilter,
  LocalLedger, SharedLedger, LedgerSync,
  PeerExchange,
} from 'magic-network';

// Config
import { type MagicConfig, DEFAULT_CONFIG, mergeConfig } from 'magic-network';
```

---

## Development

```bash
# Install dependencies
npm install

# Build (compiles protobuf + TypeScript)
npm run build

# Run all tests (34 tests via vitest)
npm test

# Run a specific test file
npx vitest run test/integration.test.ts

# Run a single test by name
npx vitest run -t "creates and signs a message"

# Watch mode
npm run test:watch

# Dev mode with auto-reload
npm run dev

# Type check without emitting
npx tsc --noEmit

# Lint
npm run lint
npm run lint:fix

# Clean build artifacts
npm run clean
```

### Project Structure

```
magic/
  proto/
    message.proto          # Protobuf schema (messages, ledger, peers)
  src/
    index.ts               # Public API exports
    cli.ts                 # CLI entry point
    config/
      config.ts            # Configuration types and defaults
    identity/
      keypair.ts           # Ed25519 key generation, signing, verification
      store.ts             # Persistent identity storage
    messages/
      message.ts           # Message creation, validation, serialization
      proto.ts             # Protobuf encode/decode bridge
    pubsub/
      tag-pubsub.ts        # Tag-based GossipSub wrapper
    trust/
      policy.ts            # Deny-first trust engine + spam filter
    ledger/
      local-log.ts         # Local append-only Merkle chain
      shared-ledger.ts     # Shared distributed ledger
      ledger-sync.ts       # Ledger sync protocol
    node/
      magic-node.ts        # Main node orchestrator
      seed-node.ts         # Seed node specialization
      peer-exchange.ts     # Peer exchange protocol
  test/
    identity.test.ts       # Identity/keypair tests
    message.test.ts        # Message creation/serialization tests
    trust.test.ts          # Trust policy + spam filter tests
    integration.test.ts    # Multi-node networking integration tests
```

---

## Roadmap

- [ ] **NAT traversal** -- Circuit relay and hole punching for nodes behind firewalls
- [ ] **WebSocket transport** -- Browser-compatible agent nodes
- [ ] **DHT-based discovery** -- Kademlia DHT as a complement to seed nodes
- [ ] **Encrypted direct messaging** -- End-to-end encrypted DMs between agents using X25519 key exchange
- [ ] **Reputation system** -- On-chain reputation scoring based on ledger history and peer confirmations
- [ ] **Agent capability schema** -- Structured capability descriptions beyond free-form tags
- [ ] **Message persistence** -- Optional store-and-forward for offline agents
- [ ] **Multi-transport** -- QUIC, WebRTC data channels
- [ ] **Plugin system** -- Extensible middleware pipeline for custom message processing
- [ ] **Production seed nodes** -- Geographically distributed seed node infrastructure

---

## License

MIT

---

## Built With

| Dependency | Purpose |
|---|---|
| [libp2p](https://libp2p.io/) | Modular P2P networking stack |
| [@chainsafe/libp2p-gossipsub](https://github.com/ChainSafe/js-libp2p-gossipsub) | Publish/subscribe message routing |
| [@chainsafe/libp2p-noise](https://github.com/ChainSafe/js-libp2p-noise) | Noise protocol encrypted transport |
| [@chainsafe/libp2p-yamux](https://github.com/ChainSafe/js-libp2p-yamux) | Stream multiplexing |
| [@noble/ed25519](https://github.com/paulmillr/noble-ed25519) | Ed25519 signing and verification |
| [LevelDB](https://github.com/Level/level) | Persistent key-value storage for ledgers and identity |
| [protobufjs](https://github.com/protobufjs/protobuf.js) | Protocol Buffer serialization |
| [it-pipe](https://github.com/alanshaw/it-pipe) | Streaming async iterable pipelines |

---

<p align="center">
  <sub>Leyline -- infrastructure for the agentic future.</sub>
</p>
