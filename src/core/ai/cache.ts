import { fingerprint } from '@/shared/utils';

/**
 * Response cache + request coalescing.
 *
 * Cost control is a stated priority, so this module does two jobs:
 *
 *  1. TTL cache keyed by a fingerprint of (conversation, incoming message,
 *     style, length, language). Regenerating the same message for the same
 *     client within the TTL returns the cached suggestions with zero tokens.
 *  2. In-flight coalescing: if two triggers fire for the same key (a debounce
 *     race, or the user double-clicking Generate), the second awaits the first
 *     instead of issuing a duplicate request.
 */

interface CacheEntry<T> {
  value: T;
  at: number;
  hits: number;
}

export interface CacheKeyParts {
  conversationId: string;
  incoming: string;
  style: string;
  length: string;
  language: string;
  count: number;
}

export function cacheKey(parts: CacheKeyParts): string {
  return [
    parts.conversationId,
    fingerprint(parts.incoming).slice(0, 200),
    parts.style,
    parts.length,
    parts.language,
    parts.count,
  ].join('|');
}

export class ResponseCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs = 120_000,
    private readonly maxEntries = 200,
  ) {}

  get(key: string): T | null {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    hit.hits++;
    return hit.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, at: Date.now(), hits: 0 });
    if (this.store.size > this.maxEntries) {
      // Evict the oldest entry; entries are small so this stays O(n) but n is bounded.
      const oldest = [...this.store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.store.delete(oldest[0]);
    }
  }

  /**
   * Returns the cached value, joins an in-flight request, or runs `factory`.
   * `bypassCache` forces a real regeneration (used by the Regenerate button).
   */
  async resolve(key: string, factory: () => Promise<T>, bypassCache = false): Promise<{ value: T; cached: boolean }> {
    if (!bypassCache) {
      const cached = this.get(key);
      if (cached !== null) return { value: cached, cached: true };

      const pending = this.inflight.get(key);
      if (pending) return { value: await pending, cached: false };
    }

    const promise = factory();
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      this.set(key, value);
      return { value, cached: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Drops every entry for a conversation (used when memory is cleared). */
  invalidateConversation(conversationId: string): number {
    let n = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(`${conversationId}|`)) {
        this.store.delete(key);
        n++;
      }
    }
    return n;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  get stats(): { entries: number; hits: number; inflight: number } {
    let hits = 0;
    for (const e of this.store.values()) hits += e.hits;
    return { entries: this.store.size, hits, inflight: this.inflight.size };
  }
}
