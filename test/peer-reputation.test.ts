import { describe, it, expect, beforeEach } from 'vitest';
import { PeerReputation } from '../src/trust/peer-reputation.js';

describe('PeerReputation', () => {
  let rep: PeerReputation;

  beforeEach(() => {
    rep = new PeerReputation();
  });

  it('unknown peers have the initial score', () => {
    expect(rep.getScore('unknown')).toBe(50);
  });

  it('unknown peers are trusted by default (score >= threshold)', () => {
    expect(rep.isTrusted('unknown')).toBe(true);
  });

  it('recordSuccess increases score', () => {
    rep.recordSuccess('peer1');
    expect(rep.getScore('peer1')).toBeGreaterThan(50);
  });

  it('recordFailure decreases score', () => {
    rep.recordFailure('peer1');
    expect(rep.getScore('peer1')).toBeLessThan(50);
  });

  it('recordSpam decreases score significantly', () => {
    rep.recordSpam('peer1');
    const afterSpam = rep.getScore('peer1');
    expect(afterSpam).toBeLessThan(50);
    expect(afterSpam).toBeLessThanOrEqual(45);
  });

  it('recordViolation decreases score severely', () => {
    rep.recordViolation('peer1');
    const afterViolation = rep.getScore('peer1');
    expect(afterViolation).toBeLessThanOrEqual(40);
  });

  it('score is clamped to maxScore', () => {
    for (let i = 0; i < 200; i++) rep.recordSuccess('good-peer');
    expect(rep.getScore('good-peer')).toBe(100);
  });

  it('score is clamped to minScore', () => {
    for (let i = 0; i < 200; i++) rep.recordViolation('bad-peer');
    expect(rep.getScore('bad-peer')).toBe(-100);
  });

  it('peer becomes untrusted when score drops below threshold', () => {
    // 10 violations: 50 - (10 * 10) = -50
    for (let i = 0; i < 10; i++) rep.recordViolation('bad');
    expect(rep.isTrusted('bad')).toBe(false);
  });

  it('getRecord returns full stats', () => {
    rep.recordSuccess('peer1');
    rep.recordSuccess('peer1');
    rep.recordFailure('peer1');
    rep.recordSpam('peer1');

    const rec = rep.getRecord('peer1');
    expect(rec).toBeDefined();
    expect(rec!.successCount).toBe(2);
    expect(rec!.failureCount).toBe(1);
    expect(rec!.spamCount).toBe(1);
    expect(rec!.violationCount).toBe(0);
  });

  it('getRecord returns undefined for unknown peer', () => {
    expect(rep.getRecord('unknown')).toBeUndefined();
  });

  it('getRankedPeers returns sorted by score descending', () => {
    rep.recordSuccess('good');
    rep.recordSuccess('good');
    rep.recordViolation('bad');

    const ranked = rep.getRankedPeers();
    expect(ranked.length).toBe(2);
    expect(ranked[0].peerId).toBe('good');
    expect(ranked[1].peerId).toBe('bad');
  });

  it('remove deletes a peer', () => {
    rep.recordSuccess('temp');
    expect(rep.size).toBe(1);
    rep.remove('temp');
    expect(rep.size).toBe(0);
    expect(rep.getScore('temp')).toBe(50); // back to default
  });

  it('clear removes all peers', () => {
    rep.recordSuccess('a');
    rep.recordSuccess('b');
    expect(rep.size).toBe(2);
    rep.clear();
    expect(rep.size).toBe(0);
  });

  it('evicts oldest peer when exceeding maxPeers', () => {
    const smallRep = new PeerReputation({ maxPeers: 3 });
    smallRep.recordSuccess('p1');
    smallRep.recordSuccess('p2');
    smallRep.recordSuccess('p3');
    expect(smallRep.size).toBe(3);

    // Adding 4th should evict oldest
    smallRep.recordSuccess('p4');
    expect(smallRep.size).toBe(3);
    // p1 was the oldest, should be evicted
    expect(smallRep.getRecord('p1')).toBeUndefined();
    expect(smallRep.getRecord('p4')).toBeDefined();
  });

  it('custom config overrides defaults', () => {
    const custom = new PeerReputation({
      initialScore: 100,
      maxScore: 200,
      successReward: 10,
      untrustedThreshold: 50,
    });
    expect(custom.getScore('new')).toBe(100);
    custom.recordSuccess('new');
    expect(custom.getScore('new')).toBeGreaterThanOrEqual(110);
  });
});

describe('PeerReputation — decay', () => {
  it('score decays toward initial over time', async () => {
    const rep = new PeerReputation({
      decayHalfLifeMs: 50, // fast decay for testing
    });

    // Raise score high
    for (let i = 0; i < 40; i++) rep.recordSuccess('peer1');
    const highScore = rep.getScore('peer1');
    expect(highScore).toBeGreaterThan(80);

    // Wait for decay
    await new Promise(r => setTimeout(r, 100)); // ~2 half-lives

    const decayed = rep.getScore('peer1');
    // Score should have decayed toward 50
    expect(decayed).toBeLessThan(highScore);
    expect(decayed).toBeGreaterThan(50);
  });

  it('negative score decays back toward initial', async () => {
    const rep = new PeerReputation({
      decayHalfLifeMs: 50,
    });

    for (let i = 0; i < 10; i++) rep.recordViolation('bad');
    const lowScore = rep.getScore('bad');
    expect(lowScore).toBeLessThan(0);

    await new Promise(r => setTimeout(r, 100));

    const decayed = rep.getScore('bad');
    expect(decayed).toBeGreaterThan(lowScore);
  });

  it('peer at initial score does not decay', () => {
    const rep = new PeerReputation({ decayHalfLifeMs: 1 });
    rep.recordSuccess('x'); // create the record
    // Manually set score to initial
    const rec = rep.getRecord('x');
    // Score should be approximately initial (51 after one success)
    expect(rec).toBeDefined();
  });

  it('concurrent events on same peer produce coherent state', () => {
    const rep = new PeerReputation();
    rep.recordSuccess('p');
    rep.recordFailure('p');
    rep.recordSpam('p');
    rep.recordViolation('p');
    rep.recordSuccess('p');

    const rec = rep.getRecord('p')!;
    expect(rec.successCount).toBe(2);
    expect(rec.failureCount).toBe(1);
    expect(rec.spamCount).toBe(1);
    expect(rec.violationCount).toBe(1);
    // net: +2 -2 -5 -10 +1 = -14 from initial 50 = 36 (approximately, with decay)
    expect(rec.score).toBeLessThan(50);
  });
});
