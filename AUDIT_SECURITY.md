# Security Audit — Leyline v0.3.0

**Date:** 2026-04-15  
**Branch:** loop_fix_04_15_2026  
**Last updated:** Session 8 (2026-07-10)
**Tests at last update:** 1107 passing

## CRITICAL

### C1. Ledger confirmation spoofing — no signature verification on confirmations
**File:** `src/ledger/ledger-sync.ts`  
**Status:** FIXED (session 2) — Confirmation messages now require Ed25519 signature over `confirm:{entryHash}`. Handler verifies signature before accepting, validates entryHash matches the ledger entry at the claimed index.

### C2. Seed nodes auto-confirm ALL pending proposals
**File:** `src/node/seed-node.ts`  
**Status:** FIXED (session 2) — Seeds now verify submitter signature before auto-confirming. Per-submitter rate limiting (10 entries/minute) prevents flood attacks. Invalid signatures cause proposal rejection via `consensus.reject()`.

## HIGH

### H1. DM envelope dedup ID is predictable — no payload hash
**File:** `src/node/direct-message.ts`  
**Status:** FIXED — payload hash now included in dedup ID

### H2. No payload size limit on DM envelopes
**File:** `src/node/direct-message.ts`  
**Status:** FIXED — 256KB limit enforced in decodeEnvelope

### H3. Inbox topic authorization bypass via bufferedTopics
**File:** `src/node/inbox-protocol.ts`  
**Status:** FIXED (session 2) — Removed `bufferedTopics` fallback. Only serves topics the peer is actually subscribed to (via GossipSub state + subscription tracker).

### H4. Incompatible peers not disconnected after handshake
**File:** `src/node/handshake-protocol.ts`  
**Status:** FIXED — `disconnectPeer()` called on incompatible version detection.

### H5. Relay envelopes forwarded without signature verification
**File:** `src/node/direct-message.ts`  
**Status:** FIXED — Relay envelopes verified with `edVerify()` before forwarding.

## MEDIUM

### M1. Discovery `decodeMsg` — no field validation beyond `kind`
**File:** `src/discovery/discovery-protocol.ts`  
**Status:** FIXED — field size limits added

### M2. Handshake `decode` — no field validation beyond `type`
**File:** `src/node/handshake-protocol.ts`  
**Status:** FIXED — version/minVersion capped at 32 chars, message at 256 chars.

### M3. `inboundTimestamps` uses O(n) shift-based pruning
**File:** `src/node/magic-node.ts`  
**Status:** FIXED — binary search + slice replaces O(n) shift operations.

### M4. `peerVersions` and `incompatiblePeers` grow without bound
**File:** `src/node/handshake-protocol.ts`  
**Status:** FIXED — `pruneDisconnected()` removes entries for disconnected peers.

### M5. `deliverDirect` does not close stream after writing
**File:** `src/node/direct-message.ts`  
**Status:** FIXED — `stream.close()` in finally block.

### M6. `PeerExchange.addPeer` is public, bypasses signature verification
**File:** `src/node/peer-exchange.ts`  
**Status:** MITIGATED — External peer data routed through `addPeerVerified()`. Public `addPeer()` has validation and is only called internally + tests.

### M7. `SharedLedger.getRange` has no internal cap
**File:** `src/ledger/shared-ledger.ts`  
**Status:** LOW RISK — LedgerSync handler caps range requests at 100 entries.

### M8. Unhandled promise rejections in MagicNode message handling
**File:** `src/node/magic-node.ts`  
**Status:** FIXED (session 4) — All three `handleIncomingMessage` call sites now have `.catch()` handlers.

### M9. SeedNode stop() does not unsubscribe mirrored topics
**File:** `src/node/seed-node.ts`  
**Status:** FIXED (session 4) — Mirrored topics unsubscribed, rate limit map cleared.

### M10. MagicNode stop() does not clear rate limit state
**File:** `src/node/magic-node.ts`  
**Status:** FIXED (session 4) — `payloadBudgets` and `inboundTimestamps` cleared in `stop()`.

## LOW

### L1. `Math.random()` for peer shuffling — not crypto-secure
**Files:** `src/node/peer-exchange.ts`  
**Status:** Acceptable risk for non-security shuffling

### L2. CLI intervals never cleared
**File:** `src/cli.ts`  
**Status:** FIXED — intervals cleared in shutdown handler.

### L3. SeedNode `knownPeers` unbounded
**File:** `src/node/seed-node.ts`  
**Status:** FIXED — LRU eviction at 10,000 peers.

### L4. TagPubSub handlers not cleared on destroy
**File:** `src/pubsub/tag-pubsub.ts`  
**Status:** FIXED — clear() method added.

## Session 7 Findings

