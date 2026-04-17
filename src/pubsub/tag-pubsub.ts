import type { GossipSub } from '@chainsafe/libp2p-gossipsub';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';

/**
 * Tag-based pub/sub layer built on top of GossipSub.
 * Each tag maps to a GossipSub topic with a "magic/tag/" prefix.
 */
export class TagPubSub {
  private gossipsub: GossipSub;
  private subscribedTags = new Set<string>();
  private handlers = new Map<string, Set<(data: Uint8Array, tag: string) => void>>();
  private globalHandlers = new Set<(data: Uint8Array, tag: string) => void>();

  static readonly TOPIC_PREFIX = 'magic/tag/';
  /** Special topic for peer discovery */
  static readonly DISCOVERY_TOPIC = 'magic/discovery';

  constructor(gossipsub: GossipSub) {
    this.gossipsub = gossipsub;
  }

  /** Convert a tag to a GossipSub topic name */
  private tagToTopic(tag: string): string {
    return TagPubSub.TOPIC_PREFIX + tag;
  }

  /** Extract the tag from a GossipSub topic name */
  private topicToTag(topic: string): string | null {
    if (topic.startsWith(TagPubSub.TOPIC_PREFIX)) {
      return topic.slice(TagPubSub.TOPIC_PREFIX.length);
    }
    return null;
  }

  /** Subscribe to a tag. Messages with this tag will be received. */
  subscribe(tag: string): void {
    const topic = this.tagToTopic(tag);
    if (!this.subscribedTags.has(tag)) {
      this.gossipsub.subscribe(topic);
      this.subscribedTags.add(tag);
    }
  }

  /** Unsubscribe from a tag. */
  unsubscribe(tag: string): void {
    const topic = this.tagToTopic(tag);
    if (this.subscribedTags.has(tag)) {
      this.gossipsub.unsubscribe(topic);
      this.subscribedTags.delete(tag);
    }
  }

  /** Subscribe to the discovery topic. */
  subscribeDiscovery(): void {
    this.gossipsub.subscribe(TagPubSub.DISCOVERY_TOPIC);
  }

  /** Register a handler for messages on a specific tag. */
  onTag(tag: string, handler: (data: Uint8Array, tag: string) => void): void {
    if (!this.handlers.has(tag)) {
      this.handlers.set(tag, new Set());
    }
    this.handlers.get(tag)!.add(handler);
  }

  /** Remove a handler for a specific tag. */
  offTag(tag: string, handler: (data: Uint8Array, tag: string) => void): void {
    this.handlers.get(tag)?.delete(handler);
  }

  /** Register a handler for ALL incoming messages (regardless of tag). */
  onMessage(handler: (data: Uint8Array, tag: string) => void): void {
    this.globalHandlers.add(handler);
  }

  /** Remove a global handler. */
  offMessage(handler: (data: Uint8Array, tag: string) => void): void {
    this.globalHandlers.delete(handler);
  }

  /** Publish a message to all specified tags. */
  async publish(tags: string[], data: Uint8Array): Promise<void> {
    const publishPromises = tags.map((tag) => {
      const topic = this.tagToTopic(tag);
      return this.gossipsub.publish(topic, data);
    });
    await Promise.all(publishPromises);
  }

  /** Publish to the discovery topic. */
  async publishDiscovery(data: Uint8Array): Promise<void> {
    await this.gossipsub.publish(TagPubSub.DISCOVERY_TOPIC, data);
  }

  /**
   * Handle an incoming GossipSub message event.
   * Call this from the libp2p gossipsub event listener.
   */
  handleMessage(topic: string, data: Uint8Array): void {
    const tag = this.topicToTag(topic);

    // Only dispatch messages from recognized tag topics.
    // Discovery and other non-tag topics are handled via separate paths.
    if (tag === null) return;

    // Fire tag-specific handlers
    if (this.handlers.has(tag)) {
      for (const handler of this.handlers.get(tag)!) {
        handler(data, tag);
      }
    }

    // Fire global handlers
    for (const handler of this.globalHandlers) {
      handler(data, tag);
    }
  }

  /** Get all currently subscribed tags. */
  getSubscribedTags(): string[] {
    return [...this.subscribedTags];
  }

  /** Get all GossipSub topics this node is subscribed to. */
  getTopics(): string[] {
    return this.gossipsub.getTopics();
  }

  /** Get peer count for a specific tag. */
  getTagPeerCount(tag: string): number {
    const topic = this.tagToTopic(tag);
    const peers = this.gossipsub.getSubscribers(topic);
    return peers.length;
  }

  /** Remove all handlers and clear subscriptions. Call during node shutdown. */
  clear(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
  }
}
