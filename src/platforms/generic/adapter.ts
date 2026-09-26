import type { ConversationRef, PlatformId, RawMessage } from '@/shared/types';
import { hashString, isVisible, normaliseText } from '@/shared/utils';
import { BaseAdapter, documentUrl, setNativeValue } from '../types';
import type { SiteConfig } from '../types';

export type { SiteConfig };

/**
 * GenericChatAdapter — heuristic engine that works on chat UIs it has never
 * seen. It never relies on a single CSS selector: each capability is resolved
 * by scoring many candidates against several independent signals.
 *
 * Signal priority (highest first):
 *   1. explicit site config supplied by the user (see config.ts)
 *   2. semantic attributes: data-testid, aria-label, role, placeholder
 *   3. structural heuristics: scrollable message list, bubble geometry
 *   4. behavioural heuristics: elements that grow with the message count
 */

const INPUT_HINTS =
  /(message|chat|reply|write|type|say|send|text|msg|prompt|comment|your message|écrire|envoyer|nachricht|mensaje|mensagem|сообщение|消息|メッセージ)/i;

const SEND_HINTS = /^(send|envoyer|senden|enviar|отправить|发送|送信|submit|➤|➔|▶)$/i;

const MESSAGE_CONTAINER_HINTS =
  /(messages?|chat[-_]?(log|list|body|history|window|messages|content|thread|feed|stream)|conversation|dialog|timeline|history|transcript|feed)/i;

// Navigation and control surfaces that score like a message list purely because
// they are repeated-child lists with "list"/"menu" in the name. Found live on
// flirtify.com: the language picker `ul.language-dropdown__list` was returned as
// the message container. A real message log is never classed "dropdown"/"navbar".
const NON_CONTAINER_HINTS = /(dropdown|nav[-_]?bar|navbar|breadcrumb|menu|tab[-_]?list|accordion|carousel|pagination|toolbar)/i;

const INCOMING_HINTS =
  /(incoming|inbound|received|them|other|partner|client|stranger|guest|peer|left|remote|message[-_]?in)/i;
const OUTGOING_HINTS = /(outgoing|outbound|sent|self|own|mine|right|message[-_]?out)/i;

// Chat UIs put toolbar and composer controls inside the message container. They
// are text-bearing, visible, and often classed "…-button", so they would
// otherwise be harvested as messages and answered as if a client wrote them.
const CONTROL_HINTS = /(button|toolbar|composer|actions?|controls?|icon|emoji|attach|upload|menu)/i;

const NEGATIVE_INPUT_HINTS = /(search|recherche|find|filter|username|password|email|login|signup|captcha|code|phone|name)/i;

// Timestamps, delivery state and other per-message chrome. Excluded from the
// text so the model is not asked to answer a clock.
const META_HINTS = /(^|[-_])(time|timestamp|date|meta|badge|status|delivered|read|seen|edited)([-_]|$)/i;

// The author label. Reported separately as `author`, so it must not also be
// folded into the message text.
const AUTHOR_HINTS = /(^|[-_])(author|username|user|sender|nick|nickname|name|who|from)([-_]|$)/i;

// Single-token direction markers. Chat UIs very commonly use just `in` / `out`,
// which the substring hints above cannot express without matching every word
// containing those two letters.
const INCOMING_TOKEN = /^(in|incoming|inbound|them|other|received|remote|guest|client|partner|left)$/i;
const OUTGOING_TOKEN = /^(out|outgoing|outbound|me|self|sent|mine|own|right)$/i;

export class GenericChatAdapter extends BaseAdapter {
  readonly id: PlatformId = 'generic';
  readonly label: string = 'Generic chat';
  protected config: SiteConfig | null;

  /** Cached per-document resolutions; invalidated when the DOM changes shape. */
  private cache = new WeakMap<
    Document,
    { container: Element | null; input: HTMLElement | null; at: number; hinted: boolean }
  >();

  constructor(config: SiteConfig | null = null) {
    super();
    this.config = config;
  }

