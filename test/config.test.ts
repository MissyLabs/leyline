import { describe, it, expect, vi } from 'vitest';
import { mergeConfig, DEFAULT_CONFIG, DEFAULT_SEED_NODES } from '../src/config/config.js';

describe('mergeConfig', () => {
  it('returns defaults when given empty partial', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = mergeConfig({});
    expect(config.listenPort).toBe(DEFAULT_CONFIG.listenPort);
    expect(config.seedNodes).toEqual([...DEFAULT_SEED_NODES]);
    expect(config.isSeedNode).toBe(false);
    warnSpy.mockRestore();
  });

  it('rebuilds listenAddresses from custom port when not explicitly set', () => {
    const config = mergeConfig({ listenPort: 5555, webSocketPort: 5556 });
    expect(config.listenAddresses).toContain('/ip4/0.0.0.0/tcp/5555');
    expect(config.listenAddresses).toContain('/ip4/0.0.0.0/tcp/5556/ws');
  });

  it('uses explicit listenAddresses when provided', () => {
    const addrs = ['/ip4/127.0.0.1/tcp/1234'];
    const config = mergeConfig({ listenAddresses: addrs });
    expect(config.listenAddresses).toEqual(addrs);
  });

  it('omits WebSocket address when enableWebSocket is false', () => {
    const config = mergeConfig({ enableWebSocket: false });
    expect(config.listenAddresses.some(a => a.includes('/ws'))).toBe(false);
  });

  it('clears seeds for seed node with explicit empty seedNodes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = mergeConfig({ isSeedNode: true, seedNodes: [] });
    expect(config.seedNodes).toEqual([]);
    warnSpy.mockRestore();
  });

  it('keeps default seeds for seed node without explicit seedNodes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = mergeConfig({ isSeedNode: true });
    expect(config.seedNodes.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it('warns when isSeedNode is set directly', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mergeConfig({ isSeedNode: true });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('isSeedNode'),
    );
    warnSpy.mockRestore();
  });

  it('overrides individual config fields', () => {
    const config = mergeConfig({
      maxPayloadSize: 1024,
      rateLimitPerMinute: 10,
      autoBlockThreshold: 5,
    });
    expect(config.maxPayloadSize).toBe(1024);
    expect(config.rateLimitPerMinute).toBe(10);
    expect(config.autoBlockThreshold).toBe(5);
  });
});
