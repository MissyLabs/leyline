# Test Results — Leyline v0.2.0

**Date:** 2026-04-15  
**Branch:** loop_fix_04_15_2026  
**Total Tests:** 605 passing (0 failures)  
**Baseline:** 258 tests (pre-loop)  
**Test Files:** 42

## Test Coverage by Subsystem

| Subsystem | Test File | Tests | Status |
|-----------|-----------|-------|--------|
| Identity/Keypair | identity.test.ts | ~10 | Pass |
| Messages | message.test.ts | ~15 | Pass |
| Message Edge Cases | message-edge-cases.test.ts | 9 | Pass |
| Compression | compression.test.ts | 8 | Pass |
| Trust Policy | trust.test.ts | ~20 | Pass |
| Trust Adversarial | trust-adversarial.test.ts | 8 | Pass |
| Persistent Trust | persistent-trust.test.ts | ~10 | Pass |
| Spam Filter | trust.test.ts + security-regression | ~15 | Pass |
| Spam Filter Bounds | spam-filter-bounds.test.ts | 6 | Pass |
| Peer Reputation | peer-reputation.test.ts | 20 | Pass |
| Reputation Integration | reputation-integration.test.ts | 11 | Pass |
| Stream Timeout | stream-timeout.test.ts | ~8 | Pass |
| Input Validation | input-validation.test.ts | ~12 | Pass |
| Config | config.test.ts | 8 | Pass |
| Compat (semver) | compat.test.ts | 15 | Pass |
| TagPubSub | tag-pubsub.test.ts | 20 | Pass |
| MagicNode Pipeline | magic-node-pipeline.test.ts | 11 | Pass |
| MagicNode Queued | magic-node-queued.test.ts | 2 | Pass |
| Consensus | consensus.test.ts | ~15 | Pass |
| Consensus Adversarial | consensus-adversarial.test.ts | 7 | Pass |
| Consensus Validation | consensus-validation.test.ts | ~10 | Pass |
| Ledger Sync | ledger-sync.test.ts | ~10 | Pass |
| Ledger Regression | ledger-regression.test.ts | 70 | Pass |
| Ledger Confirmation Security | ledger-confirmation-security.test.ts | 8 | Pass |
| Service Registry | service-registry.test.ts | ~20 | Pass |
| Persistent Registry | persistent-registry.test.ts | 18 | Pass |
| Discovery Protocol | discovery-protocol.test.ts | ~15 | Pass |
| Discovery Rate Limit | discovery-ratelimit.test.ts | ~10 | Pass |
| Discovery Regression | discovery-regression.test.ts | 54 | Pass |
| Rate Limiting Edge Cases | rate-limiting-edge-cases.test.ts | 6 | Pass |
| Direct Message | direct-message.test.ts | ~15 | Pass |
| DM Relay | dm-relay.test.ts | 8 | Pass |
| Crypto Envelope | crypto-envelope.test.ts | ~10 | Pass |
| Handshake Edge Cases | handshake-edge-cases.test.ts | 11 | Pass |
| Peer Exchange | peer-exchange.test.ts | 21 | Pass |
| Peer Exchange Validation | peer-exchange-validation.test.ts | 13 | Pass |
| Inbox Protocol | inbox-protocol.test.ts | 20 | Pass |
| Integration | integration.test.ts | 8 | Pass |
| Security Regression | security-regression.test.ts | 46 | Pass |
| Adversarial Peer | adversarial-peer.test.ts | 14 | Pass |
| Cross-Subsystem | cross-subsystem.test.ts | 16 | Pass |
| Health Check | health-check.test.ts | 6 | Pass |
| Deep Edge Cases | deep-edge-cases.test.ts | 11 | Pass |

## Tests Added — Session 5

- **persistent-registry.test.ts**: 18 tests — LevelDB persistence, restart survival, TTL pruning on open, corrupted record handling, update persistence
- **dm-relay.test.ts**: 8 tests — 3-node relay delivery, signature preservation, unsigned envelope rejection, loop prevention, hop exhaustion, direct fallback
- **adversarial-peer.test.ts**: 14 tests — Malicious wire messages to DM (7), handshake (3), discovery (4) protocol handlers
- **cross-subsystem.test.ts**: 16 tests — Reputation+trust+spam pipeline (8), registry+trust filtering (2), consensus mechanics (4), buffer+dedup (2)

## Tests Added — Session 4

- **reputation-integration.test.ts**: 11 tests — MagicNode reputation signals (success, spam, violation, cleanup) + PeerExchange weighted selection
- **deep-edge-cases.test.ts**: 11 tests — PersistentTrustPolicy persistence (5), PersistentSpamFilter persistence (3), SeedNode lifecycle (3)

## Tests Added — Session 3

- **tag-pubsub.test.ts**: 20 tests — subscribe/unsubscribe, handler dispatch, clear, global handlers
- **config.test.ts**: 8 tests — mergeConfig port rebuild, WS toggle, seed logic
- **compat.test.ts**: 15 tests — semver comparisons, boundary values, malformed strings
- **spam-filter-bounds.test.ts**: 6 tests — LRU eviction at cap, dedup, rate limit eviction
- **magic-node-pipeline.test.ts**: 11 tests — handleIncomingMessage full pipeline
- **magic-node-queued.test.ts**: 2 tests — onTagQueued sequential processing, queue overflow
- **peer-reputation.test.ts**: 20 tests — scoring, decay, bounds, eviction, ranking
- **consensus-adversarial.test.ts**: 7 tests — quorum bypass, flooding, rejection resilience
- **trust-adversarial.test.ts**: 8 tests — deny-first, block override, open tag semantics
- **handshake-edge-cases.test.ts**: 11 tests — unit methods, two-node handshake
- **peer-exchange-validation.test.ts**: 13 tests — isValidRecord boundary conditions

## Tests Added — Session 2

- **ledger-confirmation-security.test.ts**: 8 tests for C1/C2 fixes
- **compression.test.ts**: 8 tests for message compression
- **message-edge-cases.test.ts**: 9 tests for message validation edge cases
- **rate-limiting-edge-cases.test.ts**: 6 tests for rate limiting boundaries
- **inbox-protocol.test.ts**: +1 test for H3 topic authorization fix

## Tests Added — Session 1

- **security-regression.test.ts**: Fixed 8 broken tests, added 24 new regression tests
- **health-check.test.ts**: 6 tests for HTTP health endpoint
- **peer-exchange.test.ts**: 21 tests for peer exchange protocol
- **inbox-protocol.test.ts**: 19 tests for store-and-forward