  override matches(url: URL): boolean {
    if (!this.config) return true; // generic always applies as a fallback
    return this.config.hosts.some((h) => matchHost(url.hostname, h));
  }

  override score(doc: Document): number {
    if (this.config && this.matches(documentUrl(doc))) return 0.95;
    // Generic adapter confidence is derived from how many capabilities resolve.
    let score = 0;
    if (this.resolveInput(doc)) score += 0.45;
    if (this.resolveContainer(doc)) score += 0.35;
    if (this.findMessageCandidates(doc).length > 0) score += 0.2;
    return Math.min(score, 0.9);
  }

  // -------------------------------------------------------------------------
  // Input resolution
  // -------------------------------------------------------------------------

  override getInput(doc: Document): HTMLElement | null {
    return this.resolveInput(doc);
  }

  private resolveInput(doc: Document): HTMLElement | null {
    const cached = this.cache.get(doc);
    if (cached && cached.input?.isConnected && Date.now() - cached.at < 5000) return cached.input;

    const candidates = this.collectInputCandidates(doc);
    let best: { el: HTMLElement; score: number } | null = null;

    for (const el of candidates) {
      const s = this.scoreInput(el, doc);
      if (s > 0 && (!best || s > best.score)) best = { el, score: s };
    }

    const input = best?.el ?? null;
    // Preserve the container decision: this write used to drop `hinted`, so
    // after the first input resolution ROSE forgot that its message container
    // was confidently identified and started reporting page chrome as messages.
    this.cache.set(doc, { ...(cached ?? { container: null, hinted: false }), input, at: Date.now() });
    return input;
  }

  private collectInputCandidates(doc: Document): HTMLElement[] {
    const out: HTMLElement[] = [];
    const push = (el: Element | null) => {
      if (el instanceof HTMLElement) out.push(el);
    };

    if (this.config?.input) {
      for (const sel of this.config.input) doc.querySelectorAll(sel).forEach(push);
    }
    doc.querySelectorAll('textarea').forEach(push);
    doc.querySelectorAll('input[type="text"], input[type="search"], input:not([type])').forEach(push);
    doc.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach(push);
    doc.querySelectorAll('[role="textbox"]').forEach(push);
    return out;
  }

  private scoreInput(el: HTMLElement, doc: Document): number {
    if (el.closest('#rose-root, #rose-shadow-host')) return -1; // never our own UI
    if (!isVisible(el)) return -1;
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) return -1;
    if (el.getAttribute('aria-hidden') === 'true') return -1;

    const attrText = [
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('data-placeholder'),
      el.getAttribute('data-testid'),
      el.getAttribute('name'),
      el.getAttribute('title'),
      el.getAttribute('class'),
      el.id,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (NEGATIVE_INPUT_HINTS.test(attrText) && !INPUT_HINTS.test(attrText)) return -1;

    let score = 0;
    if (this.config?.input?.some((sel) => safeMatches(el, sel))) score += 1.0;
    if (INPUT_HINTS.test(attrText)) score += 0.5;
    if (el.isContentEditable) score += 0.15;
    if (el.tagName === 'TEXTAREA') score += 0.1;
    if (el.getAttribute('role') === 'textbox') score += 0.1;

    // Geometry: a chat composer sits low on the page and is reasonably wide.
    const rect = el.getBoundingClientRect();
    if (rect.width > 120) score += 0.15;
    const viewportH = doc.defaultView?.innerHeight ?? 800;
    if (rect.top > viewportH * 0.45) score += 0.2;
    if (rect.width > 0 && rect.height > 0) score += 0.05;

    // Nearest interactive sibling being a send-like button is a strong signal.
    if (this.findNearbySend(el)) score += 0.4;

    return score;
  }

  // -------------------------------------------------------------------------
  // Send button
  // -------------------------------------------------------------------------

  override getSendButton(doc: Document): HTMLElement | null {
    const input = this.resolveInput(doc);
    const near = input ? this.findNearbySend(input) : null;
    if (near) return near;
    if (this.config?.sendButton) {
      for (const sel of this.config.sendButton) {
        const el = doc.querySelector(sel);
        if (el instanceof HTMLElement && isVisible(el)) return el;
      }
    }
    return this.findGlobalSend(doc);
  }

