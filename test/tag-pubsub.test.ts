import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TagPubSub } from '../src/pubsub/tag-pubsub.js';

function createMockGossipsub() {
  const subscriptions = new Set<string>();
  const subscribers = new Map<string, string[]>();
  return {
    subscribe: vi.fn((topic: string) => subscriptions.add(topic)),
    unsubscribe: vi.fn((topic: string) => subscriptions.delete(topic)),
    publish: vi.fn(async () => ({ recipients: [] })),
    getTopics: vi.fn(() => [...subscriptions]),
    getSubscribers: vi.fn((topic: string) => subscribers.get(topic) ?? []),
    _subscribers: subscribers,
    _subscriptions: subscriptions,
  };
}

describe('TagPubSub', () => {
  let gossipsub: ReturnType<typeof createMockGossipsub>;
  let pubsub: TagPubSub;

  beforeEach(() => {
    gossipsub = createMockGossipsub();
    pubsub = new TagPubSub(gossipsub as any);
  });

  it('subscribe maps tag to topic with prefix', () => {
    pubsub.subscribe('skill:code');
    expect(gossipsub.subscribe).toHaveBeenCalledWith('magic/tag/skill:code');
    expect(pubsub.getSubscribedTags()).toEqual(['skill:code']);
  });

  it('subscribe is idempotent', () => {
    pubsub.subscribe('skill:code');
    pubsub.subscribe('skill:code');
    expect(gossipsub.subscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes the tag', () => {
    pubsub.subscribe('skill:code');
    pubsub.unsubscribe('skill:code');
    expect(gossipsub.unsubscribe).toHaveBeenCalledWith('magic/tag/skill:code');
    expect(pubsub.getSubscribedTags()).toEqual([]);
  });

  it('unsubscribe on unsubscribed tag is a no-op', () => {
    pubsub.unsubscribe('not-subscribed');
    expect(gossipsub.unsubscribe).not.toHaveBeenCalled();
  });

  it('subscribeDiscovery subscribes to the discovery topic', () => {
    pubsub.subscribeDiscovery();
    expect(gossipsub.subscribe).toHaveBeenCalledWith('magic/discovery');
  });

  it('onTag fires handler on matching tag message', () => {
    const handler = vi.fn();
    pubsub.onTag('skill:code', handler);
    const data = new Uint8Array([1, 2, 3]);
    pubsub.handleMessage('magic/tag/skill:code', data);
    expect(handler).toHaveBeenCalledWith(data, 'skill:code');
  });

  it('onTag does not fire for different tag', () => {
    const handler = vi.fn();
    pubsub.onTag('skill:code', handler);
    pubsub.handleMessage('magic/tag/other', new Uint8Array([1]));
    expect(handler).not.toHaveBeenCalled();
  });

  it('offTag removes handler', () => {
    const handler = vi.fn();
    pubsub.onTag('skill:code', handler);
    pubsub.offTag('skill:code', handler);
    pubsub.handleMessage('magic/tag/skill:code', new Uint8Array([1]));
    expect(handler).not.toHaveBeenCalled();
  });

  it('onMessage fires for all tag messages', () => {
    const handler = vi.fn();
    pubsub.onMessage(handler);
    pubsub.handleMessage('magic/tag/a', new Uint8Array([1]));
    pubsub.handleMessage('magic/tag/b', new Uint8Array([2]));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(new Uint8Array([1]), 'a');
    expect(handler).toHaveBeenCalledWith(new Uint8Array([2]), 'b');
  });

  it('offMessage removes global handler', () => {
    const handler = vi.fn();
    pubsub.onMessage(handler);
    pubsub.offMessage(handler);
    pubsub.handleMessage('magic/tag/a', new Uint8Array([1]));
    expect(handler).not.toHaveBeenCalled();
  });

  it('handleMessage ignores non-tag topics (discovery)', () => {
    const tagHandler = vi.fn();
    const globalHandler = vi.fn();
    pubsub.onTag('discovery', tagHandler);
    pubsub.onMessage(globalHandler);
    pubsub.handleMessage('magic/discovery', new Uint8Array([1]));
    expect(tagHandler).not.toHaveBeenCalled();
    expect(globalHandler).not.toHaveBeenCalled();
  });

  it('handleMessage fires both tag-specific and global handlers', () => {
    const tagHandler = vi.fn();
    const globalHandler = vi.fn();
    pubsub.onTag('skill:code', tagHandler);
    pubsub.onMessage(globalHandler);
    const data = new Uint8Array([42]);
    pubsub.handleMessage('magic/tag/skill:code', data);
    expect(tagHandler).toHaveBeenCalledOnce();
    expect(globalHandler).toHaveBeenCalledOnce();
  });

  it('publish sends to all tag topics', async () => {
    await pubsub.publish(['a', 'b', 'c'], new Uint8Array([1]));
    expect(gossipsub.publish).toHaveBeenCalledTimes(3);
    expect(gossipsub.publish).toHaveBeenCalledWith('magic/tag/a', new Uint8Array([1]));
    expect(gossipsub.publish).toHaveBeenCalledWith('magic/tag/b', new Uint8Array([1]));
    expect(gossipsub.publish).toHaveBeenCalledWith('magic/tag/c', new Uint8Array([1]));
  });

  it('publish with empty tags does nothing', async () => {
    await pubsub.publish([], new Uint8Array([1]));
    expect(gossipsub.publish).not.toHaveBeenCalled();
  });

  it('publishDiscovery publishes to discovery topic', async () => {
    await pubsub.publishDiscovery(new Uint8Array([1]));
    expect(gossipsub.publish).toHaveBeenCalledWith('magic/discovery', new Uint8Array([1]));
  });

  it('getTopics delegates to gossipsub', () => {
    gossipsub._subscriptions.add('magic/tag/x');
    expect(pubsub.getTopics()).toEqual(['magic/tag/x']);
  });

  it('getTagPeerCount returns subscriber count for a tag', () => {
    gossipsub._subscribers.set('magic/tag/skill:code', ['peer1', 'peer2']);
    expect(pubsub.getTagPeerCount('skill:code')).toBe(2);
  });

  it('getTagPeerCount returns 0 for unknown tag', () => {
    expect(pubsub.getTagPeerCount('unknown')).toBe(0);
  });

  it('clear removes all handlers', () => {
    const tagHandler = vi.fn();
    const globalHandler = vi.fn();
    pubsub.onTag('a', tagHandler);
    pubsub.onMessage(globalHandler);
    pubsub.clear();
    pubsub.handleMessage('magic/tag/a', new Uint8Array([1]));
    expect(tagHandler).not.toHaveBeenCalled();
    expect(globalHandler).not.toHaveBeenCalled();
  });

  it('multiple handlers on same tag all fire', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    pubsub.onTag('t', h1);
    pubsub.onTag('t', h2);
    pubsub.handleMessage('magic/tag/t', new Uint8Array([1]));
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });
});
