import type { PlatformId, RawMessage } from '@/shared/types';
import { normaliseText } from '@/shared/utils';
import { GenericChatAdapter } from '../generic/adapter';
import { FLIRTIFY_CONFIG } from '../generic/config';
import { documentUrl } from '../types';

/**
 * Flirtify adapter.
 *
 * Flirtify is a SPA whose chat lives in a client-rendered panel. Distinguishing
 * features handled here:
 *
 *  1. Conversation switching happens through in-app navigation, so the message
 *     container is replaced rather than cleared. We key identity off the
 *     profile slug in the URL when present.
 *  2. The editor is a `contenteditable` rich-text field, so insertion must go
 *     through the contenteditable path (handled by the generic writer).
 *  3. Media/gift/system cards render as bubbles without a text payload; they
 *     are filtered out so they never reach the model.
 */
export class FlirtifyAdapter extends GenericChatAdapter {
  override readonly id: PlatformId = 'flirtify';
  override readonly label = 'Flirtify';

  constructor() {
    super(FLIRTIFY_CONFIG);
  }

  override matches(url: URL): boolean {
    return /(^|\.)flirtify\.com$/i.test(url.hostname);
  }

  override score(doc: Document): number {
    if (!this.matches(documentUrl(doc))) return 0;
    const base = super.score(doc);
    const hasShell = !!doc.querySelector(
      '[class*="profile"], [class*="model"], [class*="chat"], [data-testid*="profile"]',
    );
    return Math.min(1, base + (hasShell ? 0.2 : 0.05));
  }

  /**
   * Flirtify serves a chat at `/streams/<slug>` and profile pages at
   * `/shorts/<slug>`; older builds used `/profile/<slug>` or `/chat/<id>`.
   * The slug is what changes when the conversation does, so it is the identity
   * key. Verified live against all three stream pages probed in Phase 7.
   */
  override getConversation(doc: Document) {
    const base = super.getConversation(doc);
    if (!base) return null;

    const href = documentUrl(doc).href;
    const slug = href.match(/\/(?:streams|shorts|profile|model|chat|room|user)\/([A-Za-z0-9_-]{2,})/i)?.[1];
    // `chattingWith` is the name rendered in the chat panel itself, which is the
    // conversation actually open. `displayName` is the profile heading and also
    // exists on chat-less pages, so it is the fallback.
    const nameEl =
      doc.querySelector('[data-testid="chattingWith"]') ??
      doc.querySelector('[data-testid="displayName"]') ??
      doc.querySelector(
        '[data-testid*="profile-name"], [class*="profile"][class*="name"], [class*="model"][class*="name"], [class*="nickname"]',
      );
    const displayName = normaliseText(nameEl?.textContent ?? '') || base.displayName;
    const clientId = slug || base.clientId;

    return {
      ...base,
      displayName,
      clientId,
      id: `${this.id}:${clientId}`,
      // Keyed off the slug, not the document URL: the base resolver returns the
      // raw href, which is unstable (query strings, trailing slashes) and made
      // the same conversation look like a different one after a navigation.
      conversationId: slug ? `flirtify-${slug}` : base.conversationId,
      url: href,
    };
  }

  /** Drops gift/media/system bubbles that carry no conversational text. */
  override getMessages(doc: Document): RawMessage[] {
    return super.getMessages(doc).filter((m) => {
      if (m.direction === 'system') return false;
      const t = normaliseText(m.text);
      if (!t) return false;
      if (/^\[(image|video|gift|sticker|photo)\]$/i.test(t)) return false;
      if (/^(sent a gift|sent you|is typing|typing|online|offline)$/i.test(t)) return false;
      return true;
    });
  }
}