  private findNearbySend(input: HTMLElement): HTMLElement | null {
    let node: Element | null = input;
    for (let depth = 0; depth < 4 && node; depth++) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const buttons = Array.from(
        parent.querySelectorAll('button, [role="button"], [type="submit"], a[href="#"], svg'),
      ).filter((el): el is HTMLElement => el instanceof HTMLElement && el !== input);
      for (const b of buttons) {
        if (this.looksLikeSend(b)) return b instanceof SVGElement ? (b.parentElement as HTMLElement) ?? b : b;
      }
      node = parent;
    }
    return null;
  }

  private findGlobalSend(doc: Document): HTMLElement | null {
    const all = Array.from(doc.querySelectorAll('button, [role="button"], [type="submit"]'));
    let best: { el: HTMLElement; score: number } | null = null;
    const viewportH = doc.defaultView?.innerHeight ?? 800;
    for (const el of all) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      if (el.closest('#rose-root, #rose-shadow-host')) continue;
      let s = 0;
      if (this.looksLikeSend(el)) s += 0.6;
      const rect = el.getBoundingClientRect();
      if (rect.top > viewportH * 0.5) s += 0.3;
      if (rect.left > (doc.defaultView?.innerWidth ?? 1200) * 0.5) s += 0.1;
      if (s > 0.6 && (!best || s > best.score)) best = { el, score: s };
    }
    return best?.el ?? null;
  }

  private looksLikeSend(el: HTMLElement): boolean {
    if (el.closest('#rose-root, #rose-shadow-host')) return false;
    const text = normaliseText(el.textContent ?? '');
    const attr = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.getAttribute('name'),
      el.className?.toString(),
    ]
      .filter(Boolean)
      .join(' ');
    if (SEND_HINTS.test(text)) return true;
    if (/(send|submit|envoyer|senden|enviar|отправ|送信|发送)/i.test(attr)) return true;
    // Icon-only send buttons: paper-plane / arrow glyphs inside an svg.
    const svgText = el.querySelector('svg')?.getAttribute('class') ?? '';
    if (/(send|paper|plane|arrow)/i.test(svgText)) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Message container + messages
  // -------------------------------------------------------------------------

  override getMessageContainer(doc: Document): Element | null {
    return this.resolveContainer(doc);
  }

  private resolveContainer(doc: Document): Element | null {
    const cached = this.cache.get(doc);
    if (cached?.container?.isConnected && Date.now() - cached.at < 5000) return cached.container;

    if (this.config?.messageContainer) {
      for (const sel of this.config.messageContainer) {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) {
          this.cache.set(doc, { container: el, input: cached?.input ?? null, at: Date.now(), hinted: true });
          return el;
        }
      }
    }

    const best = this.pickContainer(doc);
    this.cache.set(doc, {
      container: best?.el ?? null,
      input: cached?.input ?? null,
      at: Date.now(),
      hinted: best?.hinted ?? false,
    });
    return best?.el ?? null;
  }

  /**
   * Chooses the message list, preferring a structural match over a text hint.
   *
   * A hint match alone is not enough: a decorative header chip classed
   * "fixture D · dynamic, virtualised" satisfies MESSAGE_CONTAINER_HINTS via
   * "…dynamic…" and sits above the composer, so it can outscore the real, empty
   * message log. An empty list is a legitimate state (nobody has written yet),
   * and returning the chip instead means ROSE reports the page chrome as the
   * client's message. A container that actually holds repeated message-shaped
   * children therefore wins.
   */
  private pickContainer(doc: Document): { el: Element; hinted: boolean } | null {
    const scored = this.scoreContainers(doc);
    if (!scored.length) return null;

    const input = this.resolveInput(doc);
    const holdsMessages = (el: Element): boolean =>
      this.findMessageLikeWithin(el, input).length > 0;

    const structural = scored.find((c) => holdsMessages(c.el));
    if (structural) return { el: structural.el, hinted: true };

    // Nothing on the page holds message-shaped children, so any container here is
    // a guess from layout alone. On a live marketing page that guess landed on the
    // language picker and the FAQ list, and ROSE reported page chrome as the
    // client's conversation. Accept the guess only when it is both strong and
    // anchored to a reply field — a chat ROSE can act on always has a composer.
    const best = scored[0]!;
    if (!input || best.score < 0.6) return null;
    return { el: best.el, hinted: true };
  }

  /** Message-shaped elements inside a candidate container. */
  private findMessageLikeWithin(container: Element, input: HTMLElement | null): HTMLElement[] {
    const out: HTMLElement[] = [];
    container.querySelectorAll('*').forEach((el) => {
      if (el instanceof HTMLElement && this.isMessageLike(el, input)) out.push(el);
    });
    return dedupeNested(out);
  }

  private scoreContainers(doc: Document): Array<{ el: Element; score: number }> {
    const out: Array<{ el: Element; score: number }> = [];
    const input = this.resolveInput(doc);
    const inputTop = input?.getBoundingClientRect().top ?? Infinity;

    for (const el of doc.querySelectorAll('div, section, ul, ol, main, aside, table, dl')) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      if (el.closest('#rose-root, #rose-shadow-host')) continue;

      const attr = [
        el.id,
        el.className?.toString(),
        el.getAttribute('data-testid'),
        el.getAttribute('role'),
        el.getAttribute('aria-label'),
      ]
        .filter(Boolean)
        .join(' ');

      // A language picker is a list of repeated children and outscores an empty
      // message log on structure alone, so rule these out before scoring.
      if (NON_CONTAINER_HINTS.test(attr)) continue;

      const declaredContainer =
        el.getAttribute('role') === 'log' || !!el.getAttribute('aria-live') || MESSAGE_CONTAINER_HINTS.test(attr);

      // A conversation can legitimately hold a single message (the first one
      // ever sent), and an empty one is the normal state before anybody writes.
      // Skipping childless elements outright meant an empty log was never even
      // considered, so the page header won the vote instead. Childless elements
      // still need to look like a container to qualify.
      if (el.children.length < 1 && !declaredContainer) continue;

      let score = 0;

      if (MESSAGE_CONTAINER_HINTS.test(attr)) score += 0.45;
      if (el.getAttribute('role') === 'log') score += 0.5;
      if (el.getAttribute('aria-live')) score += 0.35;

      // Sits above the composer.
      const rect = el.getBoundingClientRect();
      if (rect.top < inputTop && rect.bottom <= inputTop + 40) score += 0.2;

      // Scrollable list of repeated children.
      const style = doc.defaultView ? doc.defaultView.getComputedStyle(el) : null;
      if (style && /(auto|scroll)/.test(style.overflowY)) score += 0.25;

      const childCount = el.children.length;
      if (childCount >= 3) score += 0.15;
      if (childCount >= 6) score += 0.1;

      // Repeated sibling structure is the signature of a message list.
      if (this.hasRepeatedChildren(el)) score += 0.2;

      // Penalise containers that swallow the whole page.
      if (rect.height > (doc.defaultView?.innerHeight ?? 800) * 0.95) score -= 0.25;

      if (score > 0.3) out.push({ el, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  private hasRepeatedChildren(el: Element): boolean {
    const kids = Array.from(el.children);
    if (kids.length < 3) return false;
    const sig = new Map<string, number>();
    for (const k of kids) {
      const key = `${k.tagName}|${k.className?.toString().split(/\s+/).slice(0, 2).join('.')}`;
      sig.set(key, (sig.get(key) ?? 0) + 1);
    }
    return [...sig.values()].some((n) => n >= 3);
  }

  override getMessages(doc: Document): RawMessage[] {
    const container = this.resolveContainer(doc);
    const candidates = this.findMessageCandidates(doc, container);
    return candidates.map((c) => this.toRawMessage(c, doc)).filter((m): m is RawMessage => m !== null);
  }

  private findMessageCandidates(doc: Document, container?: Element | null): HTMLElement[] {
    const scope = container ?? this.resolveContainer(doc) ?? doc.body;
    if (!scope) return [];

    if (this.config?.incomingMessage || this.config?.outgoingMessage) {
      const sels = [...(this.config.incomingMessage ?? []), ...(this.config.outgoingMessage ?? [])];
      const found: HTMLElement[] = [];
      for (const sel of sels) {
        scope.querySelectorAll(sel).forEach((el) => {
          if (el instanceof HTMLElement) found.push(el);
        });
      }
      // Each selector is queried separately, so the results must be re-sorted
      // into document order — otherwise incoming and outgoing messages come back
      // grouped by selector instead of interleaved as they were sent.
      if (found.length) return sortDocumentOrder(found);
    }

    // Leaf-ish nodes that hold text and are not the composer. The walk starts
    // from the *document*, not from the container: `dedupeNested` keeps the
    // outermost match, so scoping the walk to the container is what made a whole
    // chat pane win over the individual bubbles inside it.
    const input = this.resolveInput(doc);
    const out: HTMLElement[] = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;
    while (node) {
      const el = node as HTMLElement;
      if (el !== doc.body && this.isMessageLike(el, input)) out.push(el);
      node = walker.nextNode();
    }

    // Prefer messages that live inside the resolved message list — that is what
    // separates real bubbles from page chrome such as a header chip that happens
    // to be text in a rounded box.
    //
    // The fallback to unscoped results only applies when the container was not
    // confidently identified. If we *are* confident and the list is empty, the
    // honest answer is "no messages yet": a chat that has not started must not
    // be reported as containing the page header.
    const confident = this.cache.get(doc)?.hinted ?? false;
    const scoped = container ? out.filter((el) => container.contains(el)) : [];
    if (scoped.length) return dedupeNested(scoped);
    if (confident) return [];
    // Unscoped results are the last resort for a chat ROSE cannot structure. They
    // are only meaningful if the page has a reply field: without a composer there
    // is no conversation here, and on coomeet.com/flirtify.com this fallback
    // returned nav items and marketing copy ("Europe", "9+ million users") as the
    // client's messages.
    return input ? dedupeNested(out) : [];
  }

  private isMessageLike(el: HTMLElement, input: HTMLElement | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    if (el.closest('#rose-root, #rose-shadow-host')) return false;
    if (input && (el === input || el.contains(input))) return false;
    if (!isVisible(el)) return false;

    // Toolbars, composer rows and send buttons sit inside the message list on
    // most chat UIs and carry text, so they must be excluded explicitly.
    if (el.matches('button, [role="button"], [role="toolbar"], [role="menu"]')) return false;
    if (CONTROL_HINTS.test(el.className?.toString() ?? '')) return false;

    // Must have a direct text payload.
    const ownText = directText(el);
    if (!ownText || ownText.length < 1) return false;

    const attr = [
      el.className?.toString(),
      el.getAttribute('data-testid'),
      el.getAttribute('data-message-id'),
      el.getAttribute('data-id'),
      el.getAttribute('role'),
      el.getAttribute('aria-label'),
    ]
      .filter(Boolean)
      .join(' ');

    const hasDirectionHint =
      INCOMING_HINTS.test(attr) || OUTGOING_HINTS.test(attr) || /(message|msg|bubble|chat)/i.test(attr);
    const hasId = !!(el.getAttribute('data-message-id') || el.getAttribute('data-id'));
    const roleListItem = el.getAttribute('role') === 'listitem';
    // Table- and list-based logs put each message in a row: a <tr> with a single
    // cell is a message body, not page chrome.
    const tableRow = el.tagName === 'TR' && el.children.length <= 2;

    if (hasDirectionHint || hasId || roleListItem || tableRow) return true;

    // Structural fallback: a text block inside a bubble-shaped box.
    const rect = el.getBoundingClientRect();
    if (rect.width > 30 && rect.height > 12 && rect.height < 400) {
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      if (style && parseFloat(style.borderRadius || '0') >= 6) return true;
    }
    return false;
  }

  private toRawMessage(el: HTMLElement, doc: Document): RawMessage | null {
    const text = normaliseText(extractMessageText(el));
    if (!text) return null;

    const attr = [el.className?.toString(), el.getAttribute('data-testid'), el.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ');

    let direction: RawMessage['direction'] = 'incoming';
    if (this.config) {
      if (this.config.outgoingMessage?.some((sel) => safeMatches(el, sel))) direction = 'outgoing';
      else if (this.config.incomingMessage?.some((sel) => safeMatches(el, sel))) direction = 'incoming';
      else direction = this.inferDirection(el, doc, attr);
    } else {
      direction = this.inferDirection(el, doc, attr);
    }

    if (/system|notice|typing|joined|left the|has left/i.test(attr)) direction = 'system';

    const nativeId =
      el.getAttribute('data-message-id') ??
      el.getAttribute('data-id') ??
      el.getAttribute(this.config?.idAttribute ?? 'data-msg-id');

    const author = this.extractAuthor(el);

    return {
      key: nativeId ?? hashString(`${direction}:${text}:${this.indexHint(el)}`),
      text,
      direction,
      author,
      timestamp: extractTimestamp(el) ?? Date.now(),
      nativeId: nativeId ?? null,
    };
  }

  private indexHint(el: HTMLElement): string {
    const siblings = el.parentElement ? Array.from(el.parentElement.children) : [];
    return `${el.tagName}#${siblings.indexOf(el)}`;
  }

  /**
   * Direction inference uses four independent signals and votes.
   * Geometry alone is unreliable on RTL or centred layouts, so class/ARIA
   * hints and data attributes outweigh position.
   */
  private inferDirection(el: HTMLElement, doc: Document, attr: string): RawMessage['direction'] {
    if (OUTGOING_HINTS.test(attr) && !INCOMING_HINTS.test(attr)) return 'outgoing';
    if (INCOMING_HINTS.test(attr) && !OUTGOING_HINTS.test(attr)) return 'incoming';

    // Read direction off individual class/id tokens rather than the joined
    // string. A class list such as "msg in" carries an incoming marker, but
    // concatenated it also matches `me` (inside "msg") and `own`, so the
    // OUTGOING test above claimed it and every client message was labelled as
    // ours — which meant ROSE never saw an incoming message to answer.
    for (const token of classNameTokens(el)) {
      if (INCOMING_TOKEN.test(token)) return 'incoming';
      if (OUTGOING_TOKEN.test(token)) return 'outgoing';
    }

    let votes = 0;
    const rect = el.getBoundingClientRect();
    const width = doc.defaultView?.innerWidth ?? 1200;
    if (rect.width > 0) {
      if (rect.left > width * 0.45) votes += 1;
      if (rect.right < width * 0.55) votes -= 1;
      // Own bubbles are usually narrower and hugging the edge.
      if (rect.width < width * 0.6 && rect.left > width * 0.35) votes += 1;
    }
    const style = doc.defaultView?.getComputedStyle(el);
    if (style) {
      if (style.textAlign === 'right') votes += 1;
      if (style.textAlign === 'left') votes -= 1;
      if (style.marginLeft === 'auto') votes += 1;
      if (style.marginRight === 'auto') votes -= 1;
      if (/rgb\(0,\s*0,\s*0\)|rgba\(0,\s*0,\s*0/.test(style.backgroundColor)) {
        /* dark neutral backgrounds carry no direction signal */
      } else if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        votes += 0;
      }
    }
    return votes > 0 ? 'outgoing' : 'incoming';
  }

  private extractAuthor(el: HTMLElement): string | null {
    if (this.config?.author) {
      for (const sel of this.config.author) {
        const found = el.querySelector(sel);
        const t = normaliseText(found?.textContent ?? '');
        if (t) return t;
      }
    }
    for (const sel of ['[data-author]', '[data-username]', '.author', '.username', '.name', 'cite', 'strong']) {
      const found = el.querySelector(sel);
      const t = normaliseText(found?.textContent ?? '');
      if (t && t.length < 60) return t;
    }
    const labelled = el.getAttribute('data-author') ?? el.getAttribute('aria-label');
    return labelled ? normaliseText(labelled) : null;
  }

  // -------------------------------------------------------------------------
  // Conversation identity
  // -------------------------------------------------------------------------

  override getConversation(doc: Document): ConversationRef | null {
    const container = this.resolveContainer(doc);
    const messages = container ? this.getMessages(doc) : [];
    if (!container && messages.length === 0) return null;

    const host = documentUrl(doc).hostname;
    const name = this.resolveDisplayName(doc);
    const clientId = this.resolveClientId(doc, name);

    return {
      id: `${this.id}:${clientId}`,
      platform: this.id,
      clientId,
      displayName: name,
      conversationId: this.resolveConversationId(doc),
      url: documentUrl(doc).href,
      avatarUrl: this.resolveAvatar(doc),
      language: null,
    };
  }

  private resolveDisplayName(doc: Document): string {
    for (const sel of [
      '[data-testid*="partner-name"]',
      '[data-testid*="username"]',
      '[class*="partner"][class*="name"]',
      '[class*="interlocutor"]',
      '[class*="companion"]',
      '[class*="stranger"][class*="name"]',
      'header h1',
      'header h2',
      '[class*="chat"][class*="header"] h1',
      '[class*="chat"][class*="header"] h2',
      '[class*="user"][class*="name"]',
      '[class*="display"][class*="name"]',
    ]) {
      const el = doc.querySelector(sel);
      const t = normaliseText(el?.textContent ?? '');
      if (t && t.length > 0 && t.length < 48 && !/^(chat|messages?|conversation)$/i.test(t)) return t;
    }
    return 'Unknown';
  }

  private resolveClientId(doc: Document, name: string): string {
    for (const sel of ['[data-user-id]', '[data-client-id]', '[data-partner-id]', '[data-uid]']) {
      const el = doc.querySelector(sel);
      const v =
        el?.getAttribute('data-user-id') ??
        el?.getAttribute('data-client-id') ??
        el?.getAttribute('data-partner-id') ??
        el?.getAttribute('data-uid');
      if (v) return v;
    }
    // A URL slug beats the name hash: two clients can share a display name, and
    // the slug is what actually changes when the conversation does. The last
    // path segment is the id — matching a keyword followed by a segment would
    // capture the keyword itself ("/chat/user/abc" -> "user").
    const segments = documentUrl(doc).pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && /^[A-Za-z0-9_-]{4,}$/.test(last) && !RESERVED_SLUGS.has(last.toLowerCase())) {
      return last;
    }
    return hashString(`${documentUrl(doc).hostname}|${name}`).slice(0, 12);
  }

  private resolveConversationId(doc: Document): string {
    const el = doc.querySelector('[data-conversation-id], [data-chat-id], [data-room-id]');
    const v =
      el?.getAttribute('data-conversation-id') ??
      el?.getAttribute('data-chat-id') ??
      el?.getAttribute('data-room-id');
    if (v) return v;
    return (doc.location?.href ?? '').split('#')[0];
  }

  private resolveAvatar(doc: Document): string | null {
    for (const sel of [
      '[class*="partner"] img',
      '[class*="avatar"] img',
      'header img[src]',
      '[class*="chat"][class*="header"] img',
    ]) {
      const img = doc.querySelector(sel) as HTMLImageElement | null;
      if (img?.src && !img.src.startsWith('data:image/svg')) return img.src;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  insertText(input: HTMLElement, text: string): boolean {
    const ok = setNativeValue(input, text);
    if (ok) input.focus();
    return ok;
  }

  override async send(input: HTMLElement): Promise<boolean> {
    const button = this.getSendButton(input.ownerDocument);
    if (button) {
      const { clickElement } = await import('../types');
      clickElement(button);
      return true;
    }
    if (this.config?.sendWithEnter ?? true) {
      const { pressEnter } = await import('../types');
      pressEnter(input);
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
/**
 * Sorts elements into document order.
 *
 * `querySelectorAll` on a set of selectors returns matches grouped by selector,
 * so merging several selector results requires an explicit re-sort to recover
 * the order the messages were actually sent in.
 */
function sortDocumentOrder(elements: HTMLElement[]): HTMLElement[] {
  return elements.sort((a, b) => {
    const rel = a.compareDocumentPosition(b);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

/** Path segments that name a route rather than a person. */
const RESERVED_SLUGS = new Set([
  'chat', 'chats', 'user', 'users', 'room', 'rooms', 'profile', 'profiles',
  'model', 'models', 'conversation', 'conversations', 'messages', 'message',
  'index', 'home', 'login', 'signup', 'register', 'settings', 'app', 'www',
]);

// ---------------------------------------------------------------------------


function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

export function matchHost(hostname: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/^\*\./, '');
  const h = hostname.toLowerCase();
  return h === p || h.endsWith(`.${p}`);
}

/**
 * Splits an element's class list and id into individual tokens.
 *
 * Direction hints must be tested per token: "msg in" is an incoming bubble, but
 * as one joined string it also contains "me" and "own" from OUTGOING_HINTS and
 * would be misread as ours.
 */
function classNameTokens(el: HTMLElement): string[] {
  const classes = (el.className?.toString() ?? '').split(/\s+/).filter(Boolean);
  if (el.id) classes.push(el.id);
  return classes;
}

/** Text held directly by the element, excluding nested block elements' text. */
function directText(el: HTMLElement): string {
  const pieces: string[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const piece = normaliseText(node.textContent ?? '');
      if (piece) pieces.push(piece);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const child = node as HTMLElement;
    if (child.tagName === 'BR') continue;

    const classes = child.className?.toString() ?? '';
    // The author label is reported separately as `author`; leaving it in the
    // text sent to the model produced prompts like "SophieDo you remember…",
    // where the name ran straight into the client's words.
    if (AUTHOR_HINTS.test(classes)) continue;
    // Timestamps and status badges are chrome, not the client's words.
    if (META_HINTS.test(classes)) continue;

    // Inline children contribute to the same text run. Table cells are included
    // because legacy chat widgets put each message in a single <td>, and without
    // them the row looks textless and is never detected.
    if (
      /^(SPAN|B|I|EM|STRONG|A|CODE|SMALL|U|MARK|TIME|TD|TH|P|LABEL)$/.test(child.tagName) &&
      child.children.length === 0
    ) {
      const piece = normaliseText(child.textContent ?? '');
      if (piece) pieces.push(piece);
    }
  }
  // Join with a space: adjacent runs would otherwise fuse into one word.
  return normaliseText(pieces.join(' '));
}

function extractMessageText(el: HTMLElement): string {
  const direct = directText(el);
  if (direct.length >= 2) return direct;
  const full = normaliseText(el.textContent ?? '');
  if (full) return full;
  const img = el.querySelector('img[alt]');
  return img?.getAttribute('alt') ?? '';
}

function extractTimestamp(el: HTMLElement): number | null {
  for (const sel of ['time', '[datetime]', '[data-timestamp]', '[data-time]', '[class*="time"]']) {
    const found = el.querySelector(sel) ?? (safeMatches(el, sel) ? el : null);
    if (!found) continue;
    const dt = found.getAttribute?.('datetime') ?? found.getAttribute?.('data-timestamp');
    if (dt) {
      const parsed = /^\d+$/.test(dt) ? Number(dt) * (dt.length <= 10 ? 1000 : 1) : Date.parse(dt);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Removes ancestors that contain another candidate, keeping the innermost node
 * so a bubble is not counted once per wrapper level.
 */
function dedupeNested(nodes: HTMLElement[]): HTMLElement[] {
  const set = new Set(nodes);
  return nodes.filter((n) => {
    let p = n.parentElement;
    while (p) {
      if (set.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });
}
