import { beforeEach, describe, expect, it } from 'vitest';
import { PlatformDetector, matchHost } from '@/platforms/detector';
import { documentUrl } from '@/platforms/types';
import { GenericChatAdapter } from '@/platforms/generic/adapter';
import { DEMO_CONFIG, COOMEET_CONFIG, FLIRTIFY_CONFIG, BUILTIN_CONFIGS } from '@/platforms/generic/config';
import { DemoAdapter } from '@/platforms/generic/demo-adapter';
import { CooMeetAdapter } from '@/platforms/coomeet/adapter';
import { FlirtifyAdapter } from '@/platforms/flirtify/adapter';

/**
 * These tests build real DOM fixtures in jsdom and run the actual heuristics.
 * jsdom does not do layout, so geometry-dependent scoring is stubbed via
 * `getBoundingClientRect` on the fixtures — that is the one place a stub is
 * unavoidable, and it is stubbing the *browser*, not our own code.
 */

/** Gives an element a fake box so geometry heuristics have something to read. */
function setRect(el: Element, rect: { top: number; left: number; width: number; height: number }): void {
  (el as HTMLElement).getBoundingClientRect = () => ({
    top: rect.top,
    left: rect.left,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  }) as DOMRect;
}

/**
 * Points the document at a URL.
 *
 * Only `window.location` is replaced: `document.location` is a non-configurable
 * accessor in jsdom, and production code resolves the URL through the browsing
 * context (`documentUrl`) precisely so a single substitution is enough.
 */
function setUrl(href: string): void {
  const url = new URL(href);
  Object.defineProperty(window, 'location', { value: url, writable: true, configurable: true });
  expect(documentUrl(document).href).toBe(url.href);
}

beforeEach(() => {
  document.body.innerHTML = '';
  setUrl('https://example.com/');
});

// ---------------------------------------------------------------------------
// Host matching
// ---------------------------------------------------------------------------

