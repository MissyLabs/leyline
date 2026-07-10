# Leyline — Fixes & Feature Backlog

Scan date: 2026-07-02. Target: `src/` at branch `main` (v0.2.0 code, package says v0.2.0 / CLAUDE.md says v0.2.0, README/COMPLETE reference v0.3).
This document is written for an implementer (Opus) to action directly. Each item lists the concrete file/line,
the problem, why it matters, and a recommended fix. Severity: **P0** (correctness/security, fix first),
**P1** (should fix), **P2** (polish / hardening).

Ordering inside each section is by severity.

---

## 1. Security Issues

### SEC-1 (P0) — Fork resolution adopts an unverified peer chain with attacker-fabricated confirmations
**File:** `src/ledger/fork-resolver.ts:118-155`, reached from `src/ledger/ledger-sync.ts:353-364` (`syncWithPeer` → `forkResolver.resolve`).

`ForkResolver.resolve()` decides the winning chain by comparing `totalConfirmations()`
(`fork-resolver.ts:209-215`), which simply sums `entry.confirmations` — a value taken verbatim from the
peer's serialized entry. When the peer "wins", the code rolls back the local chain and replays the peer's
suffix **without verifying anything**:

```ts
await this.ledger.rollbackTo(fork.divergenceIndex - 1);
for (const entry of peerSuffix) {
  await this.ledger.submit(entry.data, entry.submitterPubkey, entry.signature); // no signature check
  for (const confirmer of entry.confirmerPubkeys) {
    await this.ledger.addConfirmation(entry.index, confirmer);                  // confirmer not verified
  }
}
```

- `validateReceivedEntry()` (submitter-signature check) is **not** called here — only `validatePeerChainContinuity()`,
  which checks index/prevHash linkage but not signatures.
- `confirmerPubkeys` / `confirmations` are never proven; a peer can claim any number of confirmations.

**Impact:** Any *untrusted* connected peer (sync runs against every peer, `syncWithAllPeers`) can serve a
fabricated chain with an inflated confirmation count and rewrite up to `maxReorgDepth` (50) entries of the
shared ledger on every honest node. This defeats the ledger's provability guarantee.

**Fix:**
1. In `resolve()`, before adopting `peerSuffix`, call `validateReceivedEntry()` on every entry and reject the
   reorg if any signature fails.
2. Count only *cryptographically verified* confirmations: each confirmer in `confirmerPubkeys` must be backed
   by a signature over `confirm:{entryHash}` (the same scheme `ledger-sync.ts` already uses on the wire). Entries
   should carry those signatures, or confirmations should be re-validated on receipt rather than trusted as a bare count.
3. Recompute and verify each entry's `hash` locally rather than trusting the serialized `hash`.

### SEC-2 (P0) — Direct messages bypass the global inbound cap and per-sender payload budget
**File:** `src/node/direct-message.ts:511-611` (`handleIncoming` → `opts.onMessage`) vs `src/node/magic-node.ts:1185-1226`.

The token-burn defenses (`maxInboundPerMinute`, `maxPayloadBytesPerMinute`) live in
`MagicNode.handleIncomingMessage`. The DM receive path calls `this.opts.onMessage(envelope)` directly and only
runs `trustChecker` (agent allow + dedup + per-sender `rateLimitPerMinute` + spam report). It never consults the
global inbound cap or the per-sender byte budget, and there is no queued/sequential handler equivalent to
`onTagQueued` for DMs.

**Impact:** For the stated use case ("AI agents that call LLM APIs per message"), an allowed peer — or anyone,
if a tag is open and the agent is thereby trusted — can drive unbounded concurrent `onDirectMessage` invocations
via `/leyline/direct/1.0.0`, defeating the primary cost-control mechanism. DM payloads (up to 256 KB each) also
escape `maxPayloadBytesPerMinute`.

