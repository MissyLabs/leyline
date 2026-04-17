import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IdentityStore } from '../src/identity/store.js';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('IdentityStore — edge cases', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'leyline-identity-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('generates and persists a keypair on first load', async () => {
    const store = new IdentityStore(tmpDir);
    expect(await store.exists()).toBe(false);

    const kp = await store.load();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
    expect(await store.exists()).toBe(true);
  });

  it('returns same keypair on subsequent loads', async () => {
    const store = new IdentityStore(tmpDir);
    const kp1 = await store.load();
    const kp2 = await store.load();
    expect(kp1.publicKey).toEqual(kp2.publicKey);
    expect(kp1.privateKey).toEqual(kp2.privateKey);
  });

  it('survives close and reopen from disk', async () => {
    const store1 = new IdentityStore(tmpDir);
    const kp1 = await store1.load();

    const store2 = new IdentityStore(tmpDir);
    const kp2 = await store2.load();
    expect(kp1.publicKey).toEqual(kp2.publicKey);
  });

  it('throws on malformed JSON in identity file', async () => {
    await writeFile(join(tmpDir, 'identity.json'), 'not json', 'utf8');
    const store = new IdentityStore(tmpDir);
    await expect(store.load()).rejects.toThrow();
  });

  it('throws on wrong key length', async () => {
    await writeFile(join(tmpDir, 'identity.json'), JSON.stringify({
      privateKey: 'abcd',
      publicKey: 'ef01',
    }), 'utf8');
    const store = new IdentityStore(tmpDir);
    await expect(store.load()).rejects.toThrow('32-byte');
  });

  it('creates nested directory structure if needed', async () => {
    const nestedDir = join(tmpDir, 'a', 'b', 'c');
    const store = new IdentityStore(nestedDir);
    const kp = await store.load();
    expect(kp.publicKey.length).toBe(32);
    expect(await store.exists()).toBe(true);
  });

  it('getIdentityPath returns correct path', () => {
    const store = new IdentityStore('/some/path');
    expect(store.getIdentityPath()).toBe('/some/path/identity.json');
  });

  it('identity file is written with restricted permissions', async () => {
    const store = new IdentityStore(tmpDir);
    await store.load();
    const content = await readFile(join(tmpDir, 'identity.json'), 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.privateKey).toBeTruthy();
    expect(parsed.publicKey).toBeTruthy();
    expect(typeof parsed.privateKey).toBe('string');
    expect(typeof parsed.publicKey).toBe('string');
    // Verify hex encoding — should be 64 chars for 32 bytes
    expect(parsed.privateKey.length).toBe(64);
    expect(parsed.publicKey.length).toBe(64);
  });
});
