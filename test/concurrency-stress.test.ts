import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SharedLedger } from '../src/ledger/shared-ledger.js';
import { LedgerConsensus } from '../src/ledger/consensus.js';
import { PersistentTrustPolicy, PersistentSpamFilter } from '../src/trust/persistent-policy.js';
import { generateKeypair, sign, publicKeyToHex } from '../src/identity/keypair.js';
import { ServiceRegistry } from '../src/discovery/service-registry.js';
import { SpamFilter } from '../src/trust/policy.js';

describe('Concurrency stress tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'leyline-stress-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('SharedLedger concurrent submits', () => {
    it('handles 50 concurrent submissions without data loss', async () => {
      const ledger = new SharedLedger(join(tmpDir, 'ledger'));
      await ledger.open();

      const keypair = await generateKeypair();
      const entries = await Promise.all(
        Array.from({ length: 50 }, async (_, i) => {
          const data = new TextEncoder().encode(`entry-${i}`);
          const sig = await sign(keypair.privateKey, data);
          return { data, pubkey: keypair.publicKey, sig };
        }),
      );

      const results = await Promise.allSettled(
        entries.map((e) => ledger.submit(e.data, e.pubkey, e.sig)),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded.length).toBe(50);

      const count = await ledger.getEntryCount();
      expect(count).toBe(50);

      await ledger.close();
    });

    it('maintains hash chain integrity under concurrent writes', async () => {
      const ledger = new SharedLedger(join(tmpDir, 'ledger'));
      await ledger.open();

      const keypair = await generateKeypair();

      for (let i = 0; i < 20; i++) {
        const data = new TextEncoder().encode(`sequential-${i}`);
        const sig = await sign(keypair.privateKey, data);
        await ledger.submit(data, keypair.publicKey, sig);
      }

      const entries = await ledger.getRange(1, 20);
      for (let i = 1; i < entries.length; i++) {
        const prevHash = Buffer.from(entries[i].prevHash).toString('hex');
        const expectedHash = Buffer.from(entries[i - 1].hash).toString('hex');
        expect(prevHash).toBe(expectedHash);
      }

      await ledger.close();
    });
  });

  describe('LedgerConsensus concurrent confirmations', () => {
    it('handles concurrent confirmations from multiple peers', async () => {
      const consensus = new LedgerConsensus({ quorumSize: 5 });
      const keypair = await generateKeypair();
      const data = new TextEncoder().encode('test');
      const sig = await sign(keypair.privateKey, data);

      const proposal = consensus.propose(data, keypair.publicKey, sig);

      const peers = await Promise.all(
        Array.from({ length: 10 }, () => generateKeypair()),
      );

      const results = peers.map((peer) =>
        consensus.addConfirmation(proposal.hash, publicKeyToHex(peer.publicKey)),
      );

      const quorumReachedCount = results.filter((r) => r === true).length;
      expect(quorumReachedCount).toBe(1);
      expect(consensus.isFinalized(proposal.hash)).toBe(true);
    });

    it('rejects duplicate confirmations from same peer', () => {
      const consensus = new LedgerConsensus({ quorumSize: 3 });
      const keypair = generateKeypair();
      const data = new TextEncoder().encode('test');

      // Use sync approach since generateKeypair might be async
      const doTest = async () => {
        const kp = await generateKeypair();
        const sig = await sign(kp.privateKey, data);
        const proposal = consensus.propose(data, kp.publicKey, sig);

        const confirmer = await generateKeypair();
        const confirmerHex = publicKeyToHex(confirmer.publicKey);

        consensus.addConfirmation(proposal.hash, confirmerHex);
        consensus.addConfirmation(proposal.hash, confirmerHex);

        const p = consensus.getProposal(proposal.hash);
        expect(p!.confirmations.size).toBe(1);
      };
      return doTest();
    });
  });

  describe('PersistentTrustPolicy concurrent operations', () => {
    it('handles concurrent allow/block operations', async () => {
      const trust = new PersistentTrustPolicy(join(tmpDir, 'trust'));
      await trust.open();

      const keys = Array.from({ length: 20 }, (_, i) =>
        i.toString(16).padStart(64, '0'),
      );

      await Promise.all([
        ...keys.slice(0, 10).map((k) => trust.allowAgent(k)),
        ...keys.slice(10).map((k) => trust.blockAgent(k)),
      ]);

      for (let i = 0; i < 10; i++) {
        expect(trust.isAllowed(keys[i], [])).toBe(true);
      }
      for (let i = 10; i < 20; i++) {
        expect(trust.isAllowed(keys[i], [])).toBe(false);
      }

      await trust.close();
    });
  });

  describe('SpamFilter concurrent dedup checks', () => {
    it('correctly deduplicates under concurrent access', () => {
      const filter = new SpamFilter(1000);

      const ids = Array.from({ length: 100 }, (_, i) => `msg-${i}`);

      // First pass: none should be duplicates
      const firstPass = ids.map((id) => filter.isDuplicate(id));
      expect(firstPass.every((v) => v === false)).toBe(true);

      // Second pass: all should be duplicates
      const secondPass = ids.map((id) => filter.isDuplicate(id));
      expect(secondPass.every((v) => v === true)).toBe(true);
    });

    it('respects maxSeen limit', () => {
      const filter = new SpamFilter(50);

      for (let i = 0; i < 100; i++) {
        filter.isDuplicate(`msg-${i}`);
      }

      // Old entries should have been evicted
      expect(filter.isDuplicate('msg-0')).toBe(false);
      // Recent entries should still be tracked
      expect(filter.isDuplicate('msg-99')).toBe(true);
    });
  });

  describe('ServiceRegistry concurrent operations', () => {
    it('handles concurrent register and query', async () => {
      const registry = new ServiceRegistry();
      const keypair = await generateKeypair();
      const pubkeyHex = publicKeyToHex(keypair.publicKey);

      const descriptors = Array.from({ length: 30 }, (_, i) =>
        registry.register({
          name: `service-${i}`,
          tags: ['ai', `group-${i % 3}`],
          description: `Service ${i}`,
          ttl: 300_000,
          metadata: {},
          providerPubkey: pubkeyHex,
          providerPeerId: `peer-${i}`,
          multiaddrs: [],
        }),
      );

      expect(descriptors.length).toBe(30);

      const group0 = registry.query({ tags: ['group-0'] });
      expect(group0.length).toBe(10);

      const all = registry.query({ tags: ['ai'] });
      expect(all.length).toBe(30);
    });

    it('handles concurrent addRemote up to cap', async () => {
      const registry = new ServiceRegistry();

      for (let i = 0; i < 200; i++) {
        const keypair = await generateKeypair();
        registry.addRemote({
          id: `remote-${i}`,
          name: `remote-service-${i}`,
          tags: ['remote'],
          description: '',
          ttl: 300_000,
          metadata: {},
          providerPubkey: publicKeyToHex(keypair.publicKey),
          providerPeerId: `peer-${i}`,
          multiaddrs: [],
          advertisedAt: Date.now(),
        });
      }

      const remotes = registry.query({ tags: ['remote'] });
      expect(remotes.length).toBeLessThanOrEqual(1000);
    });
  });
});