**Fix:** Route DM delivery through the same global inbound counter and payload-byte budget used by
`handleIncomingMessage`. Expose an `onDirectMessageQueued` (sequential, bounded queue, drop-oldest) analogous to
`onTagQueued`. Consider a shared `InboundBudget` object injected into both paths (see FEAT-2).

### SEC-3 (P0) — Shared ledger accepts entries from any identity; quorum is trivially met
**File:** `src/ledger/ledger-sync.ts:550-583` (`push-entry` handler), `src/ledger/consensus.ts` (quorum=2 default).

`validateReceivedEntry` only checks that the submitter signed their own `data` — there is no authorization on
*who* may submit. On `push-entry` the receiver adds both the submitter's and its own confirmation
(`[submitterHex, self.localPubkeyHex]`), so with `quorumSize = 2` a single node + the submitter finalizes an entry.
There is no Byzantine tolerance and no allow-list, so any peer can pollute the provable ledger with arbitrary
signed records that then propagate network-wide.

**Impact:** Ledger spam / unbounded growth, and no meaningful "consensus" — one cooperating seed is sufficient.

**Fix:** Add a submitter authorization hook (allow-list of pubkeys, or a signed capability/trust-level gate reusing
`TrustPolicy`) before `propose`/commit. Require confirmations from *distinct* seed identities and make quorum a
function of seed-set size, not a fixed 2. Cap ledger growth per submitter per window (a rate limit exists on seeds
at `seed-node.ts:474`, but not on the sync/ingest path).

### SEC-4 (P1) — Health-check / metrics HTTP server is unauthenticated and binds 0.0.0.0
**File:** `src/node/health-check.ts:51-58, 101-116`.

The server listens on `0.0.0.0` and serves `/metrics` and `/metrics/prometheus` (internal counters, peer counts,
buffered-message counts, ledger size) plus `/health` with version and peer info, with no auth or bind-address
restriction. On a public seed this leaks operational topology to anyone.

**Fix:** Add an optional bind address (default `127.0.0.1`) and an optional bearer-token/allow-CIDR guard for
`/metrics*`. Keep `/health` minimal. Document the exposure.

### SEC-5 (P1) — Discovery wire messages are not size/shape-validated before processing
**File:** `src/discovery/discovery-protocol.ts:82-88` (`decodeMsg` only checks `kind`).

`AUDIT_SECURITY.md` marks M1 as "FIXED — field size limits added," but `decodeMsg` validates only `parsed.kind`.
Advertised `descriptor` objects are passed to `verifyDescriptor` (which does gate on signature) but query objects
and descriptor string fields are otherwise unbounded until later caps. This is a claimed-fixed-but-regressed item —
verify against the audit and re-add field caps (name/description/tag lengths, array sizes) at decode time.

### SEC-6 (P2) — Receipt reflection & topic-mirror starvation
- `src/node/direct-message.ts:614-648`: a signed message with `receiptToken` makes the node emit a receipt to
  `envelope.senderPeerId`. Delivery is limited to actually-connected peers, but combined with no per-sender DM
  cap (SEC-2) this is an amplification vector. Rate-limit receipt emission.
- `src/node/seed-node.ts:341-349`: a peer can announce up to 500 junk topics and exhaust the mirror cap, starving
  legitimate topics. Track mirrored topics per-peer and cap per-peer, and prefer topics with active subscribers.

---

## 2. Data-Consistency Issues

### DC-1 (P1) — Seed-connectivity tracking is broken for DNS seed multiaddrs
**File:** `src/node/magic-node.ts:303-315` (`peerConnectHandler`), consumed by `getConnectedSeedCount` (1050-1059)
and `checkSeedConnectivity` (1061-1096).

