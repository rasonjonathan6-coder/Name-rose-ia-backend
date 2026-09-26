import type { ClientMemory, ConversationRef, ImportantFact, StoredMessage } from '@/shared/types';
import { log } from '@/core/logging/logger';
import { fingerprint, similarity, truncate } from '@/shared/utils';
import * as storage from '@/storage';

/**
 * ClientMemoryStore — one isolated record per client, persisted locally.
 *
 * Isolation guarantee: the record id is `${platform}:${clientId}` and every read
 * and write goes through that id. Two clients on the same platform can never
 * share a record even if they have the same display name, because the clientId
 * is resolved by the adapter from a stable DOM/URL identifier.
 *
 * Token economy (a stated priority) works on three levels:
 *   1. `recentMessages` is a bounded ring buffer (default 12) — the raw window.
 *   2. `summary` is a rolling prose compression produced by the fast model once
 *      the window exceeds `autoSummarizeAfter`; older raw messages are dropped
 *      after being folded in.
 *   3. `importantFacts` are deduplicated and weighted, and only the top-N by
 *      weight are rendered into the prompt (see prompts.renderMemory).
 */

export interface MemoryOptions {
  enabled: boolean;
  retentionDays: number;
  maxRecentMessages: number;
  autoSummarizeAfter: number;
}

export interface MemoryUpdateResult {
  memory: ClientMemory;
  /** True when the caller should trigger a summary refresh. */
  needsSummary: boolean;
  /** True when new facts were detected and should be extracted by the model. */
  needsFactExtraction: boolean;
}

export class ClientMemoryStore {
  private cache = new Map<string, ClientMemory>();

  constructor(private readonly getOptions: () => MemoryOptions) {}

  private options(): MemoryOptions {
    return this.getOptions();
  }

  /** Deterministic, collision-free key for a client. */
  static keyOf(platform: string, clientId: string): string {
    return `${platform}:${clientId}`;
  }

  /**
   * Loads a client's memory, creating an empty record on first contact.
   * Returns a fresh empty record (never persisted) when memory is disabled, so
   * the rest of the pipeline keeps working with zero retention.
   */
  async getOrCreate(conversation: ConversationRef): Promise<ClientMemory> {
    const id = ClientMemoryStore.keyOf(conversation.platform, conversation.clientId);
    const opts = this.options();

    if (!opts.enabled) {
      return emptyMemory(conversation, id);
    }

    const cached = this.cache.get(id);
    if (cached) {
      // Keep display name and language fresh without a storage round-trip.
      if (conversation.displayName && conversation.displayName !== 'Unknown') {
        cached.displayName = conversation.displayName;
      }
      return cached;
    }

    const stored = await storage.loadMemory(id);
    if (stored) {
      const migrated = migrate(stored, conversation);
      this.cache.set(id, migrated);
      return migrated;
    }

    const fresh = emptyMemory(conversation, id);
    await storage.saveMemory(fresh);
    this.cache.set(id, fresh);
    log.info('memory', `new client record created`, { id });
    return fresh;
  }

  /** Records an incoming client message. */
  async recordIncoming(
    conversation: ConversationRef,
    text: string,
    language: string | null,
  ): Promise<MemoryUpdateResult> {
    return this.record(conversation, 'client', text, language);
  }

  /** Records a reply the operator sent (manual, assisted or auto). */
  async recordOutgoing(
    conversation: ConversationRef,
    text: string,
    language: string | null,
  ): Promise<MemoryUpdateResult> {
    return this.record(conversation, 'assistant', text, language);
  }

  private async record(
    conversation: ConversationRef,
    role: StoredMessage['role'],
    text: string,
    language: string | null,
  ): Promise<MemoryUpdateResult> {
    const memory = await this.getOrCreate(conversation);
    const opts = this.options();
    const clean = text.trim();
    if (!clean) return { memory, needsSummary: false, needsFactExtraction: false };

    // Collapse immediate repeats — clients on these platforms paste the same
    // line twice more often than you would expect.
    const last = memory.recentMessages[memory.recentMessages.length - 1];
    if (last && last.role === role && similarity(last.text, clean) > 0.92) {
      last.at = Date.now();
      return { memory, needsSummary: false, needsFactExtraction: false };
    }

    const message: StoredMessage = { role, text: clean, at: Date.now(), lang: language };
    memory.recentMessages.push(message);
    memory.metadata.messageCount += 1;
    memory.lastInteraction = message.at;
    if (language && !memory.language) memory.language = language;
    if (conversation.displayName && conversation.displayName !== 'Unknown') {
      memory.displayName = conversation.displayName;
    }

    // Bound the raw window; overflow is compressed rather than discarded.
    let overflowed = 0;
    if (memory.recentMessages.length > opts.maxRecentMessages) {
      overflowed = memory.recentMessages.length - opts.maxRecentMessages;
      memory.recentMessages = memory.recentMessages.slice(-opts.maxRecentMessages);
    }

    const needsSummary =
      role === 'client' &&
      (memory.metadata.messageCount >= opts.autoSummarizeAfter || overflowed > 0);

    if (role === 'client') this.updateTopics(memory, clean);

    if (opts.enabled) await storage.saveMemory(memory);
    return { memory, needsSummary, needsFactExtraction: role === 'client' && clean.length > 12 };
  }