describe('matchHost', () => {
  it('matches exact hosts', () => {
    expect(matchHost('coomeet.com', 'coomeet.com')).toBe(true);
    expect(matchHost('coomeet.com', 'flirtify.com')).toBe(false);
  });

  it('matches subdomains for a wildcard pattern', () => {
    expect(matchHost('www.coomeet.com', '*.coomeet.com')).toBe(true);
    expect(matchHost('app.coomeet.com', '*.coomeet.com')).toBe(true);
  });

  it('does not match a suffix that is not a subdomain boundary', () => {
    expect(matchHost('notcoomeet.com', 'coomeet.com')).toBe(false);
    expect(matchHost('evil-coomeet.com', '*.coomeet.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchHost('CooMeet.com', 'coomeet.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generic adapter — input detection
// ---------------------------------------------------------------------------

describe('GenericChatAdapter — reply field detection', () => {
  it('finds a textarea with a message placeholder', () => {
    document.body.innerHTML = `
      <div id="chat">
        <div class="messages"><div>Hello</div></div>
        <textarea placeholder="Type your message…"></textarea>
      </div>`;
    const adapter = new GenericChatAdapter();
    const input = adapter.getInput(document);
    expect(input?.tagName).toBe('TEXTAREA');
  });

  it('finds a contenteditable editor', () => {
    document.body.innerHTML = `
      <div class="messages"><div>Hello</div></div>
      <div contenteditable="true" role="textbox" aria-label="Message"></div>`;
    const adapter = new GenericChatAdapter();
    expect(adapter.getInput(document)?.getAttribute('contenteditable')).toBe('true');
  });

  it('finds a plain text input with an aria-label', () => {
    document.body.innerHTML = `
      <div class="messages"><div>Hello</div></div>
      <input type="text" aria-label="Write a message" />`;
    expect(new GenericChatAdapter().getInput(document)?.tagName).toBe('INPUT');
  });

  it('ignores a search box', () => {
    document.body.innerHTML = `
      <input type="search" placeholder="Search conversations" />
      <textarea placeholder="Type a message"></textarea>`;
    const input = new GenericChatAdapter().getInput(document);
    expect(input?.tagName).toBe('TEXTAREA');
    expect(input?.getAttribute('placeholder')).toContain('message');
  });

  it('ignores a disabled field', () => {
    document.body.innerHTML = `
      <textarea placeholder="message" disabled></textarea>
      <textarea placeholder="Type your message"></textarea>`;
    const input = new GenericChatAdapter().getInput(document) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
  });

  it('ignores a login form field', () => {
    document.body.innerHTML = `
      <input type="text" name="username" placeholder="Username" />
      <textarea placeholder="Your message"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.tagName).toBe('TEXTAREA');
  });

  it('returns null when there is no plausible field', () => {
    document.body.innerHTML = `<div>Just some text</div>`;
    expect(new GenericChatAdapter().getInput(document)).toBeNull();
  });

  // Regression guards for over-broad negative hints. The genuine reproductions
  // are the `code` and `find` cases below: a composer with neither a positive
  // chat keyword nor any geometry was rejected outright. The others pin the
  // behaviour the task specified so a future edit cannot silently regress it.
  it('accepts a composer whose `name` attribute merely contains "name"', () => {
    document.body.innerHTML = `<textarea name="chatMessage" placeholder="..."></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.getAttribute('name')).toBe('chatMessage');
  });

  it('accepts a composer with name="message"', () => {
    document.body.innerHTML = `<textarea name="message"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.getAttribute('name')).toBe('message');
  });

  it('accepts a composer with name="chatInput"', () => {
    document.body.innerHTML = `<textarea name="chatInput"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.getAttribute('name')).toBe('chatInput');
  });

  it('accepts a composer whose testid contains "code"', () => {
    // `editor-code` matched the old over-broad `code` hint and, with no positive
    // chat keyword in the attributes, the field was rejected outright.
    document.body.innerHTML = `<textarea aria-label="Compose" data-testid="editor-code"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.getAttribute('data-testid')).toBe('editor-code');
  });

  it('accepts a composer whose class contains "find"', () => {
    // Same shape as the `code` case: `composer-finder` tripped the old `find`
    // hint and had no positive chat keyword to rescue it.
    document.body.innerHTML = `<textarea class="composer-finder"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.className).toContain('composer-finder');
  });

  it('a positive chat hint still wins over a negative substring', () => {
    // "Send a message with your name" is a chat prompt, not an identity field.
    document.body.innerHTML = `<textarea placeholder="Send a message with your name"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)).not.toBeNull();
  });

  it('still rejects a password field', () => {
    document.body.innerHTML = `
      <input type="password" name="password" placeholder="Password" />
      <textarea placeholder="Type a message"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.tagName).toBe('TEXTAREA');
  });

  it('still rejects an email field', () => {
    document.body.innerHTML = `
      <input type="text" name="email" placeholder="Your email" />
      <textarea placeholder="Type a message"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.tagName).toBe('TEXTAREA');
  });

  it('still rejects a login field', () => {
    document.body.innerHTML = `
      <input type="text" name="login" placeholder="Login" />
      <textarea placeholder="Type a message"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.tagName).toBe('TEXTAREA');
  });

  it('still rejects a captcha field', () => {
    document.body.innerHTML = `
      <input type="text" name="captcha" placeholder="Enter the code" />
      <textarea placeholder="Type a message"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.tagName).toBe('TEXTAREA');
  });

  it('still rejects a username field', () => {
    document.body.innerHTML = `
      <input type="text" name="username" placeholder="Username" />
      <textarea placeholder="Type a message"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.tagName).toBe('TEXTAREA');
  });

  it('still rejects a phone field', () => {
    document.body.innerHTML = `
      <input type="text" name="phone" placeholder="Phone number" />
      <textarea placeholder="Type a message"></textarea>`;
    expect(new GenericChatAdapter().getInput(document)?.tagName).toBe('TEXTAREA');
  });

  it('rejects a standalone search field when nothing else exists', () => {
    document.body.innerHTML = `<input type="search" placeholder="Search" />`;
    expect(new GenericChatAdapter().getInput(document)).toBeNull();
  });

  it('a chat composer wins over a search box on the same page', () => {
    document.body.innerHTML = `
      <input type="search" placeholder="Find a conversation" />
      <textarea name="chatMessage" placeholder="Write here"></textarea>`;
    const input = new GenericChatAdapter().getInput(document);
    expect(input?.tagName).toBe('TEXTAREA');
    expect(input?.getAttribute('name')).toBe('chatMessage');
  });

  it('never returns ROSE\'s own UI as the reply field', () => {
    document.body.innerHTML = `
      <div id="rose-shadow-host"></div>
      <textarea placeholder="Type your message"></textarea>`;
    const input = new GenericChatAdapter().getInput(document);
    expect(input?.closest('#rose-shadow-host')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Generic adapter — container and messages
// ---------------------------------------------------------------------------

describe('GenericChatAdapter — message container detection', () => {
  it('finds a scrollable list of repeated bubbles', () => {
    document.body.innerHTML = `
      <div id="chat">
        <div class="chat-messages" role="log" style="overflow-y:auto">
          <div class="bubble">one</div><div class="bubble">two</div><div class="bubble">three</div>
        </div>
        <textarea placeholder="message"></textarea>
      </div>`;
    const adapter = new GenericChatAdapter();
    const container = adapter.getMessageContainer(document);
    expect(container?.className).toContain('chat-messages');
  });

  it('prefers a container with role=log', () => {
    document.body.innerHTML = `
      <div class="wrapper">
        <div class="inner" role="log"><div>a</div><div>b</div><div>c</div></div>
        <div class="other"><div>x</div><div>y</div><div>z</div></div>
      </div>
      <textarea placeholder="message"></textarea>`;
    const container = new GenericChatAdapter().getMessageContainer(document);
    expect(container?.getAttribute('role')).toBe('log');
  });

  it('does not mistake a navigation list for the message container', () => {
    // Found on flirtify.com: `ul.language-dropdown__list` is a list of repeated
    // children whose class satisfies MESSAGE_CONTAINER_HINTS via "…list…", so it
    // won over the (empty) real log and ROSE reported the page chrome.
    document.body.innerHTML = `
      <div class="page">
        <ul class="language-dropdown__list">
          <li>English</li><li>Français</li><li>Deutsch</li><li>Español</li>
        </ul>
        <div class="chat-panel">
          <div class="chat-log" id="log" role="log" aria-live="polite"></div>
          <textarea placeholder="Message…"></textarea>
        </div>
      </div>`;
    const adapter = new GenericChatAdapter();
    expect(adapter.getMessageContainer(document)?.id).toBe('log');
    expect(adapter.getMessages(document)).toEqual([]);
  });

  it('ignores a site menu even when nothing else looks like a log', () => {
    document.body.innerHTML = `
      <nav><ul class="navbar-menu"><li>Home</li><li>About</li><li>Login</li></ul></nav>
      <textarea placeholder="Message…"></textarea>`;
    expect(new GenericChatAdapter().getMessageContainer(document)).toBeNull();
  });

  it('reports no messages on a page with no composer', () => {
    // Found on coomeet.com and flirtify.com: with no reply field the adapter fell
    // back to unscoped page text and returned nav items and marketing copy
    // ("Europe", "9+ million Worldwide users") as the client's messages.
    document.body.innerHTML = `
      <header><nav><ul><li>Europe</li><li>East Asia</li><li>Sign up</li></ul></nav></header>
      <main><p>9+ million Worldwide users</p><p>700+ thousand Verified accounts</p></main>
      <footer><p>© 2026, CooMeet</p></footer>`;
    const adapter = new GenericChatAdapter();
    expect(adapter.getMessageContainer(document)).toBeNull();
    expect(adapter.getMessages(document)).toEqual([]);
  });
});

describe('GenericChatAdapter — message extraction', () => {
  it('extracts messages with text', () => {
    document.body.innerHTML = `
      <div class="messages">
        <div class="msg incoming">Hello there</div>
        <div class="msg outgoing">Hi back</div>
        <div class="msg incoming">How are you?</div>
      </div>
      <textarea placeholder="message"></textarea>`;
    const messages = new GenericChatAdapter().getMessages(document);
    expect(messages.map((m) => m.text)).toEqual(['Hello there', 'Hi back', 'How are you?']);
  });

  it('classifies direction from class hints', () => {
    document.body.innerHTML = `
      <div class="messages">
        <div class="message incoming">from them</div>
        <div class="message outgoing">from me</div>
      </div>
      <textarea placeholder="message"></textarea>`;
    const messages = new GenericChatAdapter().getMessages(document);
    expect(messages.find((m) => m.text === 'from them')!.direction).toBe('incoming');
    expect(messages.find((m) => m.text === 'from me')!.direction).toBe('outgoing');
  });

  it('never treats the composer as a message', () => {
    document.body.innerHTML = `
      <div class="messages"><div class="msg incoming">Hello</div></div>
      <textarea placeholder="message">draft text in composer</textarea>`;
    const messages = new GenericChatAdapter().getMessages(document);
    expect(messages.some((m) => m.text.includes('draft text'))).toBe(false);
  });

  it('produces stable keys for identical content', () => {
    document.body.innerHTML = `
      <div class="messages"><div class="msg incoming">Same text</div></div>
      <textarea placeholder="message"></textarea>`;
    const adapter = new GenericChatAdapter();
    const first = adapter.getMessages(document);
    const second = adapter.getMessages(document);
    expect(first[0]!.key).toBe(second[0]!.key);
  });

  it('uses a native id when the DOM provides one', () => {
    document.body.innerHTML = `
      <div class="messages"><div class="msg incoming" data-message-id="m-42">Hello</div></div>
      <textarea placeholder="message"></textarea>`;
    const messages = new GenericChatAdapter().getMessages(document);
    expect(messages[0]!.key).toBe('m-42');
    expect(messages[0]!.nativeId).toBe('m-42');
  });

  it('extracts an author when present', () => {
    document.body.innerHTML = `
      <div class="messages">
        <div class="msg incoming" data-author="Sophie"><span class="author">Sophie</span>Hello</div>
      </div>
      <textarea placeholder="message"></textarea>`;
    const messages = new GenericChatAdapter().getMessages(document);
    expect(messages[0]!.author).toBe('Sophie');
  });

  it('skips empty bubbles', () => {
    document.body.innerHTML = `
      <div class="messages">
        <div class="msg incoming"></div>
        <div class="msg incoming">real message</div>
      </div>
      <textarea placeholder="message"></textarea>`;
    const messages = new GenericChatAdapter().getMessages(document);
    expect(messages.map((m) => m.text)).toEqual(['real message']);
  });
});

// ---------------------------------------------------------------------------
// Regressions found by the browser harness (scripts/validation/phase2-generic.mjs)
// ---------------------------------------------------------------------------

describe('GenericChatAdapter — regressions caught in a real browser', () => {
  it('reads messages out of a table-based log', () => {
    // Fixture C. Legacy widgets put each message in a <tr><td>; `directText` did
    // not consider <td>, so the row looked textless and the client's only
    // message was invisible to ROSE.
    document.body.innerHTML = `
      <table class="log" id="log" role="log">
        <tbody id="log-body">
          <tr class="msg in" data-message-id="c-1"><td>Hello! Where are you from?</td></tr>
        </tbody>
      </table>
      <input type="text" id="composer" placeholder="Say something" />`;
    const messages = new GenericChatAdapter().getMessages(document);
    expect(messages.map((m) => m.text)).toEqual(['Hello! Where are you from?']);
    expect(messages[0]!.direction).toBe('incoming');
  });

  it('classifies "msg in" / "msg out" from individual class tokens', () => {
    // Fixture D. Joined into one string, "msg in" also matches `me` and `own`
    // from OUTGOING_HINTS, so every client message was labelled as ours.
    document.body.innerHTML = `
      <div class="log" id="log" role="log">
        <div class="msg in" data-message-id="d-1">from them</div>
        <div class="msg out" data-message-id="d-2">from me</div>
      </div>
      <textarea id="composer" placeholder="Message"></textarea>`;
    const messages = new GenericChatAdapter().getMessages(document);
    expect(messages.find((m) => m.text === 'from them')!.direction).toBe('incoming');
    expect(messages.find((m) => m.text === 'from me')!.direction).toBe('outgoing');
  });

  it('finds an empty message log and reports no messages', () => {
    // Fixture D at load: the log exists but has no children yet. It was skipped
    // by container scoring, so a decorative header chip won and was reported as
    // the client's message.
    document.body.innerHTML = `
      <div class="page">
        <header>
          <span class="who">Yuki</span>
          <span class="tag">fixture D · dynamic, virtualised</span>
        </header>
        <div class="log" id="log" role="log" aria-live="polite"></div>
        <div class="composer">
          <textarea id="composer" placeholder="Message…"></textarea>
          <button class="send" aria-label="Send">Send</button>
        </div>
      </div>`;
    const adapter = new GenericChatAdapter();
    expect(adapter.getMessageContainer(document)?.id).toBe('log');
    expect(adapter.getMessages(document)).toEqual([]);
  });

  it('detects messages injected after load', () => {
    document.body.innerHTML = `
      <div class="log" id="log" role="log"></div>
      <textarea id="composer" placeholder="Message…"></textarea>`;
    const adapter = new GenericChatAdapter();
    expect(adapter.getMessages(document)).toEqual([]);

    const bubble = document.createElement('div');
    bubble.className = 'msg in';
    bubble.dataset.messageId = 'd-1';
    bubble.textContent = 'Are you there?';
    document.getElementById('log')!.appendChild(bubble);

    expect(adapter.getMessages(document).map((m) => m.text)).toEqual(['Are you there?']);
  });

  it('never treats toolbar buttons inside the message list as messages', () => {
    document.body.innerHTML = `
      <div class="log" id="log" role="log">
        <div class="msg in" data-message-id="d-1">hello</div>
        <div class="composer-actions"><button class="send-button">Send</button></div>
      </div>
      <textarea id="composer" placeholder="Message…"></textarea>`;
    const texts = new GenericChatAdapter().getMessages(document).map((m) => m.text);
    expect(texts).toEqual(['hello']);
  });

  it('excludes timestamps from the message text', () => {
    // Fixture A. The timestamp span was concatenated into the message, so the
    // model was asked to answer "10:02".
    document.body.innerHTML = `
      <div class="log" id="log" role="log">
        <div class="msg in" data-message-id="a-1">Hey there! How is your day going?<span class="meta">10:02</span></div>
      </div>
      <textarea placeholder="message"></textarea>`;
    const messages = new GenericChatAdapter().getMessages(document);
    expect(messages[0]!.text).toBe('Hey there! How is your day going?');
  });

  it('keeps the container decision across repeated reads', () => {
    // The input cache refresh dropped the `hinted` flag, so after the first
    // resolution ROSE forgot its container and leaked page chrome as messages.
    document.body.innerHTML = `
      <div class="page">
        <header><span class="tag">fixture D · dynamic, virtualised</span></header>
        <div class="log" id="log" role="log"></div>
        <textarea id="composer" placeholder="Message…"></textarea>
      </div>`;
    const adapter = new GenericChatAdapter();
    for (let i = 0; i < 5; i++) {
      adapter.getMessages(document);
      adapter.getInput(document);
      adapter.getMessageContainer(document);
    }
    expect(adapter.getMessages(document)).toEqual([]);
  });

  it('keeps the author name out of the message text', () => {
    // Found on the demo page: the author span was folded into the text, so the
    // model was sent "SophieDo you remember my cat?" and the name ran straight
    // into the client's words. The author is reported separately as `author`.
    document.body.innerHTML = `
      <div class="log" id="log" role="log">
        <div class="msg in" data-message-id="demo-1"><span class="author">Sophie</span>Do you remember my cat?<span class="time">10:02</span></div>
      </div>
      <textarea placeholder="message"></textarea>`;
    const messages = new GenericChatAdapter().getMessages(document);
    expect(messages[0]!.text).toBe('Do you remember my cat?');
    expect(messages[0]!.author).toBe('Sophie');
  });
});

// ---------------------------------------------------------------------------
// Generic adapter — conversation identity
// ---------------------------------------------------------------------------

describe('GenericChatAdapter — conversation identity', () => {
  it('derives a stable clientId for the same page', () => {
    document.body.innerHTML = `
      <header><h1>Sophie</h1></header>
      <div class="messages"><div class="msg incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;
    const adapter = new GenericChatAdapter();
    const a = adapter.getConversation(document);
    const b = adapter.getConversation(document);
    expect(a).not.toBeNull();
    expect(a!.clientId).toBe(b!.clientId);
    expect(a!.id).toBe(`${a!.platform}:${a!.clientId}`);
  });

  it('prefers an explicit data-user-id', () => {
    document.body.innerHTML = `
      <div data-user-id="u-9911"><h1>Sophie</h1></div>
      <div class="messages"><div class="msg incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;
    expect(new GenericChatAdapter().getConversation(document)!.clientId).toBe('u-9911');
  });

  it('reads the client id from the URL when the DOM has none', () => {
    setUrl('https://example.com/chat/user/abcd1234');
    document.body.innerHTML = `
      <div class="messages"><div class="msg incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;
    expect(new GenericChatAdapter().getConversation(document)!.clientId).toBe('abcd1234');
  });

  it('returns null when there is no conversation on the page', () => {
    document.body.innerHTML = `<div>Nothing here</div>`;
    expect(new GenericChatAdapter().getConversation(document)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Generic adapter — writing
// ---------------------------------------------------------------------------

describe('GenericChatAdapter — text insertion', () => {
  it('writes into a textarea and fires input events', () => {
    document.body.innerHTML = `<textarea placeholder="message"></textarea>`;
    const input = document.querySelector('textarea') as HTMLTextAreaElement;
    let inputFired = false;
    input.addEventListener('input', () => {
      inputFired = true;
    });

    const ok = new GenericChatAdapter().insertText(input, 'Hello there');
    expect(ok).toBe(true);
    expect(input.value).toBe('Hello there');
    expect(inputFired).toBe(true);
  });

  it('writes into a contenteditable element', () => {
    document.body.innerHTML = `<div contenteditable="true" aria-label="message"></div>`;
    const el = document.querySelector('[contenteditable]') as HTMLElement;
    const ok = new GenericChatAdapter().insertText(el, 'Hello there');
    expect(ok).toBe(true);
    expect(el.textContent).toBe('Hello there');
  });

  it('finds a send button by aria-label', () => {
    document.body.innerHTML = `
      <div class="composer">
        <textarea placeholder="message"></textarea>
        <button aria-label="Send message">➤</button>
      </div>`;
    const button = new GenericChatAdapter().getSendButton(document);
    expect(button?.getAttribute('aria-label')).toContain('Send');
  });

  it('finds a send button by visible text', () => {
    document.body.innerHTML = `
      <div class="composer"><textarea placeholder="message"></textarea><button>Send</button></div>`;
    expect(new GenericChatAdapter().getSendButton(document)?.textContent).toBe('Send');
  });

  it('falls back to Enter when no send button exists', async () => {
    document.body.innerHTML = `<textarea placeholder="message"></textarea>`;
    const input = document.querySelector('textarea') as HTMLTextAreaElement;
    let enterPressed = false;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') enterPressed = true;
    });

    const ok = await new GenericChatAdapter().send(input);
    expect(ok).toBe(true);
    expect(enterPressed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Demo adapter (the E2E path)
// ---------------------------------------------------------------------------

describe('DemoAdapter', () => {
  beforeEach(() => {
    setUrl('http://localhost:5173/demo/demo.html');
    document.body.innerHTML = `
      <div id="demo-messages">
        <div class="msg" data-dir="in" data-message-id="m1">Hi! How are you?</div>
        <div class="msg" data-dir="out" data-message-id="m2">Good thanks</div>
        <div class="msg" data-dir="in" data-message-id="m3">Where are you from?</div>
      </div>
      <textarea id="demo-input"></textarea>
      <button id="demo-send">Send</button>`;
  });

  it('scores 1.0 on the demo page', () => {
    expect(new DemoAdapter().score(document)).toBe(1);
  });

  it('does not claim non-localhost hosts', () => {
    setUrl('https://coomeet.com/chat');
    expect(new DemoAdapter().score(document)).toBe(0);
  });

  it('detects messages with correct directions', () => {
    const messages = new DemoAdapter().getMessages(document);
    expect(messages.map((m) => m.text)).toEqual(['Hi! How are you?', 'Good thanks', 'Where are you from?']);
    expect(messages.map((m) => m.direction)).toEqual(['incoming', 'outgoing', 'incoming']);
  });

  it('resolves the container, input and send button', () => {
    const adapter = new DemoAdapter();
    expect(adapter.getMessageContainer(document)?.id).toBe('demo-messages');
    expect(adapter.getInput(document)?.id).toBe('demo-input');
    expect(adapter.getSendButton(document)?.id).toBe('demo-send');
  });

  it('inserts text into the demo input', () => {
    const adapter = new DemoAdapter();
    const input = adapter.getInput(document)!;
    expect(adapter.insertText(input, 'Hello from ROSE')).toBe(true);
    expect((input as HTMLTextAreaElement).value).toBe('Hello from ROSE');
  });
});

// ---------------------------------------------------------------------------
// Platform adapters
// ---------------------------------------------------------------------------

describe('CooMeetAdapter', () => {
  it('matches coomeet hosts including subdomains', () => {
    const a = new CooMeetAdapter();
    expect(a.matches(new URL('https://coomeet.com/chat'))).toBe(true);
    expect(a.matches(new URL('https://www.coomeet.com/'))).toBe(true);
    expect(a.matches(new URL('https://flirtify.com/'))).toBe(false);
  });

  it('keys conversation identity off the partner id, not the URL', () => {
    setUrl('https://coomeet.com/chat');
    document.body.innerHTML = `
      <div class="video-chat" data-partner-id="partner-77">
        <div class="partner-name">Anna</div>
      </div>
      <div class="chat-messages"><div class="message incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;
    const conv = new CooMeetAdapter().getConversation(document);
    expect(conv!.clientId).toBe('partner-77');
    expect(conv!.conversationId).toBe('coomeet-partner-77');
    expect(conv!.displayName).toBe('Anna');
  });

  it('filters typing indicators and placeholders out of the message list', () => {
    setUrl('https://coomeet.com/chat');
    document.body.innerHTML = `
      <div class="chat-messages">
        <div class="message incoming">Real message</div>
        <div class="message incoming system">is typing</div>
        <div class="message incoming">Stranger</div>
        <div class="message incoming">...</div>
      </div>
      <textarea placeholder="message"></textarea>`;
    const messages = new CooMeetAdapter().getMessages(document);
    expect(messages.map((m) => m.text)).toEqual(['Real message']);
  });
});

describe('FlirtifyAdapter', () => {
  it('matches flirtify hosts', () => {
    const a = new FlirtifyAdapter();
    expect(a.matches(new URL('https://flirtify.com/chat'))).toBe(true);
    expect(a.matches(new URL('https://www.flirtify.com/'))).toBe(true);
    expect(a.matches(new URL('https://coomeet.com/'))).toBe(false);
  });

  it('derives identity from the profile slug in the URL', () => {
    setUrl('https://flirtify.com/profile/julia-99');
    document.body.innerHTML = `
      <div class="profile-name">Julia</div>
      <div class="chat__messages"><div class="message incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;
    const conv = new FlirtifyAdapter().getConversation(document);
    expect(conv!.clientId).toBe('julia-99');
    expect(conv!.conversationId).toBe('flirtify-julia-99');
  });

  it('filters gift and media cards out of the message list', () => {
    setUrl('https://flirtify.com/profile/julia-99');
    document.body.innerHTML = `
      <div class="chat__messages">
        <div class="message incoming">Hello there</div>
        <div class="message incoming">[gift]</div>
        <div class="message incoming">sent a gift</div>
        <div class="message incoming">is typing</div>
      </div>
      <textarea placeholder="message"></textarea>`;
    const messages = new FlirtifyAdapter().getMessages(document);
    expect(messages.map((m) => m.text)).toEqual(['Hello there']);
  });
});

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

describe('PlatformDetector', () => {
  it('selects the demo adapter on localhost', () => {
    setUrl('http://localhost:5173/demo/demo.html');
    document.body.innerHTML = `
      <div id="demo-messages"><div data-dir="in">hi</div></div>
      <textarea id="demo-input"></textarea>`;
    const report = new PlatformDetector().detect(document);
    expect(report.platform).toBe('demo');
    expect(report.confidence).toBeGreaterThan(0.9);
  });

  it('selects CooMeet on coomeet.com', () => {
    setUrl('https://coomeet.com/chat');
    document.body.innerHTML = `
      <div class="video-chat" data-partner-id="p1"><div class="partner-name">Anna</div></div>
      <div class="chat-messages"><div class="message incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;
    expect(new PlatformDetector().detect(document).platform).toBe('coomeet');
  });

  it('selects Flirtify on flirtify.com', () => {
    setUrl('https://flirtify.com/profile/x1');
    document.body.innerHTML = `
      <div class="profile-name">X</div>
      <div class="chat__messages"><div class="message incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;
    expect(new PlatformDetector().detect(document).platform).toBe('flirtify');
  });

  it('falls back to generic on an unknown chat site', () => {
    setUrl('https://some-unknown-chat.example/room');
    document.body.innerHTML = `
      <div class="messages" role="log"><div>a</div><div>b</div><div>c</div></div>
      <textarea placeholder="Type a message"></textarea>`;
    const report = new PlatformDetector().detect(document);
    expect(report.platform).toBe('generic');
    expect(report.confidence).toBeGreaterThan(0);
  });

  it('reports low confidence on a page with no chat', () => {
    setUrl('https://some-unknown-chat.example/');
    document.body.innerHTML = `<article><p>Just an article</p></article>`;
    expect(new PlatformDetector().detect(document).confidence).toBeLessThan(0.5);
  });

  it('lets a user config override the built-ins', () => {
    setUrl('https://my-custom-site.test/chat');
    document.body.innerHTML = `
      <div id="custom-messages"><div class="in">hello</div></div>
      <textarea id="custom-input"></textarea>`;
    setRect(document.querySelector('#custom-input')!, { top: 600, left: 300, width: 400, height: 40 });

    const detector = new PlatformDetector();
    detector.setUserConfigs([
      {
        hosts: ['my-custom-site.test'],
        messageContainer: ['#custom-messages'],
        incomingMessage: ['.in'],
        input: ['#custom-input'],
      },
    ]);

    const report = detector.detect(document);
    expect(report.confidence).toBeGreaterThanOrEqual(0.95);
    expect(report.notes.join(' ')).toContain('user config');
  });

  it('never throws when an adapter fails to score', () => {
    setUrl('https://broken.test/');
    document.body.innerHTML = '<div>x</div>';
    const detector = new PlatformDetector();
    detector.register({
      id: 'generic',
      label: 'Broken',
      matches: () => true,
      score: () => {
        throw new Error('adapter exploded');
      },
      getConversation: () => null,
      getMessages: () => [],
      getMessageContainer: () => null,
      getInput: () => null,
      getSendButton: () => null,
      insertText: () => false,
      send: async () => false,
    });
    expect(() => detector.detect(document)).not.toThrow();
  });

  it('populates the resolved capabilities in the report', () => {
    setUrl('http://localhost:5173/demo/demo.html');
    document.body.innerHTML = `
      <div id="demo-messages"><div data-dir="in">hi</div></div>
      <textarea id="demo-input"></textarea>
      <button id="demo-send">Send</button>`;
    const report = new PlatformDetector().detect(document);
    expect(report.resolved.input).toContain('textarea');
    expect(report.resolved.sendButton).toContain('button');
  });
});

// ---------------------------------------------------------------------------
// Built-in configs
// ---------------------------------------------------------------------------

describe('built-in site configs', () => {
  it('every config declares at least one host', () => {
    for (const cfg of [COOMEET_CONFIG, FLIRTIFY_CONFIG, DEMO_CONFIG]) {
      expect(cfg.hosts.length).toBeGreaterThan(0);
    }
  });

  it('every declared selector is valid CSS', () => {
    for (const cfg of [COOMEET_CONFIG, FLIRTIFY_CONFIG, DEMO_CONFIG]) {
      const sels = [
        ...(cfg.messageContainer ?? []),
        ...(cfg.incomingMessage ?? []),
        ...(cfg.outgoingMessage ?? []),
        ...(cfg.input ?? []),
        ...(cfg.sendButton ?? []),
        ...(cfg.author ?? []),
      ];
      for (const sel of sels) {
        expect(() => document.querySelector(sel), `invalid selector: ${sel}`).not.toThrow();
      }
    }
  });

  it('a stale selector does not break detection (heuristics still run)', () => {
    setUrl('https://coomeet.com/chat');
    // No element matches any of the CooMeet selectors; only generic heuristics
    // can find the field.
    document.body.innerHTML = `
      <div class="genericList" role="log"><div>a</div><div>b</div><div>c</div></div>
      <textarea aria-label="Your message"></textarea>`;
    const adapter = new CooMeetAdapter();
    expect(adapter.getInput(document)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Detector — the real content-script path
//
// Regression guard for the production bug where the content script passed
// BUILTIN_CONFIGS to setUserConfigs(). That made the detector treat the shipped
// CooMeet/Flirtify configs as *user* configs, which short-circuit to score 1 and
// instantiate a GenericChatAdapter — so `platform=generic confidence=1` even on
// coomeet.com, and the dedicated adapters never ran.
//
// The earlier tests above only ever built `new PlatformDetector()` and never
// called setUserConfigs, which is exactly why the bug escaped.
// ---------------------------------------------------------------------------

describe('PlatformDetector — built-in configs are not user configs', () => {
  it('still picks CooMeet when the built-in configs are registered as built-ins', () => {
    setUrl('https://coomeet.com/chat');
    document.body.innerHTML = `
      <div class="video-chat" data-partner-id="p1"><div class="partner-name">Anna</div></div>
      <div class="chat-messages"><div class="message incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;

    const detector = new PlatformDetector();
    detector.registerBuiltinConfigs(BUILTIN_CONFIGS);

    const report = detector.detect(document);
    expect(report.platform).toBe('coomeet');
    // The real regression signal: a shipped config must never be treated as an
    // operator-authored one.
    expect(report.notes.join(' ')).not.toContain('user config');
    // ...and the dedicated adapter must be what actually runs.
    expect(detector.resolve(document).id).toBe('coomeet');
  });

  it('a dedicated adapter wins the tie against a generic config adapter', () => {
    // This is the exact shape of the production bug. CooMeetAdapter legitimately
    // scores 1.0 on a recognised shell; the old user-config tier *also* pushed a
    // GenericChatAdapter at 1.0, and because it was pushed first, a stable sort
    // made generic win — hence `platform=generic confidence=1` on coomeet.com.
    setUrl('https://coomeet.com/chat');
    document.body.innerHTML = `
      <div class="video-chat" data-partner-id="p1"><div class="partner-name">Anna</div></div>
      <div class="chat-messages"><div class="message incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;

    const detector = new PlatformDetector();
    detector.registerBuiltinConfigs(BUILTIN_CONFIGS);

    // Repeat because a tie broken by insertion order is order-sensitive.
    for (let i = 0; i < 5; i++) {
      expect(detector.detect(document).platform).toBe('coomeet');
    }
  });

  it('the generic adapter alone cannot report confidence 1', () => {
    // Guards the diagnostic invariant: `platform=generic confidence=1` in the
    // logs could only ever have come from the user-config short-circuit, never
    // from the heuristics.
    setUrl('https://unknown-chat.example/room');
    document.body.innerHTML = `
      <div class="messages" role="log"><div>a</div><div>b</div><div>c</div></div>
      <textarea placeholder="Type a message"></textarea>`;
    const report = new GenericChatAdapter().score(document);
    expect(report).toBeLessThanOrEqual(0.9);
  });

  it('still picks Flirtify when the built-in configs are registered as built-ins', () => {
    setUrl('https://flirtify.com/profile/x1');
    document.body.innerHTML = `
      <div class="profile-name">X</div>
      <div class="chat__messages"><div class="message incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;

    const detector = new PlatformDetector();
    detector.registerBuiltinConfigs(BUILTIN_CONFIGS);
    expect(detector.detect(document).platform).toBe('flirtify');
  });

  it('picks the demo adapter on localhost when built-in configs are registered', () => {
    setUrl('http://localhost:5173/demo/demo.html');
    document.body.innerHTML = `
      <div id="demo-messages"><div data-dir="in">hi</div></div>
      <textarea id="demo-input"></textarea>`;

    const detector = new PlatformDetector();
    detector.registerBuiltinConfigs(BUILTIN_CONFIGS);
    expect(detector.detect(document).platform).toBe('demo');
  });

  it('falls back to generic on an unknown site when built-in configs are registered', () => {
    setUrl('https://unknown-chat.example/room');
    document.body.innerHTML = `
      <div class="messages" role="log"><div>a</div><div>b</div><div>c</div></div>
      <textarea placeholder="Type a message"></textarea>`;

    const detector = new PlatformDetector();
    detector.registerBuiltinConfigs(BUILTIN_CONFIGS);
    expect(detector.detect(document).platform).toBe('generic');
  });

  it('an explicit user config still wins over the built-ins', () => {
    setUrl('https://my-custom-site.test/chat');
    document.body.innerHTML = `
      <div id="custom-messages"><div class="in">hello</div></div>
      <textarea id="custom-input"></textarea>`;
    setRect(document.querySelector('#custom-input')!, { top: 600, left: 300, width: 400, height: 40 });

    const detector = new PlatformDetector();
    detector.registerBuiltinConfigs(BUILTIN_CONFIGS);
    detector.setUserConfigs([
      {
        hosts: ['my-custom-site.test'],
        messageContainer: ['#custom-messages'],
        incomingMessage: ['.in'],
        input: ['#custom-input'],
      },
    ]);

    const report = detector.detect(document);
    expect(report.platform).toBe('generic');
    expect(report.confidence).toBeGreaterThanOrEqual(0.95);
    expect(report.notes.join(' ')).toContain('user config');
  });

  it('a user config for a built-in host is still honoured (user knows best)', () => {
    setUrl('https://coomeet.com/chat');
    document.body.innerHTML = `
      <div id="my-messages"><div class="in">hello</div></div>
      <textarea id="my-input"></textarea>`;
    setRect(document.querySelector('#my-input')!, { top: 600, left: 300, width: 400, height: 40 });

    const detector = new PlatformDetector();
    detector.registerBuiltinConfigs(BUILTIN_CONFIGS);
    detector.setUserConfigs([
      { hosts: ['coomeet.com'], messageContainer: ['#my-messages'], input: ['#my-input'] },
    ]);

    const report = detector.detect(document);
    expect(report.notes.join(' ')).toContain('user config');
    expect(report.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('the dedicated adapter is what `resolve()` returns on CooMeet', () => {
    setUrl('https://coomeet.com/chat');
    document.body.innerHTML = `
      <div class="video-chat" data-partner-id="p1"><div class="partner-name">Anna</div></div>
      <div class="chat-messages"><div class="message incoming">hi</div></div>
      <textarea placeholder="message"></textarea>`;

    const detector = new PlatformDetector();
    detector.registerBuiltinConfigs(BUILTIN_CONFIGS);
    expect(detector.resolve(document).id).toBe('coomeet');
  });
});

describe('architectural guard: shipped configs never go through setUserConfigs', () => {
  /**
   * `setUserConfigs` is the operator-priority tier and short-circuits to score 1.
   * Routing the shipped BUILTIN_CONFIGS through it is what produced
   * `platform=generic confidence=1` on coomeet.com in production. A comment is
   * not enough to stop that being reintroduced, so this scans the source.
   */
  it('no source file passes BUILTIN_CONFIGS (or a built-in config) to setUserConfigs', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(p)) files.push(p);
      }
    };
    walk('src');

    const shipped = /(BUILTIN_CONFIGS|COOMEET_CONFIG|FLIRTIFY_CONFIG|DEMO_CONFIG)/;
    const userConfigCall = /setUserConfigs\s*\(([\s\S]{0,200}?)\)/g;
    const offenders: string[] = [];

    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const line of src.split('\n')) {
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        userConfigCall.lastIndex = 0;
        const m = userConfigCall.exec(line);
        if (m && shipped.test(m[1]!)) offenders.push(`${f}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the content script registers shipped configs as built-ins', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/content/index.ts', 'utf8');
    expect(src).toMatch(/registerBuiltinConfigs\(\s*BUILTIN_CONFIGS\s*\)/);
    expect(src).not.toMatch(/setUserConfigs\(\s*BUILTIN_CONFIGS\s*\)/);
  });
});