Seed PeerIds are learned by matching the live `remoteAddr` against `seed.split('/p2p/')[0]`. For the default seeds
that prefix is `/dns4/node1.missylabs.com/tcp/9876`, but an established outbound connection's `remoteAddr` is the
resolved `/ip4/…/tcp/9876`. `remoteAddr.includes('/dns4/…')` is therefore always false, so `seedPeerIds` never
populates for DNS seeds. Consequences:
- `getConnectedSeedCount()` returns 0 even when connected to all seeds.
- `onSeedConnectivityChange` and `NodeStatus.connectedSeeds` misreport 0/N.
- `getNodeStatus.totalSeeds` still works (falls back to `seedNodes.length`), so the UI shows "0 of 4".

(Note: `redialDisconnectedSeeds` extracts the PeerId from the *configured* multiaddr via regex, so re-dial itself
still works — only the reporting/degraded logic is affected.)

**Fix:** Match on the extracted PeerId (`/p2p/<id>` suffix of the configured seed) against `conn.remotePeer`,
not on the host substring. That is DNS/IP-agnostic and already available from the connection object.

### DC-2 (P1) — `getNodeStatus().uptime` is hardcoded to 0
**File:** `src/node/magic-node.ts:1037` (and interface field `76`).

There is no `startedAt` recorded; both the sync and async status return `uptime: 0`. `ledgerEntries` is likewise 0
in the sync path and only filled by `getNodeStatusAsync`.

**Fix:** Record `this.startedAt = Date.now()` at the end of `start()` and compute
`uptime: this.startedAt ? Date.now() - this.startedAt : 0`.

### DC-3 (P2) — Same-content ledger submissions are silently deduplicated
**File:** `src/ledger/consensus.ts:117-127, 287-292` (`findByContent` keyed on data+submitter).

A submitter that legitimately records the identical payload twice (e.g. two identical "heartbeat" facts) has the
second collapsed into the first proposal and never committed as a distinct entry. If duplicate factual records are
a valid use case, the content hash must include the entry timestamp/nonce; if not, document that submissions must
be unique per submitter.

### DC-4 (P2) — Degraded detection keys on total peers, not seed reachability
**File:** `src/node/magic-node.ts:1081-1090`.

`degraded` flips only when `totalPeers === 0`. A node connected to non-seed peers but zero seeds (no relay/inbox/
ledger path) is not flagged degraded. Base the degraded signal on `connectedSeeds` (once DC-1 is fixed) or on the
presence of at least one inbox-capable peer.

---

## 3. Scheduling Gaps

### SCH-1 (P0) — Seed nodes never re-dial each other after a disconnect (no seed-mesh self-healing)
**File:** `src/node/magic-node.ts:493-497`.

The seed-monitor timer that drives `checkSeedConnectivity` → `redialDisconnectedSeeds` is created only when
`!this.config.isSeedNode`. libp2p `bootstrap` dials only at startup, so once two seeds drop a connection (network
blip, idle timeout, restart) nothing reconnects them. The seed mesh can permanently partition, which breaks topic
mirroring, ledger propagation, and store-and-forward for the whole network. (Commit 8197f33 added periodic re-dial,
but excluded seeds — the very nodes that most need it.)

