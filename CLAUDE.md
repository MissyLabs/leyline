# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Magic** is a peer-to-peer discovery and messaging network for agentic bots. It enables agents to discover skills, services, games, compute resources, and other capabilities across a decentralized network.

## Architecture

### Tech Stack
- **TypeScript/Node.js** (ESM, `"type": "module"`, Node16 module resolution)
- **libp2p** for P2P networking (TCP transport, Noise encryption, Yamux muxing, GossipSub pub/sub)
- **Ed25519** for identity and message signing (`@noble/ed25519`)
- **LevelDB** (`level` package) for persistent storage (ledgers)
- **Protobuf** schema defined in `proto/message.proto` (wire format currently uses JSON-hex for debuggability)

### Core Concepts
- **Seed Nodes**: Operator-run bootstrap nodes (like Bitcoin seeds) for peer discovery only — they don't process application messages. 4 planned initially.
- **Tag-based Pub/Sub**: Each tag maps to a GossipSub topic with `magic/tag/` prefix. Agents subscribe to tags and receive filtered broadcasts.
- **Deny-first Trust**: All unknown senders are blocked. Trust is granted per-agent AND per-tag. Block always overrides allow.
- **Spam Protection**: Message deduplication (seen-set with eviction), per-sender sliding-window rate limiting, spam report counters.
- **Dual Ledgers**: Local append-only Merkle hash chain (auditability) + shared distributed ledger (provable records with peer confirmations).
- **Message Limits**: 256KB max payload, 20 tags max, 16-byte nonce, 5-minute future timestamp tolerance, TTL hop counter (default 7).

### Message Flow
1. Agent connects to seed node(s) to discover peers
2. Agent subscribes to tags of interest
3. Messages are broadcast with tags and signed payloads
4. Receiving agents: validate structure → check dedup → check rate limit → check trust policy → verify Ed25519 signature → record to ledger → deliver
5. Messages that fail any check are recorded as "blocked" in the local ledger

### Key Module Relationships
- `MagicNode` (src/node/magic-node.ts) is the main orchestrator — it wires together libp2p, TagPubSub, TrustPolicy, SpamFilter, and both ledgers
- `SeedNode` extends `MagicNode` with peer tracking and periodic peer exchange broadcasts
- `TagPubSub` wraps GossipSub, mapping tags to topics and dispatching to per-tag and global handlers
- `TrustPolicy` and `SpamFilter` are stateless in-memory engines (no persistence yet)
- Messages are created via `createMessage()` which handles nonce generation, hashing, and signing in one call

## Build & Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm test             # Run all tests (vitest)
npx vitest run -t "test name"  # Run a single test by name
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
The canonical message schema is in `proto/message.proto`. The current wire format uses JSON with hex-encoded binary fields for debuggability. Protobuf binary serialization is a planned migration.
