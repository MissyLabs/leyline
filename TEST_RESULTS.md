# Test Results — Leyline v0.2.0

**Date:** 2026-04-15  
**Branch:** loop_fix_04_15_2026  
**Total Tests:** 400 passing (0 failures)  
**Baseline:** 258 tests (pre-loop)

## Test Coverage by Subsystem

| Subsystem | Test File | Tests | Status |
|-----------|-----------|-------|--------|
| Identity/Keypair | identity.test.ts | ~10 | Pass |
| Messages | message.test.ts | ~15 | Pass |
| Message Edge Cases | message-edge-cases.test.ts | 9 | Pass |
| Compression | compression.test.ts | 8 | Pass |
| Trust Policy | trust.test.ts | ~20 | Pass |
| Persistent Trust | persistent-trust.test.ts | ~10 | Pass |
| Spam Filter | trust.test.ts + security-regression | ~15 | Pass |
| Stream Timeout | stream-timeout.test.ts | ~8 | Pass |
| Input Validation | input-validation.test.ts | ~12 | Pass |
| Consensus | consensus.test.ts | ~15 | Pass |
| Consensus Validation | consensus-validation.test.ts | ~10 | Pass |
| Ledger Sync | ledger-sync.test.ts | ~10 | Pass |
| Ledger Regression | ledger-regression.test.ts | 70 | Pass |
| Ledger Confirmation Security | ledger-confirmation-security.test.ts | 8 | Pass |
| Service Registry | service-registry.test.ts | ~20 | Pass |
| Discovery Protocol | discovery-protocol.test.ts | ~15 | Pass |
| Discovery Rate Limit | discovery-ratelimit.test.ts | ~10 | Pass |
| Discovery Regression | discovery-regression.test.ts | 54 | Pass |
| Rate Limiting Edge Cases | rate-limiting-edge-cases.test.ts | 6 | Pass |
| Direct Message | direct-message.test.ts | ~15 | Pass |
| Crypto Envelope | crypto-envelope.test.ts | ~10 | Pass |
| Integration | integration.test.ts | 8 | Pass |
| Security Regression | security-regression.test.ts | 46 | Pass |
| Health Check | health-check.test.ts | 6 | Pass |
| Peer Exchange | peer-exchange.test.ts | 21 | Pass |
| Inbox Protocol | inbox-protocol.test.ts | 20 | Pass |

## Tests Added — Session 2

- **ledger-confirmation-security.test.ts**: 8 tests for C1/C2 fixes (signed confirmations, rejection of forged identities, signature validation)
- **compression.test.ts**: 8 tests for message compression (round-trip, zip bomb protection, backwards compatibility)
- **message-edge-cases.test.ts**: 9 tests for message validation edge cases (empty tags, tampered payloads, compression + signature)
- **rate-limiting-edge-cases.test.ts**: 6 tests for rate limiting boundaries (zero limit, burst handling, memory cleanup)
- **inbox-protocol.test.ts**: +1 test for H3 topic authorization fix

## Tests Added — Session 1

- **security-regression.test.ts**: Fixed 8 broken tests, added 24 new regression tests
- **health-check.test.ts**: 6 tests for HTTP health endpoint
- **peer-exchange.test.ts**: 21 tests for peer exchange protocol
- **inbox-protocol.test.ts**: 19 tests for store-and-forward
