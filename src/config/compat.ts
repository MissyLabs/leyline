/**
 * @module compat
 *
 * Version compatibility matrix for the Leyline network.
 *
 * Controls which node versions can interoperate on the mesh.
 * Updated with each release. Seeds enforce the minimum version
 * and log deprecation warnings for older-but-compatible versions.
 *
 * Version lifecycle:
 *   current    → fully supported, no warnings
 *   deprecated → works, but logs warnings; will become incompatible next cycle
 *   below min  → hard rejected with upgrade instructions
 *
 * Typical cycle: a version is current for ~1 month, deprecated for ~1 month,
 * then removed from the compat window.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Read version from package.json at module load time
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '../../package.json');
let LOCAL_VERSION = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  LOCAL_VERSION = pkg.version ?? '0.0.0';
} catch {
  // Fallback if package.json can't be read (e.g., bundled builds)
}

/** The version of this node, read from package.json. */
export const LEYLINE_VERSION: string = LOCAL_VERSION;

// ---------------------------------------------------------------------------
// Compatibility matrix
// ---------------------------------------------------------------------------

export interface CompatMatrix {
  /** The current release version. */
  currentVersion: string;
  /** Hard floor — peers below this are rejected with an upgrade message. */
  minVersion: string;
  /** Versions that work but log deprecation warnings. Will be dropped next cycle. */
  deprecatedVersions: string[];
  /** Human-readable upgrade instructions sent to incompatible peers. */
  upgradeMessage: string;
}

/**
 * The active compatibility matrix.
 * Update this with each release.
 */
export const COMPAT: CompatMatrix = {
  currentVersion: '0.2.0',
  minVersion: '0.1.0',
  deprecatedVersions: ['0.1.0'],
  upgradeMessage:
    'Your Leyline version is below the network minimum. ' +
    'Update: cd leyline && git pull && npm ci && npm run build — ' +
    'https://github.com/MissyLabs/leyline',
};

// ---------------------------------------------------------------------------
// Semver comparison helpers
// ---------------------------------------------------------------------------

/** Parse a semver string into [major, minor, patch]. Returns [0,0,0] on failure. */
function parseSemver(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/** Returns true if `a` >= `b` in semver ordering. */
export function semverGte(a: string, b: string): boolean {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
}

/** Returns true if `a` < `b` in semver ordering. */
export function semverLt(a: string, b: string): boolean {
  return !semverGte(a, b);
}

// ---------------------------------------------------------------------------
// Compatibility check result
// ---------------------------------------------------------------------------

export interface CompatResult {
  /** True if the peer version is compatible (at or above minVersion). */
  compatible: boolean;
  /** True if the peer version is deprecated (works but should upgrade soon). */
  deprecated: boolean;
  /** Human-readable message for the peer (upgrade instructions if incompatible). */
  message: string;
}

/**
 * Check whether a peer's version is compatible with this node.
 *
 * @param peerVersion - The remote peer's reported version string.
 * @returns Compatibility result with status and message.
 */
export function checkCompat(peerVersion: string): CompatResult {
  // Unknown/missing version — treat as incompatible
  if (!peerVersion || peerVersion === '0.0.0') {
    return {
      compatible: false,
      deprecated: false,
      message: `Unknown version. ${COMPAT.upgradeMessage}`,
    };
  }

  // Below minimum — hard reject
  if (semverLt(peerVersion, COMPAT.minVersion)) {
    return {
      compatible: false,
      deprecated: false,
      message: `Version ${peerVersion} is below minimum ${COMPAT.minVersion}. ${COMPAT.upgradeMessage}`,
    };
  }

  // Deprecated — compatible but warn
  if (COMPAT.deprecatedVersions.includes(peerVersion)) {
    return {
      compatible: true,
      deprecated: true,
      message: `Version ${peerVersion} is deprecated and will become incompatible soon. ${COMPAT.upgradeMessage}`,
    };
  }

  // Current or newer — fully compatible
  return {
    compatible: true,
    deprecated: false,
    message: 'OK',
  };
}
