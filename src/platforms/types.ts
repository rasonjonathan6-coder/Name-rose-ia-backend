import type { ConversationRef, PlatformId, RawMessage } from '@/shared/types';

/**
 * Per-site selector hints.
 *
 * Hints, not requirements: the generic heuristics still run when a hint stops
 * matching after a site redesign, so a stale config degrades rather than breaks.
 */
export interface SiteConfig {
  /** Hostname patterns this config applies to, e.g. ["*.example.com"]. */
  hosts: string[];
  messageContainer?: string[];
  incomingMessage?: string[];
  outgoingMessage?: string[];
  author?: string[];
  input?: string[];
  sendButton?: string[];
  conversationRoot?: string[];
  /** Attribute used as the stable message id, if the site provides one. */
  idAttribute?: string;
  /** Set when the site needs Enter to send rather than a button. */
  sendWithEnter?: boolean;
}

/**
 * A platform adapter is the ONLY place that knows about a site's DOM.
 * Everything else (conversation engine, AI, memory, automation) is site-agnostic.
 */
export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly label: string;

  /** Cheap synchronous hostname test. */
  matches(url: URL): boolean;

  /**
   * Score 0..1 for how confident we are this adapter fits the current page.
   * Used to pick between several candidate adapters.
   */
  score(doc: Document): number;

  /** Resolves the current conversation, or null when none is open yet. */
  getConversation(doc: Document): ConversationRef | null;

  /** All messages currently rendered, oldest first. */
  getMessages(doc: Document): RawMessage[];

  /** The element new messages will appear inside. */
  getMessageContainer(doc: Document): Element | null;

  /** The editable reply target (textarea / input / contenteditable). */
  getInput(doc: Document): HTMLElement | null;

  /** The send control, when one exists and is discoverable. */
  getSendButton(doc: Document): HTMLElement | null;

  /** Writes text into the reply field. Returns false if it could not. */
  insertText(input: HTMLElement, text: string): boolean;

  /**
   * Clicks/fires the send control. Returns false when the site cannot be
   * automated safely (adapter may leave sending to the human).
   */
  send(input: HTMLElement): Promise<boolean>;

  /** Optional: narrows the MutationObserver to reduce main-thread work. */
  observeRoots?(doc: Document): Element[];
}

/** Base class providing no-op defaults so adapters only override what differs. */
export abstract class BaseAdapter implements PlatformAdapter {
  abstract readonly id: PlatformId;
  abstract readonly label: string;

  abstract matches(url: URL): boolean;

  score(doc: Document): number {
    return this.matches(new URL(doc.location?.href || 'http://localhost/')) ? 0.6 : 0;
  }

  abstract getConversation(doc: Document): ConversationRef | null;
  abstract getMessages(doc: Document): RawMessage[];

  getMessageContainer(doc: Document): Element | null {
    return doc.body;
  }

  abstract getInput(doc: Document): HTMLElement | null;

  getSendButton(_doc: Document): HTMLElement | null {
    return null;
  }

  abstract insertText(input: HTMLElement, text: string): boolean;

  async send(input: HTMLElement): Promise<boolean> {
    const button = this.getSendButton(input.ownerDocument);
    if (!button) return false;
    clickElement(button);
    return true;
  }

  observeRoots(doc: Document): Element[] {
    const container = this.getMessageContainer(doc);
    return container ? [container] : [];
  }
}

/**
 * Resolves the document's URL.
 *
 * Prefers the browsing context (`defaultView.location`) over `document.location`:
 * the two are identical in a real page, but the browsing context is the one that
 * reflects SPA navigation reliably and the only one that can be substituted in a
 * DOM test environment.
 */
export function documentUrl(doc: Document): URL {
  const href = doc.defaultView?.location?.href ?? doc.location?.href ?? 'http://localhost/';
  try {
    return new URL(href);
  } catch {
    return new URL('http://localhost/');
  }
}

/**
 * Dispatches a realistic click. Plain `el.click()` is ignored by many React
 * handlers that listen for pointer events, so we send the full sequence.
 */
export function clickElement(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView ?? undefined };
  el.dispatchEvent(new PointerEvent('pointerdown', opts as PointerEventInit));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts as PointerEventInit));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

/**
 * Writes into an input in the way the framework expects: set the native value
 * through the prototype setter, then fire input/change so React/Vue state syncs.
 */
export function setNativeValue(el: HTMLElement, value: string): boolean {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;

  if (el instanceof (win as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }).HTMLTextAreaElement ||
      el instanceof (win as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement) {
    const proto = Object.getPrototypeOf(el) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, value);
    else (el as HTMLInputElement).value = value;
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    return true;
  }

  // `isContentEditable` is the accurate check in a live browser but is not
  // implemented by all DOM environments, so fall back to the attribute itself
  // (including an ancestor's, for editors that put contenteditable on a wrapper).
  if (isEditable(el)) {
    el.focus();
    const sel = win.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
    // execCommand is deprecated but remains the only reliable way to make
    // rich-text editors (Slate/ProseMirror/Quill) register the insertion.
    const inserted = doc.execCommand?.('insertText', false, value);
    if (!inserted) {
      el.textContent = value;
    }
    el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    return true;
  }

  return false;
}

/** True for a rich-text editor, whether contenteditable sits on it or a parent. */
export function isEditable(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  if (el.getAttribute('contenteditable') === 'true') return true;
  const host = el.closest('[contenteditable="true"]');
  return !!host;
}

/** Simulates pressing Enter on an input, which many chat UIs treat as send. */
export function pressEnter(el: HTMLElement): void {
  const win = el.ownerDocument.defaultView ?? window;
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new win.KeyboardEvent('keydown', init));
  el.dispatchEvent(new win.KeyboardEvent('keypress', init));
  el.dispatchEvent(new win.KeyboardEvent('keyup', init));
}
