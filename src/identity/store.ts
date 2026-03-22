/**
 * @module store
 *
 * Persistent Ed25519 keypair storage for Magic P2P nodes.
 *
 * Keypairs are stored as a JSON file on disk containing hex-encoded key
 * material. On first use a new keypair is generated and persisted; subsequent
 * calls to {@link IdentityStore.load} return the same keypair, giving each
 * node a stable cryptographic identity across restarts.
 *
 * Storage format (`identity.json`):
 * ```json
 * { "privateKey": "<64-char hex>", "publicKey": "<64-char hex>" }
 * ```
 */

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";

import { generateKeypair, type Keypair } from "./keypair.js";

// ---------------------------------------------------------------------------
// Serialisation helpers (module-private)
// ---------------------------------------------------------------------------

/** Wire shape of the persisted identity file. */
interface IdentityFile {
  privateKey: string;
  publicKey: string;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

// ---------------------------------------------------------------------------
// IdentityStore
// ---------------------------------------------------------------------------

/**
 * Manages a single Ed25519 keypair stored as `identity.json` inside a
 * configurable data directory.
 *
 * @example
 * ```ts
 * const store = new IdentityStore('/var/lib/my-node/data');
 * const { publicKey, privateKey } = await store.load();
 * ```
 */
export class IdentityStore {
  /** Absolute path to the directory that contains `identity.json`. */
  private readonly dataDir: string;

  /**
   * @param dataDir - Directory in which `identity.json` will be read/written.
   *   The directory (and any missing parents) is created automatically when
   *   {@link save} or {@link load} first needs it.
   */
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Returns the absolute path to the identity file.
   *
   * @returns `{dataDir}/identity.json`
   */
  getIdentityPath(): string {
    return join(this.dataDir, "identity.json");
  }

  /**
   * Checks whether an identity file already exists on disk.
   *
   * @returns `true` if `identity.json` is readable, `false` otherwise.
   */
  async exists(): Promise<boolean> {
    try {
      await access(this.getIdentityPath(), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Loads the persisted keypair from disk.
   *
   * If no identity file exists a fresh Ed25519 keypair is generated, saved to
   * disk, and returned. The data directory is created recursively if absent.
   *
   * @returns The stored (or newly generated) `{ publicKey, privateKey }` pair.
   * @throws {SyntaxError} If the identity file exists but contains malformed JSON.
   * @throws {RangeError} If the persisted hex strings do not decode to 32-byte keys.
   */
  async load(): Promise<Keypair> {
    if (await this.exists()) {
      return this.read();
    }

    const keypair = await generateKeypair();
    await this.save(keypair.privateKey, keypair.publicKey);
    return keypair;
  }

  /**
   * Saves a keypair to disk as hex-encoded JSON.
   *
   * The data directory is created recursively if it does not already exist.
   * The file is written atomically via a direct `writeFile` call with `"utf8"`
   * encoding; callers that need stronger durability guarantees should sync the
   * parent directory themselves.
   *
   * @param privateKey - 32-byte Ed25519 private key seed.
   * @param publicKey - 32-byte Ed25519 public key.
   */
  async save(privateKey: Uint8Array, publicKey: Uint8Array): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });

    const payload: IdentityFile = {
      privateKey: toHex(privateKey),
      publicKey: toHex(publicKey),
    };

    await writeFile(
      this.getIdentityPath(),
      JSON.stringify(payload, null, 2),
      "utf8",
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Reads and deserialises an existing identity file.
   *
   * @throws {SyntaxError} If the file does not contain valid JSON.
   * @throws {RangeError} If either key decodes to fewer or more than 32 bytes.
   */
  private async read(): Promise<Keypair> {
    const raw = await readFile(this.getIdentityPath(), "utf8");
    const parsed: IdentityFile = JSON.parse(raw) as IdentityFile;

    const privateKey = fromHex(parsed.privateKey);
    const publicKey = fromHex(parsed.publicKey);

    if (privateKey.length !== 32) {
      throw new RangeError(
        `identity.json: expected 32-byte private key, got ${privateKey.length} bytes`,
      );
    }
    if (publicKey.length !== 32) {
      throw new RangeError(
        `identity.json: expected 32-byte public key, got ${publicKey.length} bytes`,
      );
    }

    return { privateKey, publicKey };
  }
}
