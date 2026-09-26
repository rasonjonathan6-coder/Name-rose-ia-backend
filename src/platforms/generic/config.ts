import type { SiteConfig } from '../types';

/**
 * Built-in heuristic configurations.
 *
 * These are selector HINTS, not requirements: every entry is tried first and the
 * generic heuristics still run if a hint stops matching after a site redesign.
 * Keeping them here (rather than inline in adapters) means a broken site can be
 * fixed by a settings import instead of a code change.
 */

export const COOMEET_CONFIG: SiteConfig = {
  hosts: ['coomeet.com'],
  // CooMeet's chat markup has changed repeatedly; we list several generations
  // and let the generic heuristics cover anything newer.
  messageContainer: [
    '[data-testid="chat-messages"]',
    '[class*="chatMessages"]',
    '[class*="chat-messages"]',
    '[class*="messagesList"]',
    '[class*="messages-list"]',
    '[class*="dialogMessages"]',
  ],
  incomingMessage: [
    '[data-testid="message-in"]',
    '[class*="message"][class*="incoming"]',
    '[class*="message"][class*="received"]',
    '[class*="message"][class*="interlocutor"]',
    '[class*="message"][class*="stranger"]',
  ],
  outgoingMessage: [
    '[data-testid="message-out"]',
    '[class*="message"][class*="outgoing"]',
    '[class*="message"][class*="sent"]',
    '[class*="message"][class*="own"]',
    '[class*="message"][class*="my"]',
  ],
  input: [
    'textarea[data-testid="chat-input"]',
    'textarea[class*="chatInput"]',
    'textarea[class*="messageInput"]',
    'textarea[placeholder*="message" i]',
    '[contenteditable="true"][class*="input"]',
    'textarea',
  ],
  sendButton: [
    'button[data-testid="send-message"]',
    'button[class*="sendButton"]',
    'button[class*="send-button"]',
    'button[aria-label*="send" i]',
  ],
  sendWithEnter: true,
};

export const FLIRTIFY_CONFIG: SiteConfig = {
  hosts: ['flirtify.com'],
  messageContainer: [
    '[data-testid="messages"]',
    '[class*="chat__messages"]',
    '[class*="chat-messages"]',
    '[class*="messageList"]',
    '[class*="conversation"]',
  ],
  incomingMessage: [
    '[data-testid="msg-incoming"]',
    '[class*="msg"][class*="in"]',
    '[class*="message"][class*="incoming"]',
    '[class*="message"][class*="left"]',
  ],
  outgoingMessage: [
    '[data-testid="msg-outgoing"]',
    '[class*="msg"][class*="out"]',
    '[class*="message"][class*="outgoing"]',
    '[class*="message"][class*="right"]',
  ],
  input: [
    'textarea[data-testid="chat-input"]',
    'textarea[class*="chat-input"]',
    'div[contenteditable="true"][class*="editor"]',
    'textarea[placeholder*="message" i]',
    'textarea',
  ],
  sendButton: [
    'button[data-testid="send"]',
    'button[class*="send"]',
    'button[aria-label*="send" i]',
  ],
  sendWithEnter: true,
};

/** The local demo harness (demo/demo.html) — stable ids, used by tests + E2E. */
export const DEMO_CONFIG: SiteConfig = {
  hosts: ['localhost', '127.0.0.1'],
  messageContainer: ['#demo-messages'],
  incomingMessage: ['[data-dir="in"]'],
  outgoingMessage: ['[data-dir="out"]'],
  input: ['#demo-input'],
  sendButton: ['#demo-send'],
  author: ['[data-author]'],
  sendWithEnter: false,
};

export const BUILTIN_CONFIGS: SiteConfig[] = [COOMEET_CONFIG, FLIRTIFY_CONFIG, DEMO_CONFIG];
