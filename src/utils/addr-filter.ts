/**
 * @module addr-filter
 *
 * Multiaddr helpers for announcement filtering and seed PeerId extraction.
 *
 * The previous announce filter used substring matching (`str.includes('/ip4/172.')`)
 * which over-filtered the entire `172.0.0.0/8` block instead of just the private
 * `172.16.0.0/12`, and could false-match on any multiaddr that merely contained
 * those substrings elsewhere (IMP-4). This module parses the actual IP component
 * and tests it against the real private / non-routable CIDR ranges.
 */

/** Parse the IPv4 address from a multiaddr string, or null if not IPv4. */
function extractIp4(addr: string): string | null {
  const m = addr.match(/\/ip4\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\/|$)/);
  return m ? m[1] : null;
}

/** Parse the IPv6 address from a multiaddr string, or null if not IPv6. */
function extractIp6(addr: string): string | null {
  const m = addr.match(/\/ip6\/([0-9a-fA-F:]+)(?:\/|$)/);
  return m ? m[1] : null;
}

function ip4ToInt(ip: string): number | null {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr(ipInt: number, base: string, prefix: number): boolean {
  const baseInt = ip4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * Returns true if the multiaddr should be filtered out of announcements because
 * it is private / non-routable (other peers can't reach it). Loopback is kept so
 * local testing continues to work.
 *
 * IPv4 ranges filtered: 10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT),
 * 169.254/16 (link-local). IPv6: fc00::/7 (ULA), fe80::/10 (link-local).
 */
export function isPrivateMultiaddr(addr: string): boolean {
  const ip4 = extractIp4(addr);
  if (ip4 !== null) {
    // Keep loopback (127.0.0.0/8) for local testing.
    if (ip4.startsWith('127.')) return false;
    const ipInt = ip4ToInt(ip4);
    if (ipInt === null) return false;
    return (
      inCidr(ipInt, '10.0.0.0', 8) ||
      inCidr(ipInt, '172.16.0.0', 12) ||
      inCidr(ipInt, '192.168.0.0', 16) ||
      inCidr(ipInt, '100.64.0.0', 10) ||
      inCidr(ipInt, '169.254.0.0', 16)
    );
  }

  const ip6 = extractIp6(addr);
  if (ip6 !== null) {
    const lower = ip6.toLowerCase();
    if (lower === '::1') return false; // loopback kept
    // fc00::/7 (unique local) — first byte 0xfc or 0xfd
    if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
    // fe80::/10 (link-local)
    if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
    return false;
  }

  return false;
}

/**
 * Extract the PeerId (the `/p2p/<id>` suffix) from a configured seed multiaddr.
 * Returns null when the multiaddr has no PeerId component.
 *
 * Matching connections by PeerId is DNS/IP-agnostic, unlike the old host
 * substring match which never fired for `/dns4/...` seeds once resolved (DC-1).
 */
export function extractSeedPeerId(seedMultiaddr: string): string | null {
  const m = seedMultiaddr.match(/\/p2p\/([1-9A-HJ-NP-Za-km-z]+)$/);
  return m ? m[1] : null;
}
