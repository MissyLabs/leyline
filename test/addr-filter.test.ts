import { describe, it, expect } from 'vitest';
import { isPrivateMultiaddr, extractSeedPeerId } from '../src/utils/addr-filter.js';

// IMP-4: proper CIDR-based private-range filtering (not substring matching).
describe('isPrivateMultiaddr', () => {
  it('filters real private IPv4 ranges', () => {
    expect(isPrivateMultiaddr('/ip4/10.0.0.5/tcp/9876')).toBe(true);
    expect(isPrivateMultiaddr('/ip4/192.168.1.10/tcp/9876')).toBe(true);
    expect(isPrivateMultiaddr('/ip4/172.16.0.1/tcp/9876')).toBe(true);
    expect(isPrivateMultiaddr('/ip4/172.31.255.254/tcp/9876')).toBe(true);
    expect(isPrivateMultiaddr('/ip4/100.64.0.1/tcp/9876')).toBe(true); // CGNAT
    expect(isPrivateMultiaddr('/ip4/169.254.1.1/tcp/9876')).toBe(true); // link-local
  });

  it('does NOT over-filter public addresses in the 172.x space (old bug)', () => {
    // 172.0/8 minus 172.16/12 is public — the old substring match wrongly dropped these.
    expect(isPrivateMultiaddr('/ip4/172.15.0.1/tcp/9876')).toBe(false);
    expect(isPrivateMultiaddr('/ip4/172.32.0.1/tcp/9876')).toBe(false);
    expect(isPrivateMultiaddr('/ip4/107.152.39.241/tcp/9876')).toBe(false); // a real seed IP
  });

  it('keeps loopback for local testing', () => {
    expect(isPrivateMultiaddr('/ip4/127.0.0.1/tcp/9876')).toBe(false);
    expect(isPrivateMultiaddr('/ip6/::1/tcp/9876')).toBe(false);
  });

  it('filters IPv6 ULA and link-local ranges', () => {
    expect(isPrivateMultiaddr('/ip6/fc00::1/tcp/9876')).toBe(true);
    expect(isPrivateMultiaddr('/ip6/fd12:3456::1/tcp/9876')).toBe(true);
    expect(isPrivateMultiaddr('/ip6/fe80::1/tcp/9876')).toBe(true);
    expect(isPrivateMultiaddr('/ip6/2606:4700::1/tcp/9876')).toBe(false); // public
  });
});

// DC-1: DNS/IP-agnostic seed PeerId extraction.
describe('extractSeedPeerId', () => {
  it('extracts the PeerId from a /dns4 seed multiaddr', () => {
    const addr = '/dns4/node1.missylabs.com/tcp/9876/p2p/12D3KooWLWdsbESqd6KH153Lr3WiSaQJ8Y8YVbSihuh7fqHczwFe';
    expect(extractSeedPeerId(addr)).toBe('12D3KooWLWdsbESqd6KH153Lr3WiSaQJ8Y8YVbSihuh7fqHczwFe');
  });

  it('extracts the PeerId from an /ip4 seed multiaddr identically', () => {
    const addr = '/ip4/107.152.39.241/tcp/9876/p2p/12D3KooWLWdsbESqd6KH153Lr3WiSaQJ8Y8YVbSihuh7fqHczwFe';
    expect(extractSeedPeerId(addr)).toBe('12D3KooWLWdsbESqd6KH153Lr3WiSaQJ8Y8YVbSihuh7fqHczwFe');
  });

  it('returns null when there is no /p2p component', () => {
    expect(extractSeedPeerId('/ip4/1.2.3.4/tcp/9876')).toBeNull();
  });
});