### L5. LocalLedger.append() lacks serialization lock — concurrent race condition
**File:** `src/ledger/local-log.ts`  
**Status:** FIXED (session 7) — Added `appendLock` with the same pattern as SharedLedger's `submitLock`.

### L6. Silent catch blocks in handshake hangUp and multiaddr import
**Files:** `src/node/handshake-protocol.ts`, `src/node/magic-node.ts`  
**Status:** FIXED (session 7) — Added `console.warn` with error details.

## Session 8 Findings — Backlog Hardening (2026-07-10)

Full backlog (`fixes.md`) actioned: 6 security, 4 data-consistency, 3 scheduling,
4 rate-limit, 4 implementation-gap items, and 3 features.

### SEC-1 (P0). Fork resolution adopted an unverified peer chain with fabricated confirmations
**File:** `src/ledger/fork-resolver.ts`
**Status:** FIXED — Before adopting a peer suffix the resolver now (a) recomputes every
entry's hash locally (`computeEntryHash`) and rejects a mismatch, (b) verifies each
submitter signature over `data`, and (c) counts **only** confirmations backed by an
Ed25519 signature over `confirm:{hash}`. Bare `confirmations` counts no longer drive a
reorg. Confirmer signatures are now persisted on the entry (`confirmerSignatures`) and
replayed only after verification. Regression: `test/fork-resolver-sec1.test.ts`.

### SEC-2 / RL-1 (P0). Direct messages bypassed the global inbound cap and payload budget
**Files:** `src/node/magic-node.ts`, `src/utils/inbound-budget.ts`
**Status:** FIXED — Extracted the global per-minute cap + per-sender payload budget into a
shared `InboundBudget` (FEAT-2) injected into the GossipSub, direct-message, and inbox
paths. DM delivery now routes through `deliverDirectMessage()` which applies the budget
before any handler fires. Added `onDirectMessageQueued()` (sequential, drop-oldest) so
LLM calls triggered by DMs are serialized. Metric `budget.shed{reason}` emitted on
shedding. Regression: `test/inbound-budget.test.ts`, `test/dm-budget.test.ts`.

### SEC-3 (P0). Shared ledger accepted entries from any identity; quorum trivially met
**Files:** `src/ledger/ledger-sync.ts`, `src/config/config.ts`
**Status:** FIXED — `LedgerSync` gained an optional submitter authorization gate
(`ledgerSubmitterAllowlist`) and a per-submitter ingest rate limit
(`ledgerMaxIngestPerMinute`, default 30) applied on both the `push-entry` and range-sync
ingest paths (previously unbounded). Confirmations are already keyed by distinct pubkeys.

### SEC-4 (P1). Health/metrics HTTP server unauthenticated on 0.0.0.0
**File:** `src/node/health-check.ts`
**Status:** FIXED — Server binds `127.0.0.1` by default (`healthCheckBind`), and
`/metrics` + `/metrics/prometheus` require a bearer token when `healthCheckAuthToken` is
set. `/health` stays minimal/open. Warns when bound publicly without a token.
Regression: `test/health-auth.test.ts`.

### SEC-5 (P1). Discovery wire messages not size/shape-validated (M1 regression)
**File:** `src/discovery/discovery-protocol.ts`
**Status:** FIXED (re-added) — `decodeMsg` now caps string/array/metadata sizes on query,
advertisement, and result descriptors at decode time (name/desc ≤512, tags ≤50, etc.).

### SEC-6 (P2). Receipt reflection amplification & topic-mirror starvation
**Files:** `src/node/direct-message.ts`, `src/node/seed-node.ts`
**Status:** FIXED — Receipt emission is rate-limited per requesting peer (30/min). Seeds
cap mirrored topics per-peer (50) so one peer can't exhaust the global 500-topic cap.

### RL-4 (P2). Unbounded per-connection stream concurrency
**Files:** discovery, ledger-sync, inbox, direct-message, peer-exchange
**Status:** FIXED — Each inbound protocol handler gates on a `StreamGate` (32 in-flight
streams per peer). Regression: `test/stream-gate.test.ts`.

### M1 (revisited). Discovery field validation
**Status:** FIXED again under SEC-5 — the earlier "field size limits added" had regressed to
`kind`-only validation.

## Summary

| Severity | Total | Fixed | Open |
|----------|-------|-------|------|
| CRITICAL | 2 | 2 | 0 |
| HIGH | 5 | 5 | 0 |
| MEDIUM | 10 | 9 | 1 (mitigated) |
| LOW | 6 | 5 | 1 (acceptable) |
| Session 8 backlog (SEC-1..6, RL-4) | 7 | 7 | 0 |

**All critical and high severity findings have been resolved.**
