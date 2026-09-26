import type { PlatformId, RawMessage } from '@/shared/types';
import { normaliseText } from '@/shared/utils';
import { GenericChatAdapter } from '../generic/adapter';
import { COOMEET_CONFIG } from '../generic/config';
import { documentUrl } from '../types';

/**
 * CooMeet adapter.
 *
 * CooMeet is a WebRTC video-chat product: the conversation partner changes
 * without a page navigation ("Next" / skip), and the chat column is rebuilt
 * rather than re-rendered in place. Two consequences drive this adapter:
 *
 *  1. Conversation identity must key off the partner element, not the URL —
 *     the URL stays constant across partners. `getConversation` therefore
 *     prefers explicit partner ids and falls back to a name hash.
 *  2. On a partner switch the message list is emptied and refilled, so the
 *     caller must treat a sudden drop in message count as a new conversation
 *     rather than a deleted history.
 *
 * The adapter stays config-driven; all selectors are hints with the generic
 * heuristics underneath.
 */
export class CooMeetAdapter extends GenericChatAdapter {
  override readonly id: PlatformId = 'coomeet';
  override readonly label = 'CooMeet';

  constructor() {
    super(COOMEET_CONFIG);
  }

  override matches(url: URL): boolean {
    return /(^|\.)coomeet\.com$/i.test(url.hostname);
  }

  override score(doc: Document): number {
    if (!this.matches(documentUrl(doc))) return 0;
    // Base heuristics, but a recognised CooMeet shell raises confidence even
    // before the chat column mounts (the video stage loads first).
    const base = super.score(doc);
    const hasShell = !!doc.querySelector(
      '[class*="videoChat"], [class*="video-chat"], [class*="coomeet"], [data-testid*="video"], video',
    );
    return Math.min(1, base + (hasShell ? 0.25 : 0.05));
  }

  /**
   * CooMeet exposes the partner in the video stage header. We also read a
   * `data-partner-id`/`data-user-id` attribute when present because the name
   * alone is not unique across sessions.
   */
  override getConversation(doc: Document) {
    const base = super.getConversation(doc);
    if (!base) return null;

    const partnerEl = doc.querySelector(
      '[data-partner-id], [data-user-id], [class*="partner"][data-id], [class*="stranger"][data-id]',
    );
    const explicitId =
      partnerEl?.getAttribute('data-partner-id') ??
      partnerEl?.getAttribute('data-user-id') ??
      partnerEl?.getAttribute('data-id');

    const videoLabel = normaliseText(
      doc.querySelector('[class*="partnerName"], [class*="partner-name"], [class*="interlocutorName"]')
        ?.textContent ?? '',
    );

    const displayName = videoLabel || base.displayName;
    const clientId = explicitId || base.clientId;

    return {
      ...base,
      displayName,
      clientId,
      id: `${this.id}:${clientId}`,
      // CooMeet keeps one URL for the whole session, so the partner id is the
      // only stable conversation key. It is used verbatim — prefixing it would
      // double up when the id already carries the platform's own prefix.
      conversationId: explicitId ? `coomeet-partner-${explicitId.replace(/^partner-/, '')}` : base.conversationId,
    };
  }

  /**
   * CooMeet renders a "Stranger" placeholder bubble and typing indicators in
   * the same list as real messages; those must not reach the AI layer.
   */
  override getMessages(doc: Document): RawMessage[] {
    const messages = super.getMessages(doc);
    return messages.filter((m) => {
      if (m.direction === 'system') return false;
      const t = normaliseText(m.text).toLowerCase();
      if (!t) return false;
      if (/^(stranger|you|partner)$/.test(t)) return false;
      if (/^(is typing|typing|\.{3,}|печатает|печатает…)$/.test(t)) return false;
      if (/^(next|skip|start|stop|skip partner)$/.test(t) && t.length < 8) return false;
      return true;
    });
  }
}

