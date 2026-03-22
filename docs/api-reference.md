# Leyline API Reference

Complete API documentation for all public exports of the `magic-network` package.

---

## Table of Contents

- [MagicNode](#magicnode)
- [SeedNode](#seednode)
- [Identity](#identity)
  - [generateKeypair](#generatekeypair)
  - [sign](#sign)
  - [verify](#verify)
  - [publicKeyToHex](#publickeytohex)
  - [hexToPublicKey](#hextopublickey)
  - [getFingerprint](#getfingerprint)
  - [IdentityStore](#identitystore)
- [Messages](#messages)
  - [MagicMessage](#magicmessage)
  - [MessageType](#messagetype)
  - [createMessage](#createmessage)
  - [serializeMessage](#serializemessage)
  - [deserializeMessage](#deserializemessage)
  - [serializeMessageJson](#serializemessagejson)
  - [deserializeMessageJson](#deserializemessagejson)
  - [validateMessage](#validatemessage)
  - [verifyMessageSignature](#verifymessagesignature)
  - [initProto](#initproto)
- [TagPubSub](#tagpubsub)
- [Trust](#trust)
  - [TrustPolicy](#trustpolicy)
  - [SpamFilter](#spamfilter)
- [Ledgers](#ledgers)
  - [LocalLedger](#localledger)
  - [SharedLedger](#sharedledger)
  - [LedgerSync](#ledgersync)
- [PeerExchange](#peerexchange)
- [Configuration](#configuration)
  - [MagicConfig](#magicconfig)
  - [DEFAULT_CONFIG](#default_config)
  - [mergeConfig](#mergeconfig)

---

## MagicNode

`src/node/magic-node.ts`

The main node orchestrator. Wires together libp2p, TagPubSub, TrustPolicy, SpamFilter, both ledgers, PeerExchange, and LedgerSync.

### Constructor

```typescript
new MagicNode(config: Partial<MagicConfig>, events?: MagicNodeEvents)
```

| Parameter | Type | Description |
|---|---|---|
| `config` | `Partial<MagicConfig>` | Node configuration (merged with `DEFAULT_CONFIG`) |
| `events` | `MagicNodeEvents` | Optional event handlers |

**MagicNodeEvents**:

```typescript
interface MagicNodeEvents {
  onMessage?: (msg: MagicMessage, tag: string) => void;
  onPeerConnected?: (peerId: string) => void;
  onPeerDisconnected?: (peerId: string) => void;
}
```

### Methods

#### `start(): Promise<void>`

Initializes and starts all subsystems. Must be called before any other method.

Startup sequence:
1. Load protobuf schema
2. Load or generate Ed25519 identity
3. Create and start libp2p node
4. Initialize TagPubSub and subscribe to configured tags
5. Open both ledgers
6. Start PeerExchange and LedgerSync protocols

#### `stop(): Promise<void>`

Gracefully shuts down all subsystems. Stops PeerExchange and LedgerSync, closes both ledgers, stops libp2p.

#### `broadcast(tags, payload, type?): Promise<MagicMessage>`

Broadcasts a signed message to the network.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `tags` | `string[]` | -- | Routing tags |
| `payload` | `Uint8Array` | -- | Message payload (max 256KB) |
| `type` | `MessageType` | `BROADCAST` | Message type |

**Returns**: The created and signed `MagicMessage`.

#### `advertise(tags, payload): Promise<MagicMessage>`

Convenience method for broadcasting with `MessageType.ADVERTISE`.

| Parameter | Type | Description |
|---|---|---|
| `tags` | `string[]` | Tags describing the advertised capability |
| `payload` | `Uint8Array` | Advertisement data |

#### `discover(tags, query): Promise<MagicMessage>`

Convenience method for broadcasting with `MessageType.DISCOVER`.

| Parameter | Type | Description |
|---|---|---|
| `tags` | `string[]` | Tags describing what is being searched for |
| `query` | `Uint8Array` | Discovery query data |

#### `subscribe(tag): void`

Subscribe to an additional tag at runtime.

| Parameter | Type | Description |
|---|---|---|
| `tag` | `string` | Tag to subscribe to |

#### `unsubscribe(tag): void`

Unsubscribe from a tag.

| Parameter | Type | Description |
|---|---|---|
| `tag` | `string` | Tag to unsubscribe from |

#### `onTag(tag, handler): void`

Register a handler for messages received on a specific tag.

| Parameter | Type | Description |
|---|---|---|
| `tag` | `string` | Tag to listen on |
| `handler` | `(msg: MagicMessage, tag: string) => void` | Callback |

Note: Messages delivered to tag handlers have already passed the full validation pipeline (structure, dedup, rate limit, trust, signature).

#### `allowAgent(pubkeyHex): void`

Whitelist an agent by their Ed25519 public key hex string.

| Parameter | Type | Description |
|---|---|---|
| `pubkeyHex` | `string` | 64-character hex-encoded public key |

#### `blockAgent(pubkeyHex): void`

Block an agent. Overrides any prior `allowAgent` call.

| Parameter | Type | Description |
|---|---|---|
| `pubkeyHex` | `string` | 64-character hex-encoded public key |

#### `submitToSharedLedger(data): Promise<void>`

Submit data to the shared distributed ledger. The data is signed with the node's private key.

| Parameter | Type | Description |
|---|---|---|
| `data` | `Uint8Array` | Arbitrary data to record |

#### `getPublicKeyHex(): string`

Returns the node's Ed25519 public key as a 64-character hex string.

#### `getFingerprint(): string`

Returns the node's fingerprint (first 16 hex characters of SHA-256 of the public key).

#### `getPeerCount(): number`

Returns the number of currently connected peers.

#### `getMultiaddrs(): string[]`

Returns the node's libp2p multiaddresses as strings.

#### `getLocalLedger(): LocalLedger`

Returns the local ledger instance.

#### `getSharedLedger(): SharedLedger`

Returns the shared ledger instance.

#### `getPeerExchange(): PeerExchange | null`

Returns the PeerExchange instance, or `null` if the node has not started.

#### `getLedgerSync(): LedgerSync | null`

Returns the LedgerSync instance, or `null` if the node has not started.

---

## SeedNode

`src/node/seed-node.ts`

Extends `MagicNode`. Seed nodes exist solely for peer discovery -- they do not process application messages.

### Constructor

```typescript
new SeedNode(config: Partial<MagicConfig>)
```

Forces `isSeedNode: true` and `subscribedTags: []` regardless of input config.

### Methods

Inherits all `MagicNode` methods plus:

#### `getKnownPeers(): Array<{ peerId: string; multiaddrs: string[]; lastSeen: number }>`

Returns all peers this seed node has seen, including those currently disconnected.

#### `getConnectedPeerCount(): number`

Returns the count of currently connected peers.

#### `pruneStale(maxAge?): number`

Remove peer records older than `maxAge` milliseconds (default: 30 minutes).

**Returns**: Number of peers pruned.

---

## Identity

### generateKeypair

`src/identity/keypair.ts`

```typescript
async function generateKeypair(): Promise<Keypair>
```

Generates a new random Ed25519 keypair using a CSPRNG.

**Returns**:
```typescript
interface Keypair {
  publicKey: Uint8Array;   // 32 bytes
  privateKey: Uint8Array;  // 32 bytes
}
```

### sign

```typescript
async function sign(privateKey: Uint8Array, data: Uint8Array): Promise<Uint8Array>
```

Signs arbitrary data with an Ed25519 private key.

| Parameter | Type | Description |
|---|---|---|
| `privateKey` | `Uint8Array` | 32-byte Ed25519 private key seed |
| `data` | `Uint8Array` | Data to sign |

**Returns**: 64-byte Ed25519 signature.

### verify

```typescript
async function verify(
  publicKey: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean>
```

Verifies an Ed25519 signature.

| Parameter | Type | Description |
|---|---|---|
| `publicKey` | `Uint8Array` | 32-byte Ed25519 public key |
| `signature` | `Uint8Array` | 64-byte signature to verify |
| `data` | `Uint8Array` | Original data that was signed |

**Returns**: `true` if the signature is valid.

### publicKeyToHex

```typescript
function publicKeyToHex(pubkey: Uint8Array): string
```

Encodes a 32-byte public key as a 64-character lowercase hex string.

### hexToPublicKey

```typescript
function hexToPublicKey(hex: string): Uint8Array
```

Decodes a 64-character hex string to a 32-byte public key.

**Throws**: `RangeError` if the decoded buffer is not exactly 32 bytes.

### getFingerprint

```typescript
function getFingerprint(pubkey: Uint8Array): string
```

Produces a 16-character hex fingerprint of a public key (first 8 bytes of SHA-256 digest). Intended for display/logging, not for cryptographic identity comparison.

### IdentityStore

`src/identity/store.ts`

Manages persistent Ed25519 keypair storage on disk.

#### Constructor

```typescript
new IdentityStore(dataDir: string)
```

| Parameter | Type | Description |
|---|---|---|
| `dataDir` | `string` | Directory for `identity.json` storage |

#### Methods

##### `getIdentityPath(): string`

Returns the absolute path to `identity.json`.

##### `exists(): Promise<boolean>`

Returns `true` if an identity file exists and is readable.

##### `load(): Promise<Keypair>`

Loads the persisted keypair. If no identity file exists, generates a new keypair, saves it, and returns it. The data directory is created recursively if absent.

**Throws**:
- `SyntaxError` if the file contains malformed JSON
- `RangeError` if persisted keys are not 32 bytes

##### `save(privateKey, publicKey): Promise<void>`

Saves a keypair to disk as hex-encoded JSON.

| Parameter | Type | Description |
|---|---|---|
| `privateKey` | `Uint8Array` | 32-byte private key seed |
| `publicKey` | `Uint8Array` | 32-byte public key |

---

## Messages

### MagicMessage

`src/messages/message.ts`

The canonical wire-level message interface.

```typescript
interface MagicMessage {
  id: Uint8Array;            // SHA-256 digest (32 bytes)
  senderPubkey: Uint8Array;  // Ed25519 public key (32 bytes)
  signature: Uint8Array;     // Ed25519 signature (64 bytes)
  tags: string[];            // Routing tags
  payload: Uint8Array;       // Application data (max 256KB)
  timestamp: number;         // Unix milliseconds
  nonce: Uint8Array;         // Random nonce (16 bytes)
  type: MessageType;         // Message classification
  ttl: number;               // Remaining hop count
}
```

### MessageType

```typescript
enum MessageType {
  BROADCAST = 1,           // Standard broadcast
  DIRECT = 2,              // Direct message to a specific peer
  ADVERTISE = 3,           // Service/skill advertisement
  DISCOVER = 4,            // Discovery query
  DISCOVER_RESPONSE = 5,   // Discovery response
}
```

### createMessage

```typescript
async function createMessage(opts: CreateMessageOptions): Promise<MagicMessage>
```

Creates a fully formed, signed message.

```typescript
interface CreateMessageOptions {
  tags: string[];            // At least one tag required
  payload: Uint8Array;       // Max 256KB
  type: MessageType;
  ttl?: number;              // Default: 7
  privateKey: Uint8Array;    // 32-byte Ed25519 private key
  publicKey: Uint8Array;     // 32-byte Ed25519 public key
}
```

Steps performed:
1. Generate 16-byte random nonce
2. Capture current timestamp
3. Compute `id = SHA-256(payload || tags || timestamp || nonce)`
4. Sign the same byte sequence with Ed25519

### serializeMessage

```typescript
function serializeMessage(
  msg: MagicMessage,
  format?: SerializationFormat,  // Default: 'protobuf'
): Uint8Array
```

Serializes a message to binary. The `format` parameter selects the encoding:
- `'protobuf'` (default) -- compact binary via `proto/message.proto`
- `'json'` -- human-readable JSON-hex

**Requires**: `initProto()` must have been called for protobuf format.

### deserializeMessage

```typescript
function deserializeMessage(
  data: Uint8Array,
  format?: SerializationFormat,  // Default: 'protobuf'
): MagicMessage
```

Deserializes bytes back into a `MagicMessage`. The `format` must match the format used during serialization.

**Throws**:
- `Error` if protobuf schema not initialized
- `SyntaxError` if JSON format and data is not valid JSON
- `TypeError` if required fields are missing

### serializeMessageJson

```typescript
function serializeMessageJson(msg: MagicMessage): Uint8Array
```

Serializes a message to UTF-8-encoded JSON with hex-encoded binary fields. Useful for debugging.

### deserializeMessageJson

```typescript
function deserializeMessageJson(data: Uint8Array): MagicMessage
```

Deserializes bytes produced by `serializeMessageJson`.

**Throws**: `SyntaxError`, `TypeError` on malformed input.

### validateMessage

```typescript
function validateMessage(msg: MagicMessage): ValidationResult
```

Validates structural integrity and policy constraints. Does NOT verify the cryptographic signature.

```typescript
interface ValidationResult {
  valid: boolean;
  error?: string;   // Present only when valid is false
}
```

**Checks performed (in order)**:
1. Payload size <= 262,144 bytes (256KB)
2. Tags: non-empty, at most 20, each at most 100 characters
3. TTL > 0
4. Timestamp not more than 5 minutes in the future
5. Nonce exactly 16 bytes
6. Signature exactly 64 bytes

### verifyMessageSignature

```typescript
async function verifyMessageSignature(msg: MagicMessage): Promise<boolean>
```

Verifies the Ed25519 signature on a message by reconstructing the signed byte sequence and verifying against `msg.senderPubkey`.

### initProto

`src/messages/proto.ts`

```typescript
async function initProto(): Promise<void>
```

Loads and caches the protobuf schema from `proto/message.proto`. Must be called once before using protobuf serialization. Idempotent -- safe to call multiple times.

**Throws**: `Error` if the proto file cannot be found or parsed.

### Constants

```typescript
const MAX_PAYLOAD_SIZE = 262144;  // 256KB
```

---

## TagPubSub

`src/pubsub/tag-pubsub.ts`

Tag-based publish/subscribe layer built on GossipSub.

### Static Properties

```typescript
static readonly TOPIC_PREFIX = 'magic/tag/';
static readonly DISCOVERY_TOPIC = 'magic/discovery';
```

### Constructor

```typescript
new TagPubSub(gossipsub: GossipSub)
```

### Methods

#### `subscribe(tag): void`

Subscribe to a tag. The tag is mapped to GossipSub topic `magic/tag/<tag>`.

#### `unsubscribe(tag): void`

Unsubscribe from a tag.

#### `subscribeDiscovery(): void`

Subscribe to the `magic/discovery` topic.

#### `onTag(tag, handler): void`

Register a handler for messages on a specific tag.

```typescript
handler: (data: Uint8Array, tag: string) => void
```

#### `offTag(tag, handler): void`

Remove a tag-specific handler.

#### `onMessage(handler): void`

Register a global handler for all incoming messages regardless of tag.

#### `offMessage(handler): void`

Remove a global handler.

#### `publish(tags, data): Promise<void>`

Publish data to all specified tags (fans out to multiple GossipSub topics in parallel).

| Parameter | Type | Description |
|---|---|---|
| `tags` | `string[]` | Tags to publish to |
| `data` | `Uint8Array` | Serialized message bytes |

#### `publishDiscovery(data): Promise<void>`

Publish to the discovery topic.

#### `handleMessage(topic, data): void`

Dispatch an incoming GossipSub message to registered handlers. Called from the libp2p GossipSub event listener.

#### `getSubscribedTags(): string[]`

Returns all currently subscribed tags.

#### `getTopics(): string[]`

Returns all GossipSub topics this node is subscribed to.

#### `getTagPeerCount(tag): number`

Returns the number of peers subscribed to a specific tag's topic.

---

## Trust

### TrustPolicy

`src/trust/policy.ts`

Deny-first trust policy engine with per-agent and per-tag granularity.

### Methods

#### `allowAgent(pubkeyHex): void`

Whitelist an agent. Has no effect if the agent is also blocked.

#### `blockAgent(pubkeyHex): void`

Block an agent. Overrides any prior or future `allowAgent` call.

#### `allowTag(pubkeyHex, tag): void`

Allow an agent to send messages carrying a specific tag. Removes the tag from the blocked set if present.

#### `blockTag(pubkeyHex, tag): void`

Block an agent from sending messages with a specific tag. Removes the tag from the allowed set if present.

#### `isAllowed(pubkeyHex, tags): boolean`

Determine whether a message from the given sender with the given tags is allowed.

**Evaluation order**:
1. Agent blocked --> `false`
2. Agent not allowed --> `false`
3. No tags supplied and no tag rules --> `true`
4. Any tag blocked --> `false`
5. Tag rules exist and any tag not allowed --> `false`
6. Otherwise --> `true`

#### `getBlockedAgents(): string[]`

Returns all explicitly blocked agent public key hex strings.

#### `getAllowedAgents(): string[]`

Returns all explicitly allowed (and not blocked) agent public key hex strings.

### SpamFilter

`src/trust/policy.ts`

Message deduplication, rate limiting, and spam tracking.

### Constructor

```typescript
new SpamFilter(maxSeenSize?: number)  // Default: 100_000
```

**Throws**: `RangeError` if `maxSeenSize` is not a positive integer.

### Methods

#### `isDuplicate(messageIdHex): boolean`

Check if a message ID has been seen before. If new, records it.

When the seen-set reaches `maxSeenSize`, the oldest 25% of entries are evicted.

**Returns**: `true` if the message is a duplicate.

#### `isRateLimited(pubkeyHex, maxPerMinute): boolean`

Check if a sender exceeds the allowed message rate using a sliding 60-second window.

Records the current timestamp in the sender's window, prunes expired entries, then checks the count.

**Returns**: `true` if the sender is over the limit.

#### `reportSpam(pubkeyHex): void`

Record a spam report against a sender. Counters are cumulative and never reset.

#### `getSpamCount(pubkeyHex): number`

Get the total spam report count for a sender. Returns `0` if never reported.

---

## Ledgers

### LocalLedger

`src/ledger/local-log.ts`

Append-only Merkle hash chain backed by LevelDB.

#### Constructor

```typescript
new LocalLedger(dataDir: string)
```

#### LedgerEntry Interface

```typescript
interface LedgerEntry {
  index: number;           // Sequential position (0-based)
  prevHash: Uint8Array;    // SHA-256 hash of previous entry (empty for genesis)
  hash: Uint8Array;        // SHA-256 hash of this entry
  message: Uint8Array;     // Recorded message bytes
  action: string;          // "sent", "received", "blocked", etc.
  recordedAt: number;      // Unix milliseconds
}
```

#### Methods

##### `open(): Promise<void>`

Opens the LevelDB database and loads the chain tip.

##### `close(): Promise<void>`

Closes the database.

##### `append(message, action): Promise<LedgerEntry>`

Appends a new entry to the chain.

| Parameter | Type | Description |
|---|---|---|
| `message` | `Uint8Array` | Binary payload to record |
| `action` | `string` | Event label (e.g., "sent", "received", "blocked") |

**Returns**: The newly created entry.

##### `getEntry(index): Promise<LedgerEntry | null>`

Retrieve a single entry by its zero-based index.

##### `getLatest(): Promise<LedgerEntry | null>`

Returns the most recently appended entry, or `null` if empty.

##### `verify(): Promise<boolean>`

Walks the entire chain and verifies hash integrity. Returns `true` if intact.

##### `getEntryCount(): Promise<number>`

Returns the total number of entries.

### SharedLedger

`src/ledger/shared-ledger.ts`

Distributed ledger for provable records with peer confirmations.

#### Constructor

```typescript
new SharedLedger(dataDir: string)
```

#### SharedLedgerEntry Interface

```typescript
interface SharedLedgerEntry {
  index: number;                     // Sequential position (1-based)
  prevHash: Uint8Array;              // Hash of previous entry
  hash: Uint8Array;                  // Hash of this entry
  data: Uint8Array;                  // Provable data payload
  submitterPubkey: Uint8Array;       // Submitter's Ed25519 public key
  signature: Uint8Array;             // Submitter's signature over data
  timestamp: number;                 // Submission time (Unix ms)
  confirmations: number;             // Number of peer confirmations
  confirmerPubkeys: Uint8Array[];    // Public keys of confirming peers
}
```

#### Methods

##### `open(): Promise<void>`

Opens the database and loads metadata.

##### `close(): Promise<void>`

Closes the database.

##### `submit(data, submitterPubkey, signature): Promise<SharedLedgerEntry>`

Submit a new provable entry.

| Parameter | Type | Description |
|---|---|---|
| `data` | `Uint8Array` | Data to record |
| `submitterPubkey` | `Uint8Array` | Submitter's 32-byte Ed25519 public key |
| `signature` | `Uint8Array` | Ed25519 signature over `data` |

**Returns**: The created entry (with `confirmations: 0`).

##### `addConfirmation(index, confirmerPubkey): Promise<SharedLedgerEntry | null>`

Add a peer confirmation to an existing entry. Idempotent -- a peer can only confirm once.

| Parameter | Type | Description |
|---|---|---|
| `index` | `number` | Entry index to confirm |
| `confirmerPubkey` | `Uint8Array` | Confirming peer's public key |

**Returns**: The updated entry, or `null` if the entry does not exist.

##### `getEntry(index): Promise<SharedLedgerEntry | null>`

Retrieve an entry by index.

##### `getLatest(): Promise<SharedLedgerEntry | null>`

Returns the latest entry, or `null` if empty.

##### `getEntryCount(): Promise<number>`

Returns the total number of entries.

##### `verify(): Promise<boolean>`

Verifies the entire chain's hash integrity.

##### `getRange(startIndex, endIndex): Promise<SharedLedgerEntry[]>`

Get entries in a range. Used for syncing with peers.

| Parameter | Type | Description |
|---|---|---|
| `startIndex` | `number` | First index to include |
| `endIndex` | `number` | Last index to include (clamped to current max) |

### LedgerSync

`src/ledger/ledger-sync.ts`

Shared ledger synchronization protocol.

**Protocol ID**: `/leyline/ledger-sync/1.0.0`

#### Constructor

```typescript
new LedgerSync(
  libp2p: Libp2p,
  ledger: SharedLedger,
  localPubkey: Uint8Array,
  localPrivkey: Uint8Array,
  opts?: {
    syncIntervalMs?: number;      // Default: 60_000
    events?: LedgerSyncEvents;
  },
)
```

#### LedgerSyncEvents

```typescript
interface LedgerSyncEvents {
  onEntryReceived?: (entry: SharedLedgerEntry) => void;
  onEntryConfirmed?: (index: number, confirmerPubkey: string) => void;
  onSyncComplete?: (peerId: string, entriesReceived: number) => void;
}
```

#### Methods

##### `start(): Promise<void>`

Registers the protocol handler and starts periodic sync.

##### `stop(): Promise<void>`

Stops periodic sync and unregisters the protocol handler.

##### `requestRange(peerId, startIndex, endIndex): Promise<SharedLedgerEntry[]>`

Request ledger entries in a range from a specific peer.

##### `pushEntry(peerId, entry): Promise<void>`

Push an entry to a specific peer for validation and confirmation.

##### `broadcastEntry(entry): Promise<void>`

Push an entry to all connected peers.

##### `syncWithAllPeers(): Promise<void>`

Sync with all connected peers, requesting entries beyond the local count.

---

## PeerExchange

`src/node/peer-exchange.ts`

Peer table synchronization protocol.

**Protocol ID**: `/leyline/peer-exchange/1.0.0`

### PeerRecord Interface

```typescript
interface PeerRecord {
  peerId: string;
  multiaddrs: string[];
  pubkeyHex: string;
  offeredTags: string[];
  lastSeen: number;          // Unix milliseconds
}
```

### Constructor

```typescript
new PeerExchange(
  libp2p: Libp2p,
  opts?: {
    maxPeers?: number;             // Default: 500
    maxPeerAge?: number;           // Default: 30 * 60 * 1000 (30 min)
    exchangeIntervalMs?: number;   // Default: 30_000 (30 sec)
  },
)
```

### Methods

#### `start(): Promise<void>`

Registers the protocol handler and starts periodic peer exchange.

#### `stop(): Promise<void>`

Stops periodic exchange and unregisters the handler.

#### `addPeer(record): void`

Add or update a peer in the local table. Self-records are ignored. If the table exceeds `maxPeers`, the oldest 10% are evicted.

#### `removePeer(peerId): void`

Remove a peer from the table.

#### `getPeers(): PeerRecord[]`

Returns all known peer records.

#### `getPeer(peerId): PeerRecord | undefined`

Get a specific peer record.

#### `getPeerCount(): number`

Returns the number of known peers.

#### `pruneStale(): number`

Remove peer records older than `maxPeerAge`. Returns the number pruned.

#### `exchangeWithPeer(peerId): Promise<PeerRecord[]>`

Initiate a peer exchange with a specific connected peer. Sends local peer records and receives the peer's records.

**Returns**: Peer records received from the remote peer.

---

## Configuration

### MagicConfig

`src/config/config.ts`

```typescript
interface MagicConfig {
  listenPort: number;              // TCP port (default: 9876)
  listenAddresses: string[];       // libp2p multiaddrs
  seedNodes: string[];             // Bootstrap node multiaddrs
  isSeedNode: boolean;             // Seed node mode (default: false)
  dataDir: string;                 // Persistent storage directory
  maxPayloadSize: number;          // Max payload bytes (default: 262144)
  defaultTtl: number;              // Default message TTL (default: 7)
  rateLimitPerMinute: number;      // Rate limit per sender (default: 60)
  maxSeenMessages: number;         // Dedup cache size (default: 100000)
  subscribedTags: string[];        // Tags to subscribe on start
  advertisedTags: string[];        // Tags to advertise
}
```

### DEFAULT_CONFIG

```typescript
const DEFAULT_CONFIG: MagicConfig = {
  listenPort: 9876,
  listenAddresses: ['/ip4/0.0.0.0/tcp/9876'],
  seedNodes: [],
  isSeedNode: false,
  dataDir: './data',
  maxPayloadSize: 262144,
  defaultTtl: 7,
  rateLimitPerMinute: 60,
  maxSeenMessages: 100000,
  subscribedTags: [],
  advertisedTags: [],
};
```

### mergeConfig

```typescript
function mergeConfig(partial: Partial<MagicConfig>): MagicConfig
```

Merges a partial configuration with `DEFAULT_CONFIG`. Uses simple spread semantics (`{ ...DEFAULT_CONFIG, ...partial }`).
