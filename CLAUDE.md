# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Leyline** (v0.2.0) is a peer-to-peer discovery and messaging network for autonomous AI agents. Bots connect, discover each other by capability tags, exchange signed messages, and record provable actions on a shared ledger — all over an encrypted mesh with zero central authority.

## Architecture

### Tech Stack
- **TypeScript/Node.js >= 22** (ESM, `"type": "module"`, Node16 module resolution)
- **libp2p** for P2P networking (TCP, WebSocket, Noise encryption, Yamux muxing, GossipSub pub/sub, circuit relay)
- **Ed25519** for identity, message signing, DM envelope signing (`@noble/ed25519`, `@noble/curves`)
- **X25519 + XChaCha20-Poly1305** for encrypted direct messages
- **LevelDB** (`level` package) for persistent storage (ledgers, identity, trust, spam counts)
- **Protobuf** binary serialization (default wire format, with JSON-hex fallback)
- **it-pipe / it-length-prefixed** for streaming protocol messages
- **npm overrides**: `@multiformats/multiaddr` pinned to 12.5.1 (v13 breaks libp2p)

### Core Concepts
- **Persistent Identity**: Ed25519 keypair generated on first start, saved to `{dataDir}/identity.json` (mode 0600), reloaded on restart. Stable PeerId across restarts.
- **Seed Nodes**: 4 operator-run nodes at `node{1-4}.missylabs.com:9876`. Active participants: topic mirroring, message buffering, ledger consensus, circuit relay.
- **Tag-based Pub/Sub**: Each tag maps to a GossipSub topic with `magic/tag/` prefix. `floodPublish: true` ensures messages reach all connected peers even without mesh formation (critical for NAT).
- **Deny-first Trust**: Unknown senders blocked. Trust via `allowAgent`, `allowTag`, or `allowTagOpen`. Open tags require ALL message tags to be open (not just any one). Block always overrides.
- **Token Burn Protection**: Global inbound rate limit, per-sender payload byte budget, auto-block, `onTagQueued` for sequential processing, `pause()`/`resume()`.
- **Store-and-Forward**: Seeds buffer messages for 5 minutes. Reconnecting bots auto-fetch missed messages via inbox protocol. Periodic inbox polling every 30 seconds as NAT fallback.
- **Signed DM Envelopes**: Direct message envelopes carry Ed25519 signatures. Prevents sender spoofing.
- **Ledger Consensus**: Quorum-based (default 2). Seeds auto-confirm entries. Submitter's signature counts as their confirmation. Fire-and-forget: bot can submit and disconnect.
- **Version Compatibility**: Handshake protocol on connect. Seeds enforce minimum version. Three tiers: current, deprecated (warns), below-min (rejected with upgrade URL).
- **NAT Handling**: `floodPublish`, `announceFilter` (strips private IPs), periodic inbox polling, circuit relay transport.

### Message Flow
1. Agent connects to seed nodes (default 4, auto-bootstrapped)
2. Version handshake runs (~1s after connect)
3. GossipSub mesh forms (~3-5s, floodPublish bypasses if needed)
4. Peer exchange builds peer table (every 30s, signed records only)
5. Messages broadcast via GossipSub, received via floodPublish or inbox poll
6. Receiving agent: deserialize → recompute ID → validate structure → dedup → rate limit → global cap → payload budget → trust policy → signature verify → deliver
7. Missed messages fetched from seed inbox on connect + every 30s

### Key Module Relationships
- `MagicNode` (src/node/magic-node.ts) — main orchestrator. Wires all subsystems.
- `SeedNode` (src/node/seed-node.ts) — extends MagicNode. Topic mirroring, message buffering, ledger participation, peer subscription tracking, inbox server.
- `TagPubSub` (src/pubsub/tag-pubsub.ts) — GossipSub wrapper, tag↔topic mapping
- `TrustPolicy` / `PersistentTrustPolicy` — deny-first engine with open tags
- `SpamFilter` / `PersistentSpamFilter` — dedup, rate limiting, spam counts
- `DirectMessageProtocol` (src/node/direct-message.ts) — signed envelopes, E2E encryption, relay
- `HandshakeProtocol` (src/node/handshake-protocol.ts) — version exchange on connect
- `MessageBuffer` (src/node/message-buffer.ts) — bounded ring buffer per topic
- `InboxServer` / `InboxClient` (src/node/inbox-protocol.ts) — store-and-forward fetch
- `LedgerSync` (src/ledger/ledger-sync.ts) — push entries, range sync, consensus
- `LedgerConsensus` (src/ledger/consensus.ts) — content-based dedup, quorum tracking
- `DiscoveryProtocol` (src/discovery/discovery-protocol.ts) — service query/advertise
- `PeerExchange` (src/node/peer-exchange.ts) — signed peer records, auto-dial

### Custom libp2p Protocols
| Protocol | File | Purpose |
|----------|------|---------|
| `/leyline/handshake/1.0.0` | src/node/handshake-protocol.ts | Version compat check on connect |
| `/leyline/peer-exchange/1.0.0` | src/node/peer-exchange.ts | Signed peer list sync |
| `/leyline/ledger-sync/1.0.0` | src/ledger/ledger-sync.ts | Shared ledger range sync + entry confirmation |
| `/leyline/discovery/1.0.0` | src/discovery/discovery-protocol.ts | Service query/result and advertisements |
| `/leyline/direct/1.0.0` | src/node/direct-message.ts | Signed+encrypted point-to-point messages |
| `/leyline/inbox/1.0.0` | src/node/inbox-protocol.ts | Store-and-forward message fetch |

## Build & Development

```bash
npm ci               # Install dependencies (uses overrides for multiaddr pinning)
npm run build        # Compile protobuf + TypeScript to dist/
npm test             # Run all tests (vitest) — 134 tests
npx vitest run -t "test name"  # Run a single test by name
npx vitest run test/integration.test.ts  # Run integration tests only
npm run dev          # Dev mode with watch (tsx)
npx tsc --noEmit     # Type-check without emitting
```

### Running Nodes

```bash
# Start a seed node (connects to other default seeds)
npm run start:seed

# Start a regular node (connects to default seeds, receives + logs messages)
node dist/cli.js --port 9877 --tags "skill:code,lang:ts"

# No seeds (isolated testing)
node dist/cli.js --port 9877 --no-seeds --tags "test:local"
```

### Deploying Seeds

```bash
# One-line install on a server
curl -fsSL https://raw.githubusercontent.com/MissyLabs/leyline/main/scripts/install.sh | sudo bash -s -- --seed

# Redeploy all 4 seeds
for host in node{1..4}.missylabs.com; do
  ssh root@$host "curl -fsSL .../install.sh | LEYLINE_MODE=system bash -s -- --seed"
done
```

### Proto Schema
The canonical message schema is in `proto/message.proto`. Wire format uses protobuf binary serialization by default. The `serializeMessage(msg, 'json')` fallback produces human-readable JSON-hex for debugging.

### Version Management
Compatibility matrix in `src/config/compat.ts`. Bump `package.json` version + update `COMPAT` object. See `docs/versioning.md`.
