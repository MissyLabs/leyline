# Security Audit — Leyline v0.2.0

**Date:** 2026-04-15  
**Branch:** loop_fix_04_15_2026  
**Last updated:** Session 7  
**Tests at last update:** 750 passing

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

## Summary

| Severity | Total | Fixed | Open |
|----------|-------|-------|------|
| CRITICAL | 2 | 2 | 0 |
| HIGH | 5 | 5 | 0 |
| MEDIUM | 10 | 9 | 1 (mitigated) |
| LOW | 6 | 5 | 1 (acceptable) |

**All critical and high severity findings have been resolved.**
