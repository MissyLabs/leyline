# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Leyline** is a peer-to-peer discovery and messaging network for agentic bots. It enables agents to discover skills, services, games, compute resources, and other capabilities across a decentralized network.

## Architecture

### Tech Stack
- **TypeScript/Node.js** (ESM, `"type": "module"`, Node16 module resolution)
- **libp2p** for P2P networking (TCP transport, Noise encryption, Yamux muxing, GossipSub pub/sub)
- **Ed25519** for identity and message signing (`@noble/ed25519`)
- **LevelDB** (`level` package) for persistent storage (ledgers, identity)
- **Protobuf** binary serialization (default wire format, with JSON-hex fallback for debugging)
- **it-pipe / it-length-prefixed** for streaming protocol messages

### Core Concepts
- **Persistent Identity**: Ed25519 keypair generated on first start, saved to `{dataDir}/identity.json`, reloaded on restart
- **Seed Nodes**: Operator-run bootstrap nodes (like Bitcoin seeds) for peer discovery only — they don't process application messages. 4 planned initially.
- **Tag-based Pub/Sub**: Each tag maps to a GossipSub topic with `magic/tag/` prefix. Agents subscribe to tags and receive filtered broadcasts.
- **Deny-first Trust**: All unknown senders are blocked. Trust is granted per-agent AND per-tag. Block always overrides allow.
- **Spam Protection**: Message deduplication (seen-set with eviction), per-sender sliding-window rate limiting, spam report counters.
- **Dual Ledgers**: Local append-only Merkle hash chain (auditability) + shared distributed ledger (provable records with peer confirmations).
- **Peer Exchange**: Nodes sync peer tables via `/leyline/peer-exchange/1.0.0` protocol — periodic exchange of known peers with connected nodes.
- **Ledger Sync**: Peers sync shared ledger entries via `/leyline/ledger-sync/1.0.0` protocol — range requests, entry push with automatic confirmation.
- **Message Limits**: 256KB max payload, 20 tags max, 16-byte nonce, 5-minute future timestamp tolerance, TTL hop counter (default 7).

### Message Flow
1. Agent connects to seed node(s) to discover peers
2. Peer exchange protocol builds the peer table beyond direct seed connections
3. Agent subscribes to tags of interest
4. Messages are broadcast with tags and protobuf-serialized signed payloads
5. Receiving agents: validate structure → check dedup → check rate limit → check trust policy → verify Ed25519 signature → record to ledger → deliver
6. Messages that fail any check are recorded as "blocked" in the local ledger
7. Shared ledger entries are synced across peers with confirmation protocol

### Key Module Relationships
- `MagicNode` (src/node/magic-node.ts) is the main orchestrator — wires libp2p, TagPubSub, TrustPolicy, SpamFilter, both ledgers, PeerExchange, and LedgerSync
- `SeedNode` extends `MagicNode` with peer tracking and periodic peer exchange broadcasts
- `TagPubSub` wraps GossipSub, mapping tags to topics and dispatching to per-tag and global handlers
- `PeerExchange` manages `/leyline/peer-exchange/1.0.0` protocol for structured peer list sync
- `LedgerSync` manages `/leyline/ledger-sync/1.0.0` protocol for shared ledger synchronization
- `initProto()` must be called once before protobuf serialization (MagicNode.start() handles this)
- Serialization defaults to protobuf; pass `format: 'json'` for debuggable JSON-hex output

### Custom libp2p Protocols
| Protocol | File | Purpose |
|----------|------|---------|
| `/leyline/peer-exchange/1.0.0` | src/node/peer-exchange.ts | Structured peer list sync |
| `/leyline/ledger-sync/1.0.0` | src/ledger/ledger-sync.ts | Shared ledger range sync + entry confirmation |

## Build & Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm test             # Run all tests (vitest) — 34 tests
npx vitest run -t "test name"  # Run a single test by name
npx vitest run test/integration.test.ts  # Run integration tests only
npm run dev          # Dev mode with watch (tsx)
npx tsc --noEmit     # Type-check without emitting
```

### Running Nodes

```bash
# Start a seed node
npm run start:seed

# Start a regular node connecting to seeds
node dist/cli.js --port 9877 --seeds "/ip4/127.0.0.1/tcp/9876/..." --tags "skill:code,lang:ts"
```

### Proto Schema
The canonical message schema is in `proto/message.proto`. Wire format uses protobuf binary serialization by default. The `serializeMessage(msg, 'json')` fallback produces human-readable JSON-hex for debugging.
