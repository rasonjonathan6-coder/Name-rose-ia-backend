import { log } from '@/core/logging/logger';
import { normaliseText, similarity, fingerprint } from '@/shared/utils';
import type { RawMessage } from '@/shared/types';
import type { PlatformAdapter } from '@/platforms/types';

export interface DetectorEvents {
  onMessages: (messages: RawMessage[], all: RawMessage[]) => void;
  onConversationChange: (clientId: string | null) => void;
}

/**
 * MessageDetector — watches a chat surface and emits only *new* messages.
 *
 * Design constraints that shaped this implementation:
 *
 *  - Chat sites mutate the DOM constantly (typing indicators, timestamps,
 *    scroll position). A naive observer firing on every mutation would call the
 *    AI dozens of times per message, so we coalesce with a trailing debounce and
 *    diff against a seen-set.
 *  - SPA navigation replaces the whole message list. We detect that as a
 *    conversation change and reset the seen-set, otherwise the first message of
 *    the new chat would be swallowed as a duplicate.
 *  - Sites rewrite bubble DOM on hover; keys must be content-based and stable
 *    rather than node-identity based.
 */
export class MessageDetector {
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seen = new Set<string>();
  private lastConversationId: string | null = null;
  private lastCount = 0;
  private running = false;
  private roots: Element[] = [];

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly events: DetectorEvents,
    private readonly debounceMs = 220,
  ) {}

  start(doc: Document = document): void {
    if (this.running) return;
    this.running = true;

    this.roots = this.resolveRoots(doc);
    const target = this.roots[0] ?? doc.documentElement;
    if (!target) {
      log.warn('detector', 'no observation target found');
      return;
    }

    this.observer = new MutationObserver(() => this.schedule(doc));
    for (const root of this.roots.length ? this.roots : [target]) {
      this.observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'data-dir', 'data-message-id', 'data-id', 'aria-label'],
      });
    }

    // Prime the seen-set so pre-existing history is not replayed as "new".
    const initial = this.read(doc);
    this.lastCount = initial.length;
    for (const m of initial) this.seen.add(m.key);
    this.lastConversationId = this.adapter.getConversation(doc)?.clientId ?? null;

    log.info('detector', 'observing', { roots: this.roots.length, primed: initial.length });
    // Emit the primed state so the UI can render immediately.
    this.events.onMessages([], initial);
  }

  stop(): void {
    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Re-resolves the observation roots — used after SPA navigation or a crash. */
  rescan(doc: Document = document): void {
    this.stop();
    this.start(doc);
  }

  /** Manual trigger (used by the debug overlay and tests). */
  poll(doc: Document = document): RawMessage[] {
    return this.process(doc);
  }

  private schedule(doc: Document): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.process(doc);
      } catch (err) {
        log.error('detector', 'processing failed; reconnecting observer', err);
        // A DOM change can invalidate our roots. Reconnect rather than die.
        this.rescan(doc);
      }
    }, this.debounceMs);
  }

  private resolveRoots(doc: Document): Element[] {
    try {
      const declared = this.adapter.observeRoots?.(doc) ?? [];
      const container = this.adapter.getMessageContainer(doc);
      const roots = [container, ...declared].filter(
        (el): el is Element => !!el && el.isConnected,
      );
      const unique = [...new Set(roots)];
      // If the container is missing, watch the body so we notice when it mounts.
      return unique.length ? unique : [doc.body].filter(Boolean);
    } catch {
      return [doc.body].filter(Boolean);
    }
  }

  private read(doc: Document): RawMessage[] {
    try {
      return this.adapter.getMessages(doc);
    } catch (err) {
      log.warn('detector', 'getMessages threw', err);
      return [];
    }
  }

  private process(doc: Document): RawMessage[] {
    const conversation = this.adapter.getConversation(doc);
    const clientId = conversation?.clientId ?? null;

    if (clientId !== this.lastConversationId) {
      log.info('detector', `conversation changed -> ${clientId ?? 'none'}`);
      this.seen.clear();
      this.lastConversationId = clientId;
      this.events.onConversationChange(clientId);
    }

    const all = this.read(doc);

    // A drop in count without a conversation change means the list was rebuilt
    // (virtualised list, or re-render). Keep the seen-set but do not treat the
    // re-render as new messages.
    if (all.length < this.lastCount && clientId === this.lastConversationId) {
      for (const m of all) this.seen.add(m.key);
      this.lastCount = all.length;
      return [];
    }
    this.lastCount = all.length;

    const fresh = all.filter((m) => !this.seen.has(m.key));
    if (fresh.length === 0) return [];

    for (const m of fresh) this.seen.add(m.key);

    // Collapse DOM duplication: the same text appearing twice within a tick is
    // almost always a mirrored node, not two real messages.
    const deduped = this.dedupe(fresh);
    log.debug('detector', `${deduped.length} new message(s)`, {
      directions: deduped.map((m) => m.direction),
    });

    if (deduped.length) this.events.onMessages(deduped, all);
    return deduped;
  }

  private dedupe(messages: RawMessage[]): RawMessage[] {
    const out: RawMessage[] = [];
    for (const m of messages) {
      const isDupe = out.some(
        (o) =>
          o.direction === m.direction &&
          (o.key === m.key ||
            (Math.abs(o.timestamp - m.timestamp) < 3000 && similarity(o.text, m.text) > 0.95)),
      );
      if (!isDupe) out.push(m);
    }
    return out;
  }

  /**
   * Resets internal state. Used when the user clears a conversation or when a
   * platform adapter is swapped at runtime.
   */
  reset(): void {
    this.seen.clear();
    this.lastCount = 0;
    this.lastConversationId = null;
  }

  /** Number of distinct messages observed since start — surfaced in diagnostics. */
  get seenCount(): number {
    return this.seen.size;
  }

  /** Exposed for tests: is this exact text already known? */
  hasSeen(text: string): boolean {
    const fp = fingerprint(text);
    for (const key of this.seen) {
      if (fingerprint(key).includes(fp) && fp.length > 0) return true;
    }
    return false;
  }

  /** Suppresses a message so it is never emitted (e.g. ROSE's own echo). */
  markSeen(message: RawMessage): void {
    this.seen.add(message.key);
    this.seen.add(normaliseText(message.text));
  }
}