  /** Folds a model-generated summary into the record and drops folded history. */
  async applySummary(memory: ClientMemory, summary: string): Promise<ClientMemory> {
    const next: ClientMemory = {
      ...memory,
      summary: truncate(summary.trim(), 1500),
      recentMessages: memory.recentMessages.slice(-4),
      metadata: { ...memory.metadata, tokensSaved: memory.metadata.tokensSaved + 1 },
    };
    this.cache.set(next.id, next);
    if (this.options().enabled) await storage.saveMemory(next);
    log.info('memory', 'summary compressed conversation', { id: next.id });
    return next;
  }

  /** Merges extracted facts, deduplicating and weighting. */
  async mergeFacts(memory: ClientMemory, facts: Array<Omit<ImportantFact, 'at'>>): Promise<ClientMemory> {
    if (!facts.length) return memory;

    const existing = [...memory.importantFacts];
    for (const fact of facts) {
      const keyNorm = fact.key.toLowerCase().trim();
      const valueNorm = fingerprint(fact.value);
      if (!valueNorm) continue;

      const dupIndex = existing.findIndex(
        (f) =>
          f.key.toLowerCase().trim() === keyNorm ||
          fingerprint(f.value) === valueNorm ||
          similarity(f.value, fact.value) > 0.9,
      );

      if (dupIndex >= 0) {
        // Same fact restated: reinforce weight, refresh the value.
        const prev = existing[dupIndex]!;
        existing[dupIndex] = {
          ...prev,
          value: fact.value.length > prev.value.length ? fact.value : prev.value,
          weight: Math.min(1, prev.weight + 0.15),
          at: Date.now(),
        };
      } else {
        existing.push({ ...fact, at: Date.now() });
      }
    }

    // Cap the fact list, keeping the highest-weight entries.
    const capped = existing.sort((a, b) => b.weight - a.weight).slice(0, 40);

    const next: ClientMemory = { ...memory, importantFacts: capped };
    this.cache.set(next.id, next);
    if (this.options().enabled) await storage.saveMemory(next);
    return next;
  }

  /** Cheap keyword-based topic tagging. No model call, no cost. */
  private updateTopics(memory: ClientMemory, text: string): void {
    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 4 && !TOPIC_STOPWORDS.has(w));

    const topics = new Set(memory.topics);
    for (const w of words.slice(0, 6)) {
      if (topics.size >= 12) break;
      topics.add(w);
    }
    memory.topics = [...topics].slice(-12);
  }

  /** Builds the compact history window handed to the model. */
  buildContextWindow(memory: ClientMemory, maxMessages = 10): StoredMessage[] {
    return memory.recentMessages.slice(-maxMessages);
  }

  async clear(clientId: string): Promise<void> {
    this.cache.delete(clientId);
    await storage.deleteMemory(clientId);
    log.info('memory', 'cleared client record', { id: clientId });
  }

  async clearAll(): Promise<void> {
    this.cache.clear();
    await storage.clearAllMemory();
  }

  /** Re-reads a record from storage, bypassing the in-process cache. */
  async refresh(id: string): Promise<ClientMemory | null> {
    this.cache.delete(id);
    const stored = await storage.loadMemory(id);
    if (stored) this.cache.set(id, stored);
    return stored;
  }

  async list(): Promise<ClientMemory[]> {
    const all = await storage.listMemories();
    for (const m of all) this.cache.set(m.id, m);
    return all;
  }

  /** Exposed for tests. */
  get cachedCount(): number {
    return this.cache.size;
  }
}

const TOPIC_STOPWORDS = new Set([
  'about', 'would', 'could', 'should', 'there', 'their', 'where', 'which', 'these', 'those',
  'really', 'thing', 'things', 'going', 'doing', 'being', 'have', 'that', 'this', 'with',
  'from', 'your', 'what', 'when', 'just', 'like', 'know', 'want', 'make', 'time', 'good',
  'very', 'much', 'some', 'more', 'also', 'than', 'then', 'them', 'they', 'here', 'been',
  'parce', 'pour', 'avec', 'dans', 'plus', 'bien', 'très', 'fait', 'comme', 'mais', 'tout',
]);

function emptyMemory(conversation: ConversationRef, id: string): ClientMemory {
  return {
    id,
    platform: conversation.platform,
    clientId: conversation.clientId,
    displayName: conversation.displayName || 'Unknown',
    language: conversation.language ?? null,
    conversationId: conversation.conversationId,
    summary: '',
    recentMessages: [],
    importantFacts: [],
    preferences: {},
    topics: [],
    lastInteraction: Date.now(),
    createdAt: Date.now(),
    metadata: {
      messageCount: 0,
      platformsSeen: [conversation.platform],
      tokensSaved: 0,
      version: 1,
    },
  };
}

/** Forward-compatible migration for records written by an older build. */
function migrate(stored: ClientMemory, conversation: ConversationRef): ClientMemory {
  const base = emptyMemory(conversation, stored.id ?? ClientMemoryStore.keyOf(conversation.platform, conversation.clientId));
  return {
    ...base,
    ...stored,
    metadata: { ...base.metadata, ...(stored.metadata ?? {}) },
    recentMessages: Array.isArray(stored.recentMessages) ? stored.recentMessages : [],
    importantFacts: Array.isArray(stored.importantFacts) ? stored.importantFacts : [],
    topics: Array.isArray(stored.topics) ? stored.topics : [],
    preferences: stored.preferences ?? {},
    displayName: conversation.displayName && conversation.displayName !== 'Unknown'
      ? conversation.displayName
      : stored.displayName || base.displayName,
  };
}
