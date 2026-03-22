# Leyline Architecture

Comprehensive technical architecture documentation for the Leyline P2P network.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Network Topology](#network-topology)
3. [Component Architecture](#component-architecture)
4. [Message Lifecycle](#message-lifecycle)
5. [Security Model](#security-model)
6. [Ledger System](#ledger-system)
7. [Peer Exchange Protocol](#peer-exchange-protocol)
8. [Ledger Sync Protocol](#ledger-sync-protocol)
9. [Protobuf Wire Format](#protobuf-wire-format)
10. [Data Flow Diagrams](#data-flow-diagrams)

---

## System Overview

Leyline is a decentralized peer-to-peer network that enables AI agents to discover each other, advertise capabilities, and exchange signed messages without reliance on any central authority. The system is built on libp2p and uses GossipSub for message propagation, custom stream protocols for peer exchange and ledger synchronization, and Ed25519 cryptography for identity and message integrity.

### High-Level Component Diagram

```
+=========================================================================+
|                         LEYLINE NODE (MagicNode)                        |
|                                                                         |
|  +-------------------+    +-------------------+    +-----------------+  |
|  |   IdentityStore   |    |    MagicConfig     |    |   CLI / App    |  |
|  | identity.json     |    | ports, seeds, tags |    |   Interface    |  |
|  | Ed25519 keypair   |    | limits, dataDir    |    |                |  |
|  +--------+----------+    +--------+----------+    +-------+--------+  |
|           |                        |                       |            |
|  +--------+------------------------+-----------------------+--------+   |
|  |                          MagicNode                               |   |
|  |  Orchestrates all subsystems, wires events, handles lifecycle    |   |
|  +----+--------+--------+--------+--------+--------+--------+------+   |
|       |        |        |        |        |        |        |           |
|  +----+--+ +---+---+ +--+---+ +-+------+ +--+---+ +--+---+ +--+----+  |
|  |libp2p | |TagPub | |Trust | | Spam   | |Local | |Shared| |Peer   |  |
|  |       | |Sub    | |Policy| | Filter | |Ledger| |Ledger| |Exch.  |  |
|  |TCP    | |       | |      | |        | |      | |      | |       |  |
|  |Noise  | |Gossip | |Deny  | |Dedup   | |Merkle| |Hash  | |Proto  |  |
|  |Yamux  | |Sub    | |First | |Rate    | |Chain | |Chain | |Stream |  |
|  |       | |Topics | |      | |Limit   | |Level | |Level | |       |  |
|  +-------+ +-------+ +------+ +--------+ +------+ +------+ +-------+  |
|                                                                         |
|  +------------------------------------------------------------------+  |
|  |                      LedgerSync                                  |  |
|  |  /leyline/ledger-sync/1.0.0 -- range req, push, confirm         |  |
|  +------------------------------------------------------------------+  |
+=========================================================================+
```

### Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Transport | TCP via `@libp2p/tcp` | Reliable stream connections |
| Encryption | Noise protocol via `@chainsafe/libp2p-noise` | Authenticated encrypted channels |
| Multiplexing | Yamux via `@chainsafe/libp2p-yamux` | Multiple logical streams per connection |
| Pub/Sub | GossipSub via `@chainsafe/libp2p-gossipsub` | Efficient message flooding with mesh topology |
| Identity | Ed25519 via `@noble/ed25519` | Signing, verification, persistent keypairs |
| Storage | LevelDB via `level` | Persistent ledger and identity storage |
| Serialization | Protocol Buffers via `protobufjs` | Compact wire encoding |
| Streaming | `it-pipe` + `it-length-prefixed` | Framed async stream processing |

---

## Network Topology

### Node Types

**Seed Nodes** are operator-run bootstrap points. They exist solely for initial peer discovery and do not process application-level messages. The `SeedNode` class extends `MagicNode` with:

- Peer tracking (connect/disconnect events update a known-peer map)
- Periodic peer list broadcasts every 30 seconds via the `magic/discovery` GossipSub topic
- Stale peer pruning (peers not seen in 30 minutes are evicted)

Seed nodes do not subscribe to any application tags. They subscribe only to the discovery topic.

**Regular Nodes** (`MagicNode`) are the workhorses of the network. They:

- Connect to seed nodes for initial peer discovery
- Subscribe to application tags and process messages
- Participate in the peer exchange protocol to grow their mesh
- Maintain local and shared ledgers
- Enforce trust policies and spam filtering

### Mesh Formation

```
Phase 1: Bootstrap
==================
                    +--------+
         +--------->| Seed A |<----------+
         |          +--------+           |
         |                               |
     +---+---+                       +---+---+
     |Node 1 |                       |Node 2 |
     +-------+                       +-------+

Phase 2: Peer Exchange
======================
     Node 1 learns about Node 2 via Seed A's peer list.
     Node 2 learns about Node 1.
     Both initiate /leyline/peer-exchange/1.0.0.

Phase 3: Direct Mesh
=====================
     +-------+          +--------+          +-------+
     |Node 1 |<-------->| Seed A |<-------->|Node 2 |
     +---+---+          +--------+          +---+---+
         |                                      |
         +--------------------------------------+
                   Direct connection
                   (bypasses seed)

Phase 4: Full Mesh (with more nodes)
=====================================
     +-------+    +-------+    +-------+
     |Node 1 |<-->|Node 2 |<-->|Node 3 |
     +---+---+    +---+---+    +---+---+
         |            |            |
         +------+-----+-----+-----+
                |           |
           +----+---+  +---+----+
           | Seed A |  | Seed B |
           +--------+  +--------+
```

Mesh formation is organic. GossipSub maintains its own mesh topology for each topic, using a heartbeat-driven protocol that targets a configurable number of mesh peers per topic. The Leyline peer exchange protocol supplements this with explicit peer table synchronization.

---

## Component Architecture

### MagicNode (`src/node/magic-node.ts`)

The central orchestrator. Its `start()` method performs the following sequence:

1. Call `initProto()` to load the protobuf schema
2. Load or generate the Ed25519 identity via `IdentityStore`
3. Convert the Ed25519 private key to a libp2p-compatible format
4. Create and start the libp2p node with TCP + Noise + Yamux + GossipSub
5. Initialize `TagPubSub` with the GossipSub service
6. Subscribe to configured tags and the discovery topic
7. Wire the GossipSub message event to `handleIncomingMessage()`
8. Wire peer connect/disconnect events
9. Open both LevelDB-backed ledgers
10. Start the `PeerExchange` protocol handler
11. Start the `LedgerSync` protocol handler

**Key design decision**: `MagicNode` exposes a high-level API (`broadcast`, `advertise`, `discover`, `onTag`, `allowAgent`, `blockAgent`) that abstracts away the underlying libp2p mechanics. Application code never needs to interact with GossipSub directly.

### SeedNode (`src/node/seed-node.ts`)

Extends `MagicNode` with seed-specific behavior:

- Forces `isSeedNode: true` and `subscribedTags: []` in config
- Hooks `onPeerConnected` / `onPeerDisconnected` to maintain a known-peer map
- Runs a 30-second interval that prunes stale peers and broadcasts the peer list via the discovery topic
- Provides `getKnownPeers()`, `getConnectedPeerCount()`, and `pruneStale()` APIs

### TagPubSub (`src/pubsub/tag-pubsub.ts`)

A thin abstraction layer over GossipSub that maps tags to topics:

- **Topic naming**: Each tag `T` maps to GossipSub topic `magic/tag/T`
- **Discovery topic**: `magic/discovery` is a separate topic for peer discovery broadcasts
- **Handler dispatch**: Supports both per-tag handlers (`onTag`) and global handlers (`onMessage`)
- **Publish**: Publishing to multiple tags fans out to multiple GossipSub topics in parallel

### TrustPolicy (`src/trust/policy.ts`)

Implements the deny-first trust model with four levels of control:

```
Evaluation Order:
=================
    Message arrives from pubkeyHex with [tag1, tag2]
                    |
                    v
    +--- Agent blocked? ---+
    | YES --> DENY         |
    | NO  --> continue     |
    +----------+-----------+
               |
               v
    +--- Agent allowed? ---+
    | NO  --> DENY         |
    | YES --> continue     |
    +----------+-----------+
               |
               v
    +--- Any tag rules? ---+
    | NO  --> ALLOW        |
    | YES --> check each   |
    +----------+-----------+
               |
               v
    For each tag:
      Tag blocked? --> DENY
      Tag not allowed? --> DENY
                    |
                    v
                  ALLOW
```

The `AgentPolicy` internal structure stores:
- `allowed: boolean` -- agent-level whitelist
- `blocked: boolean` -- agent-level blacklist (overrides allow)
- `allowedTags: Set<string>` -- per-tag whitelist
- `blockedTags: Set<string>` -- per-tag blacklist

### SpamFilter (`src/trust/policy.ts`)

Three independent protection mechanisms:

1. **Deduplication**: A bounded `Set<string>` of seen message ID hashes. When the set reaches `maxSeenSize`, the oldest 25% of entries are evicted (bulk eviction exploiting V8's Set insertion-order guarantee).

2. **Rate Limiting**: Per-sender sliding window of message timestamps. The window covers the last 60 seconds. Timestamps older than the window are pruned on each call using binary search (`#lowerBound`). A sender is rate-limited when `window.length > maxPerMinute`.

3. **Spam Reporting**: Cumulative per-sender spam report counters. Incremented automatically when a sender is rate-limited or fails signature verification.

### LocalLedger (`src/ledger/local-log.ts`)

An append-only Merkle hash chain backed by LevelDB:

```
Entry 0 (genesis)          Entry 1                    Entry 2
+--------------------+     +--------------------+     +--------------------+
| index: 0           |     | index: 1           |     | index: 2           |
| prevHash: (empty)  |     | prevHash: hash_0   |---->| prevHash: hash_1   |
| hash: hash_0       |---->| hash: hash_1       |     | hash: hash_2       |
| message: ...       |     | message: ...       |     | message: ...       |
| action: "sent"     |     | action: "received" |     | action: "blocked"  |
| recordedAt: ts     |     | recordedAt: ts     |     | recordedAt: ts     |
+--------------------+     +--------------------+     +--------------------+
```

Hash computation: `SHA-256(index || prevHash || message || timestamp || action)`

The chain can be verified end-to-end via `verify()`, which walks from genesis to tip, recomputing each hash and checking `prevHash` linkage.

**Storage format**: LevelDB keys are zero-padded 20-digit index strings (e.g., `00000000000000000042`). A special `__count__` key tracks the total entry count for O(1) initialization.

### SharedLedger (`src/ledger/shared-ledger.ts`)

A distributed ledger for provable records with peer confirmations:

- Entries are submitted with a submitter's public key and signature
- Peers can add confirmations to entries they validate
- Uses the same hash-chain structure as the local ledger
- Entries are 1-indexed (index 0 is reserved)
- Metadata stored at `meta:latest` key with current index and hash

### LedgerSync (`src/ledger/ledger-sync.ts`)

Custom libp2p stream protocol for shared ledger synchronization. See [Ledger Sync Protocol](#ledger-sync-protocol) for details.

### PeerExchange (`src/node/peer-exchange.ts`)

Custom libp2p stream protocol for peer table synchronization. See [Peer Exchange Protocol](#peer-exchange-protocol) for details.

---

## Message Lifecycle

### Creation

```typescript
createMessage({
  tags: ['skill:code'],
  payload: new TextEncoder().encode('{"offer": "review"}'),
  type: MessageType.ADVERTISE,
  privateKey: keypair.privateKey,
  publicKey: keypair.publicKey,
  ttl: 7,  // optional, defaults to 7
})
```

Steps:
1. Generate 16 random bytes as nonce (via Node.js `crypto.randomBytes`)
2. Capture `Date.now()` as millisecond timestamp
3. Build signable byte sequence: `payload || tags.join(",") || timestamp(BE64) || nonce`
4. Compute `id = SHA-256(signable)`
5. Compute `signature = Ed25519.sign(privateKey, signable)`
6. Return the complete `MagicMessage` object

### Serialization

Two formats are supported:

**Protobuf (default)**: Uses the `magic.MagicMessage` protobuf type from `proto/message.proto`. Fields are mapped from TypeScript camelCase to proto snake_case. The `MessageType` enum values (1-5) are identical between TypeScript and proto.

**JSON-hex**: All `Uint8Array` fields are hex-encoded. The resulting JSON string is UTF-8 encoded to bytes. This format is approximately 40-60% larger than protobuf but is human-readable.

### Validation Pipeline

When a message arrives at a node, it passes through a strict validation pipeline in `handleIncomingMessage()`:

```
Step 1: Deserialize
  - Decode protobuf bytes to MagicMessage
  - On failure: silently drop (malformed data)

Step 2: Structural Validation (validateMessage)
  - Payload size <= 256KB
  - Tags: 1-20 tags, each <= 100 characters
  - TTL > 0
  - Timestamp not > 5 minutes in the future
  - Nonce exactly 16 bytes
  - Signature exactly 64 bytes
  - On failure: record as "blocked" in local ledger

Step 3: Deduplication (SpamFilter.isDuplicate)
  - Check message ID hex against seen-set
  - On duplicate: silently drop

Step 4: Rate Limiting (SpamFilter.isRateLimited)
  - Check sender against 60-second sliding window
  - On rate limit: report spam, record as "blocked"

Step 5: Trust Policy (TrustPolicy.isAllowed)
  - Deny-first check: agent-level then tag-level
  - On denial: record as "blocked" in local ledger

Step 6: Signature Verification (verifyMessageSignature)
  - Reconstruct signable bytes from message fields
  - Verify Ed25519 signature against senderPubkey
  - On failure: report spam, record as "blocked"

Step 7: Accept
  - Record as "received" in local ledger
  - Dispatch to TagPubSub handlers
  - Fire global onMessage event
```

---

## Security Model

### Cryptographic Identity

Every Leyline node has a persistent Ed25519 keypair:

- **Private key**: 32 bytes (scalar seed), stored in `{dataDir}/identity.json`
- **Public key**: 32 bytes (compressed Edwards point), used as the node's network identity
- **Fingerprint**: First 8 bytes (16 hex chars) of `SHA-256(publicKey)`, used for logging

Keys are generated on first start using `@noble/ed25519`'s CSPRNG-backed random key generation and persisted to disk as hex-encoded JSON. Subsequent starts reload the same keypair.

### Transport Security

All libp2p connections use the Noise protocol for authenticated encryption:

- Diffie-Hellman key exchange establishes a shared secret
- All data is encrypted with a symmetric cipher derived from the shared secret
- Peer identity is authenticated during the handshake

### Message Integrity

Every message includes:
- **Nonce**: 16 random bytes to prevent replay attacks
- **Timestamp**: Unix milliseconds, checked against a 5-minute future tolerance
- **Signature**: Ed25519 signature over `payload || tags || timestamp || nonce`
- **ID**: SHA-256 hash of the same signed content, used for deduplication

### Deny-First Trust

The trust model is designed for adversarial environments:

- **Default deny**: All unknown senders are blocked
- **Explicit allow required**: Agents must be whitelisted before their messages are processed
- **Block overrides allow**: A blocked agent remains blocked regardless of any allow rules
- **Tag-level granularity**: Trust can be scoped to specific tags
- **No implicit trust**: Being connected to a peer does not grant message trust

### Spam Protection

Multiple layers of protection against abuse:

| Layer | Mechanism | Parameters |
|---|---|---|
| Deduplication | Seen-set with 25% bulk eviction | 100,000 entries (default) |
| Rate limiting | Per-sender sliding 60-second window | 60 messages/minute (default) |
| Spam reporting | Cumulative per-sender counter | Auto-incremented on rate limit or bad signature |
| Payload size | Hard limit on message payload | 256 KB |
| Tag count | Hard limit on tags per message | 20 tags |
| TTL | Hop counter decremented on relay | Default 7, drop at 0 |
| Future timestamp | Reject messages from the future | 5-minute tolerance |

---

## Ledger System

### Local Ledger

Purpose: Provide a tamper-evident audit trail of all message activity on a node.

**Hash chain construction**:
```
hash_i = SHA-256(
    index_i (8 bytes, big-endian) ||
    hash_{i-1} (32 bytes, or empty for genesis) ||
    message (variable length) ||
    recordedAt (8 bytes, big-endian) ||
    action (UTF-8 string)
)
```

**Actions recorded**:
- `sent` -- message broadcast by this node
- `received` -- message accepted after full validation
- `blocked` -- message rejected (validation, trust, rate limit, or signature failure)

**Verification**: The `verify()` method walks the entire chain from index 0, recomputing each hash and checking that `entry[i].prevHash === entry[i-1].hash`. Returns `true` only if the entire chain is consistent.

### Shared Ledger

Purpose: Maintain provable records that can be independently verified by peers.

**Entry structure**:
```
SharedLedgerEntry {
    index:             Sequential position (1-indexed)
    prevHash:          SHA-256 hash of previous entry
    hash:              SHA-256(index || prevHash || data || submitterPubkey || timestamp)
    data:              Arbitrary binary payload
    submitterPubkey:   Ed25519 public key of the submitter
    signature:         Ed25519 signature over the data
    timestamp:         Submission time (Unix ms)
    confirmations:     Number of peer confirmations
    confirmerPubkeys:  Public keys of confirming peers
}
```

**Confirmation protocol**: When a peer receives a shared ledger entry, it:
1. Verifies the submitter's Ed25519 signature over the data
2. If valid, ingests the entry and adds its own confirmation
3. Sends a `confirm-entry` message back to the sender

Confirmations are idempotent -- a peer's public key can only appear once in the confirmer list.

---

## Peer Exchange Protocol

**Protocol ID**: `/leyline/peer-exchange/1.0.0`

**Transport**: Length-prefixed JSON over a libp2p stream (using `it-pipe` and `it-length-prefixed`).

### Message Types

**Request** (initiator sends):
```json
{
    "type": "request",
    "peers": [PeerRecord...],
    "senderPeerId": "QmAbc...",
    "timestamp": 1700000000000
}
```

**Response** (responder sends):
```json
{
    "type": "response",
    "peers": [PeerRecord...],
    "senderPeerId": "QmDef...",
    "timestamp": 1700000000001
}
```

**PeerRecord**:
```json
{
    "peerId": "QmAbc...",
    "multiaddrs": ["/ip4/10.0.0.1/tcp/9876"],
    "pubkeyHex": "a3f0c1b2...",
    "offeredTags": ["skill:code", "lang:ts"],
    "lastSeen": 1700000000000
}
```

### Exchange Flow

```
    Node A                           Node B
      |                                |
      |  dialProtocol(PEX)             |
      |------------------------------->|
      |                                |
      |  Request{peers: A's table}     |
      |------------------------------->|
      |                                | Merge A's peers
      |                                | into B's table
      |  Response{peers: B's table}    |
      |<-------------------------------|
      | Merge B's peers                |
      | into A's table                 |
      |                                |
```

### Operational Parameters

| Parameter | Default | Description |
|---|---|---|
| `maxPeers` | 500 | Maximum peer records in the table |
| `maxPeerAge` | 30 minutes | Stale peer eviction threshold |
| `exchangeIntervalMs` | 30 seconds | Periodic exchange frequency |
| Max peers per exchange | 50 | Randomly sampled from table |
| Eviction rate | 10% | Oldest peers evicted when over `maxPeers` |

---

## Ledger Sync Protocol

**Protocol ID**: `/leyline/ledger-sync/1.0.0`

**Transport**: Length-prefixed JSON over a libp2p stream.

### Message Types

**RangeRequest**: Request entries in a range.
```json
{
    "type": "range-request",
    "senderPeerId": "QmAbc...",
    "timestamp": 1700000000000,
    "startIndex": 42,
    "endIndex": 141
}
```

**RangeResponse**: Return requested entries.
```json
{
    "type": "range-response",
    "senderPeerId": "QmDef...",
    "timestamp": 1700000000001,
    "entries": [SerializedEntry...],
    "totalEntries": 500
}
```

**PushEntry**: Push a new entry for peer validation and confirmation.
```json
{
    "type": "push-entry",
    "senderPeerId": "QmAbc...",
    "timestamp": 1700000000000,
    "entry": SerializedEntry
}
```

**ConfirmEntry**: Confirm a validated entry.
```json
{
    "type": "confirm-entry",
    "senderPeerId": "QmDef...",
    "timestamp": 1700000000001,
    "entryIndex": 42,
    "confirmerPubkey": "a3f0c1b2..."
}
```

### Sync Flow

```
    Node A                              Node B
      |                                   |
      |  "I have 100 entries.             |
      |   Give me entries 101-200."       |
      |                                   |
      |  RangeRequest{101, 200}           |
      |---------------------------------->|
      |                                   |
      |  RangeResponse{entries[101-150]}  |
      |<----------------------------------|
      |                                   |
      |  (A validates & ingests entries)  |
      |                                   |
```

### Push + Confirm Flow

```
    Node A                              Node B
      |                                   |
      |  PushEntry{entry}                 |
      |---------------------------------->|
      |                                   | Validate signature
      |                                   | Ingest entry
      |                                   | Add own confirmation
      |  ConfirmEntry{index, pubkey}      |
      |<----------------------------------|
      |                                   |
      |  (A records B's confirmation)     |
      |                                   |
```

### Periodic Sync

The `LedgerSync` instance runs a periodic sync (default: every 60 seconds) that:
1. Gets the local entry count
2. For each connected peer, requests entries `[localCount+1, localCount+100]`
3. Validates each received entry (verifies submitter's signature)
4. Ingests valid entries into the local shared ledger

---

## Protobuf Wire Format

The canonical schema is defined in `proto/message.proto`. Three top-level message types are defined:

### MagicMessage

The core network envelope:

| Field | Type | Number | Description |
|---|---|---|---|
| `id` | bytes | 1 | SHA-256 message ID (32 bytes) |
| `sender_pubkey` | bytes | 2 | Ed25519 public key (32 bytes) |
| `signature` | bytes | 3 | Ed25519 signature (64 bytes) |
| `tags` | repeated string | 4 | Routing tags |
| `payload` | bytes | 5 | Application data (max 256KB) |
| `timestamp` | uint64 | 6 | Unix milliseconds |
| `nonce` | bytes | 7 | Random nonce (16 bytes) |
| `type` | MessageType | 8 | Enum: BROADCAST, DIRECT, ADVERTISE, DISCOVER, DISCOVER_RESPONSE |
| `ttl` | uint32 | 9 | Remaining hop count |

### LedgerEntry

Local ledger chain entry:

| Field | Type | Number | Description |
|---|---|---|---|
| `index` | uint64 | 1 | Sequential chain position |
| `prev_hash` | bytes | 2 | Hash of previous entry |
| `hash` | bytes | 3 | This entry's hash |
| `message` | MagicMessage | 4 | The recorded message |
| `recorded_at` | uint64 | 5 | Local recording timestamp |
| `action` | LedgerAction | 6 | SENT, RECEIVED, BLOCKED, RELAYED |

### SharedLedgerEntry

Distributed ledger entry with confirmations:

| Field | Type | Number | Description |
|---|---|---|---|
| `index` | uint64 | 1 | Sequential position |
| `prev_hash` | bytes | 2 | Hash of previous entry |
| `hash` | bytes | 3 | This entry's hash |
| `data` | bytes | 4 | Provable data payload |
| `submitter_pubkey` | bytes | 5 | Submitter's Ed25519 public key |
| `signature` | bytes | 6 | Submitter's signature over data |
| `timestamp` | uint64 | 7 | Submission time |
| `confirmations` | uint32 | 8 | Confirmation count |
| `confirmer_pubkeys` | repeated bytes | 9 | Public keys of confirmers |

### PeerInfo and PeerExchange

Peer discovery messages:

| Field | Type | Number | Description |
|---|---|---|---|
| PeerInfo.`peer_id` | bytes | 1 | libp2p peer ID |
| PeerInfo.`pubkey` | bytes | 2 | Ed25519 public key |
| PeerInfo.`multiaddrs` | repeated string | 3 | Reachable addresses |
| PeerInfo.`offered_tags` | repeated string | 4 | Advertised tags |
| PeerInfo.`last_seen` | uint64 | 5 | Last activity timestamp |
| PeerExchange.`peers` | repeated PeerInfo | 1 | Peer list |

---

## Data Flow Diagrams

### Agent Advertising a Skill

```
Agent Code                    MagicNode                  Network
    |                             |                         |
    | advertise(                   |                         |
    |   ['skill:code'],           |                         |
    |   payload                   |                         |
    | )                           |                         |
    |------------>                |                         |
    |             | createMessage |                         |
    |             | (nonce, ts,   |                         |
    |             |  SHA-256 id,  |                         |
    |             |  Ed25519 sig) |                         |
    |             |               |                         |
    |             | serialize     |                         |
    |             | (protobuf)    |                         |
    |             |               |                         |
    |             | TagPubSub     |                         |
    |             | .publish()    |                         |
    |             |-------------->| GossipSub               |
    |             |               | magic/tag/skill:code    |
    |             |               |------------------------>|
    |             |               |                         |
    |             | LocalLedger   |                         |
    |             | .append()     |                         |
    |             | action:"sent" |                         |
    |             |               |                         |
    |<------------|               |                         |
    | MagicMessage                |                         |
```

### Receiving and Validating a Message

```
Network                    MagicNode                      Agent Code
    |                          |                               |
    | GossipSub event          |                               |
    |------------------------->|                               |
    |                          | deserializeMessage()          |
    |                          | validateMessage()             |
    |                          |   payload <= 256KB?           |
    |                          |   tags valid?                 |
    |                          |   TTL > 0?                    |
    |                          |   timestamp not future?       |
    |                          |   nonce 16 bytes?             |
    |                          |   signature 64 bytes?         |
    |                          |                               |
    |                          | SpamFilter.isDuplicate()      |
    |                          | SpamFilter.isRateLimited()    |
    |                          | TrustPolicy.isAllowed()       |
    |                          | verifyMessageSignature()      |
    |                          |                               |
    |                          | LocalLedger.append("received")|
    |                          |                               |
    |                          | TagPubSub.handleMessage()     |
    |                          |------------------------------>|
    |                          |                               | onTag handler
    |                          | events.onMessage()            |
    |                          |------------------------------>|
    |                          |                               | global handler
```

### Node Startup Sequence

```
start()
  |
  v
initProto()  ............  Load proto/message.proto schema
  |
  v
IdentityStore.load()  ...  Load or generate Ed25519 keypair
  |
  v
createLibp2p()  .........  TCP + Noise + Yamux + GossipSub
  |                         + Bootstrap (if seeds configured)
  v
TagPubSub(gossipsub)  ...  Initialize tag-to-topic mapping
  |
  v
subscribe(tags)  ........  Subscribe to configured tags
subscribeDiscovery()        + discovery topic
  |
  v
addEventListener()  .....  Wire GossipSub -> handleIncomingMessage()
                           Wire peer:connect -> events.onPeerConnected()
                           Wire peer:disconnect -> events.onPeerDisconnected()
  |
  v
LocalLedger.open()  .....  Open LevelDB for local chain
SharedLedger.open()         Open LevelDB for shared chain
  |
  v
PeerExchange.start()  ...  Register /leyline/peer-exchange/1.0.0
                           Start 30s periodic exchange
  |
  v
LedgerSync.start()  .....  Register /leyline/ledger-sync/1.0.0
                           Start 60s periodic sync
  |
  v
[NODE READY]
```