**Fix:** Run the seed-connectivity monitor + `redialDisconnectedSeeds` on seed nodes too (they already have
`seedNodes` populated with the *other* seeds). Guard against self-dial (already handled by libp2p, but skip the
node's own PeerId explicitly).

### SCH-2 (P1) — Inbox polling dials every connected peer every 30s
**File:** `src/node/magic-node.ts:468-489` → `InboxClient.fetchFromAllPeers` (`inbox-protocol.ts:314-332`, sequential).

`fetchFromAllPeers` loops over *all* connected peers (up to `maxConnections`, default 100), opening an inbox stream
to each, every 30 seconds, even to peers that don't implement the inbox protocol. On a well-connected node this is
up to ~100 dials/30s of mostly-wasted work, and it is sequential (slow).

**Fix:** Restrict inbox polling to known seed PeerIds (once DC-1 populates them correctly). Run the fetches with
bounded concurrency, and back off peers that returned "protocol not supported."

### SCH-3 (P2) — No jitter on fixed-interval timers can synchronize the fleet
**Files:** `magic-node.ts:447` (re-advertise, 4 min), `:469` (inbox poll, 30 s), `:494` (seed monitor, 60 s);
`ledger-sync.ts:189` (sync, 60 s); `seed-node.ts:300` (peer exchange, 30 s).

Only `PeerExchange.scheduleNextExchange` adds jitter (`peer-exchange.ts:175-187`). The other periodic tasks fire on
exact boundaries, so many nodes that started together (e.g. after a coordinated redeploy) will hit the seeds in
lockstep — a thundering herd against the seed inbox/sync endpoints.

**Fix:** Add ±10-20% jitter to the interval schedulers, or a small random start offset.

---

## 4. Rate-Limit Risks (external API / resource exhaustion)

### RL-1 (P0) — DM path has no global cost cap
Covered by **SEC-2**. This is the single biggest token-burn hole: the whole `maxInboundPerMinute` /
`maxPayloadBytesPerMinute` regime is bypassed for direct messages, which is exactly the path a targeted attacker
would use to run up an AI agent's LLM bill.

### RL-2 (P1) — `fetchFromAllPeers` amplifies inbound message volume without a fetch budget
**File:** `src/node/inbox-protocol.ts:250-308, 314-332`.

Each inbox fetch can return up to 500 messages *per peer*; polling N peers can inject up to `500 × N` messages per
cycle into `handleIncomingMessage`. Those are rate-limited on the *inbound* side (good), but the dedup/validation
work still runs for all of them. There is no cap on total messages ingested per poll cycle.

**Fix:** Cap total messages accepted per poll cycle (e.g. `maxInboundPerMinute`), and stop early once the global
inbound window is full rather than fetching-then-dropping.

### RL-3 (P1) — Ledger `getEntryCount` probe does an O(log 100000) request storm per fork check
**File:** `src/ledger/ledger-sync.ts:404-419` (`makePeerQuerier.getEntryCount`).

The binary probe issues up to ~17 sequential `requestRange(peer, mid, mid)` round-trips *per peer* to estimate
chain length, and `syncWithPeer` runs on every peer every 60s (plus additional `getEntryHash` calls inside the
fork binary search). Against 100 peers that is thousands of protocol round-trips per minute.

**Fix:** Have `range-response` already carry `totalEntries` (it does — `ledger-sync.ts:544`); use that instead of a
binary probe. Cache peer chain length between cycles.

### RL-4 (P2) — Discovery/ledger/peer-exchange stream handlers have no per-connection concurrency cap
Multiple protocol handlers (`dialProtocol` openers) will happily open unlimited concurrent streams. Add a per-peer
in-flight stream cap to bound memory during churn/abuse.

---

## 5. Implementation Gaps / Bugs

### IMP-1 (P1) — `SharedLedger.query` and `verify` are full O(n) scans with no index or pagination
**File:** `src/ledger/shared-ledger.ts:254-276, 301-328`.

Every `query()` walks entries `1..currentIndex` deserializing each from LevelDB; `verify()` does the same. As the
ledger grows this becomes the dominant cost of the ledger-query feature and of periodic integrity checks. There is
no submitter index and no cursor/pagination on `query` (only a `limit`).

**Fix:** Maintain a secondary index (submitter → indices, and a time-bucket index) written alongside each entry;
add cursor-based pagination. See FEAT-1.

### IMP-2 (P2) — Version mismatch between package/CLAUDE.md (0.2.0) and README/COMPLETE (0.3)
`package.json` and `CLAUDE.md` say v0.2.0; recent commit `4c218d6` ("v0.3 features") and status docs describe v0.3.
Confirm `src/config/compat.ts` `LEYLINE_VERSION` and the `COMPAT` matrix reflect the shipped feature set, and bump
consistently. A wrong `minVersion` will reject compatible peers at handshake.

### IMP-3 (P2) — Untracked scratch/verify files and logs in the working tree
`git status` shows untracked `.embedded_prompt.txt`, `build_log.txt`, `test/_debug.ts`,
`scripts/verify-*.ts`, and `test/crypto-envelope-edge-cases.test.ts`. Decide per file: add to the repo, add to
`.gitignore`, or delete. `.embedded_prompt.txt` and `build_log.txt` in particular look like stray artifacts —
review before committing so nothing sensitive lands in history.

### IMP-4 (P2) — `announceFilter` uses substring matching that can over/under-filter
**File:** `src/node/magic-node.ts:210-218`.

`str.includes('/ip4/172.')` filters the entire `172.0.0.0/8`, not just the private `172.16.0.0/12`; it also filters
any multiaddr that merely *contains* those substrings elsewhere. Parse the IP and test the real private ranges
(10/8, 172.16/12, 192.168/16, and consider 100.64/10 CGNAT, fc00::/7).

---

## 6. New Features (requested)

### FEAT-1 — Indexed, paginated, provable ledger query API
**Motivation:** The ledger is the product's differentiator, but `query()` is an O(n) full scan (IMP-1) and there is
no way to page results or prove inclusion to a third party.

**Scope:**
- Secondary indices in LevelDB written transactionally with each entry: `idx:submitter:<pubkey>:<index>` and
  `idx:ts:<bucket>:<index>`.
- Cursor-based pagination on `SharedLedger.query` (`{ after?: number, limit }`) returning a `nextCursor`.
- A Merkle inclusion proof: `getProof(index)` returning the hash path to the latest hash so an external verifier can
  confirm an entry is in the chain without downloading it all. Expose via a new `/leyline/ledger-sync` message kind
  and (optionally) the health server.
- Tests: index consistency after `rollbackTo`, pagination boundaries, proof verification against a tampered entry.

### FEAT-2 — Unified inbound cost governor (`InboundBudget`) across broadcast + DM + inbox
**Motivation:** Directly fixes SEC-2 / RL-1 and centralizes token-burn protection, which is the headline value prop
for AI-agent operators.

**Scope:**
- Extract the global per-minute count and per-sender byte budget from `MagicNode.handleIncomingMessage` into an
  injectable `InboundBudget` class.
- Apply it in the DM receive path and inbox ingest path as well as GossipSub.
- Add `onDirectMessageQueued(handler, maxQueueSize)` mirroring `onTagQueued` (sequential, drop-oldest) so LLM calls
  triggered by DMs are serialized.
- Emit a metric/event when the budget sheds load (`budget.shed`) so operators can alarm on it.
- Config: `maxInboundPerMinute` and `maxPayloadBytesPerMinute` should govern *all* delivery paths, documented as such.
- Tests: DM flood is capped; oversized DM payloads are budgeted; queued DM handler never runs concurrently.

### FEAT-3 (stretch) — Seed-mesh & network health dashboard
Build on the existing health server: an authenticated `/dashboard` (server-rendered, no external assets) showing
per-seed reachability (fixed via DC-1), mirrored-topic counts, buffered-message counts, ledger height, version
distribution, and recent degraded/partition events. Pairs naturally with SCH-1 so operators can *see* a seed-mesh
partition heal.

---

## Suggested implementation order
1. **SEC-1, SEC-2/RL-1, SEC-3** (ledger reorg trust, DM cost cap, ledger authz) — these are exploitable today.
2. **SCH-1** (seed self-heal) and **DC-1** (seed reporting) — network-liveness correctness, and DC-1 unblocks
   SCH-2/RL-2 and FEAT-3.
3. **RL-2, RL-3** (inbox/sync amplification), **DC-2** (uptime).
4. **SEC-4/5/6, SCH-3, IMP-1..4**.
5. **FEAT-1, FEAT-2**, then **FEAT-3**.

Each fix should ship with a regression test in `test/` matching the existing naming (`*-adversarial`, `*-edge-cases`,
`*-regression`), and update `AUDIT_SECURITY.md` / `LOOP_HEALTH.md` as the prior sessions did.
