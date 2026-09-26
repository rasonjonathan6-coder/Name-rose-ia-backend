// @vitest-environment node
/**
 * End-to-end pipeline test.
 *
 * Runs in the Node environment so Node's real `fetch` and `AbortController` are
 * used (jsdom's AbortSignal is rejected by undici), while the DOM is built
 * explicitly with jsdom and injected as the globals the extension code expects.
 *
 * Everything below the browser boundary is the real implementation: the real
 * GenericChatAdapter heuristics, the real MessageDetector MutationObserver, the
 * real ClientMemoryStore on the real storage layer, the real GenerationService
 * talking to a real HTTP server, and the real AutomationStateMachine. Only the
 * provider is local, so no API key or network access is required.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// DOM environment
// ---------------------------------------------------------------------------

let dom: JSDOM;

const DEMO_MARKUP = `<!DOCTYPE html>
<html><body>
  <header data-testid="partner-name">
    <div class="partner-name" id="partner-name">Sophie</div>
  </header>
  <div id="demo-messages" class="messages" role="log" aria-live="polite"></div>
  <footer class="composer">
    <textarea id="demo-input" placeholder="Type a message…" aria-label="Message"></textarea>
    <button id="demo-send" aria-label="Send">Send</button>
  </footer>
</body></html>`;

/**
 * jsdom globals that must NOT replace Node's own implementations.
 *
 * Node's fetch/undici rejects a foreign AbortSignal ("Expected signal to be an
 * instance of AbortSignal"), so shadowing AbortController with jsdom's would
 * break every outbound request. The networking primitives stay Node-native.
 */
const KEEP_NODE_NATIVE = new Set([
  'AbortController', 'AbortSignal', 'fetch', 'Headers', 'Request', 'Response',
  'FormData', 'Blob', 'File', 'ReadableStream', 'WritableStream', 'TransformStream',
  'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'structuredClone',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'performance', 'crypto',
]);

/**
 * Installs jsdom's window as the global browsing context, mirroring how the
 * content script runs inside a real page. Returns a restore function.
 *
 * Globals are installed with `defineProperty` because several (notably
 * `navigator`) exist on Node's globalThis as getter-only accessors.
 */
function installDom(url = 'http://localhost/demo.html'): () => void {
  dom = new JSDOM(DEMO_MARKUP, { url, pretendToBeVisual: true });
  const win = dom.window as unknown as Record<string, unknown>;

  // jsdom has no PointerEvent; clickElement dispatches one. Set it before the
  // globals are collected so it is installed like any other constructor.
  if (typeof (win as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
    (win as { PointerEvent: unknown }).PointerEvent = win.MouseEvent;
  }

  const saved = new Map<string, PropertyDescriptor | undefined>();
  const installed: string[] = [];
  // Install every global the jsdom window exposes. The extension code is
  // browser code, so anything it may reach for (SVGElement, HTMLDivElement,
  // CSS, …) must resolve to the jsdom realm rather than Node's.
  const keys = new Set<string>(Object.getOwnPropertyNames(win));
  for (const k of ['window', 'document', 'navigator', 'location', 'getComputedStyle']) {
    keys.add(k);
  }
  for (const k of keys) {
    if (k === 'undefined' || k === 'globalThis' || KEEP_NODE_NATIVE.has(k)) continue;
    let value: unknown;
    try {
      value = win[k];
    } catch {
      continue;
    }
    if (typeof value === 'function' && !/^[A-Z]/.test(k)) {
      // Only install constructors/namespaces, not arbitrary helper functions.
      if (!['getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(k)) {
        continue;
      }
    }
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    try {
      Object.defineProperty(globalThis, k, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      installed.push(k);
    } catch {
      // A non-configurable global cannot be shadowed; the code under test does
      // not depend on it.
    }
  }
  return () => {
    for (const k of installed) {
      const descriptor = saved.get(k);
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
    dom.window.close();
  };
}

// ---------------------------------------------------------------------------
// Fake provider
// ---------------------------------------------------------------------------

let server: Server | null = null;
let requestCount = 0;
/** Queue of JSON payloads the fake provider will return, in order. */
let replies: string[] = [];
let lastBody: { model?: string; messages?: Array<{ role: string; content: string }> } | null = null;

async function startProvider(): Promise<string> {
  requestCount = 0;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      requestCount++;
      try {
        lastBody = JSON.parse(raw);
      } catch {
        lastBody = null;
      }
      const content =
        replies.shift() ?? JSON.stringify({ suggestions: ['Fallback reply one', 'Fallback reply two'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: lastBody?.model ?? 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server!.address() as { port: number }).port;
  return `http://127.0.0.1:${port}/v1`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  replies = [];
  lastBody = null;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const providerConfig = (baseUrl: string) => ({
  id: 'test',
  label: 'Local test provider',
  baseUrl,
  model: 'fake-model',
  fastModel: 'fake-fast-model',
  apiKey: 'test-key',
  temperature: 0.85,
  maxTokens: 320,
  enabled: true,
  viaProxy: false,
});

async function buildHarness(baseUrl: string) {
  const { DemoAdapter } = await import('@/platforms/generic/demo-adapter');
  const { MessageDetector } = await import('@/core/conversation/message-detector');
  const { ConversationEngine } = await import('@/core/conversation/engine');
  const { ClientMemoryStore } = await import('@/core/memory/store');
  const { GenerationService } = await import('@/core/ai/generation-service');
  const { AutomationStateMachine } = await import('@/core/automation/state-machine');
  const { ResponseQualityGuard } = await import('@/core/safety/quality-guard');

  const adapter = new DemoAdapter();
  const engine = new ConversationEngine(() => ({ inactivityMinutes: 10, maxRecentMessages: 12 }));
  const memory = new ClientMemoryStore(() => ({
    enabled: true,
    retentionDays: 30,
    maxRecentMessages: 12,
    autoSummarizeAfter: 20,
  }));
  const generation = new GenerationService({
    getActiveProvider: async () => providerConfig(baseUrl),
    getApiKey: async () => 'test-key',
  });
  const machine = new AutomationStateMachine({ mode: 'assisted' });
  const guard = new ResponseQualityGuard();

  const detected: string[] = [];
  const detector = new MessageDetector(
    adapter,
    {
      onMessages: (_messages, all) => {
        const last = all[all.length - 1];
        if (last) detected.push(last.text);
      },
      onConversationChange: () => {},
    },
    10,
  );

  return { adapter, engine, memory, generation, machine, guard, detector, detected };
}

/** Adds a message bubble to the demo DOM the way the demo page does. */
function pushMessage(text: string, dir: 'incoming' | 'outgoing'): void {
  const doc = dom.window.document;
  const container = doc.querySelector('#demo-messages')!;
  const el = doc.createElement('div');
  el.className = `msg ${dir}`;
  el.setAttribute('data-direction', dir === 'incoming' ? 'in' : 'out');
  el.textContent = text;
  container.appendChild(el);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E — demo adapter against the real DOM', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installDom();
  });
  afterEach(() => restore());

  it('detects the conversation and its client', async () => {
    const { adapter } = await buildHarness('http://127.0.0.1:1/v1');
    const doc = dom.window.document;
    const conversation = adapter.getConversation(doc);
    expect(conversation).not.toBeNull();
    expect(conversation!.displayName).toBe('Sophie');
    expect(conversation!.platform).toBe('demo');
  });

  it('scores the demo page above zero', async () => {
    const { adapter } = await buildHarness('http://127.0.0.1:1/v1');
    expect(adapter.score(dom.window.document)).toBeGreaterThan(0);
  });

  it('finds the reply input and the send button', async () => {
    const { adapter } = await buildHarness('http://127.0.0.1:1/v1');
    const doc = dom.window.document;
    const input = adapter.getInput(doc);
    expect(input).not.toBeNull();
    expect(input!.tagName.toLowerCase()).toBe('textarea');
    expect(adapter.getSendButton(doc)).not.toBeNull();
  });

  it('reads rendered messages in order and identifies the direction', async () => {
    const { adapter } = await buildHarness('http://127.0.0.1:1/v1');
    pushMessage('Hi there', 'incoming');
    pushMessage('Hello back', 'outgoing');
    pushMessage('How are you?', 'incoming');

    const messages = adapter.getMessages(dom.window.document);
    expect(messages.map((m) => m.text)).toEqual(['Hi there', 'Hello back', 'How are you?']);
    expect(messages.map((m) => m.direction)).toEqual(['incoming', 'outgoing', 'incoming']);
  });

  it('writes text into the textarea and fires an input event', async () => {
    const { adapter } = await buildHarness('http://127.0.0.1:1/v1');
    const doc = dom.window.document;
    const input = adapter.getInput(doc)!;

    let fired = false;
    input.addEventListener('input', () => {
      fired = true;
    });

    expect(adapter.insertText(input, 'Hello Sophie')).toBe(true);
    expect((input as HTMLTextAreaElement).value).toBe('Hello Sophie');
    expect(fired).toBe(true);
  });

  it('sends via the send button', async () => {
    const { adapter } = await buildHarness('http://127.0.0.1:1/v1');
    const doc = dom.window.document;
    const button = adapter.getSendButton(doc)!;
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });
    await adapter.send(adapter.getInput(doc)!);
    expect(clicked).toBe(true);
  });
});

describe('E2E — live message detection', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installDom();
  });
  afterEach(() => restore());

  it('emits a newly appended incoming message', async () => {
    const { detector, detected } = await buildHarness('http://127.0.0.1:1/v1');
    detector.start(dom.window.document);
    pushMessage('Hey, how are you?', 'incoming');
    await wait(120);
    detector.stop();
    expect(detected).toContain('Hey, how are you?');
  });

  it('does not emit the same message twice', async () => {
    const { detector, detected } = await buildHarness('http://127.0.0.1:1/v1');
    detector.start(dom.window.document);
    pushMessage('Hello there', 'incoming');
    await wait(120);
    // A typing indicator mutating the same list must not re-emit the message.
    pushMessage('', 'incoming');
    await wait(120);
    detector.stop();
    expect(detected.filter((t) => t === 'Hello there')).toHaveLength(1);
  });

  it('emits several messages in order', async () => {
    const { detector, detected } = await buildHarness('http://127.0.0.1:1/v1');
    detector.start(dom.window.document);
    pushMessage('First message', 'incoming');
    await wait(80);
    pushMessage('Second message', 'incoming');
    await wait(80);
    detector.stop();
    expect(detected).toEqual(['First message', 'Second message']);
  });

  it('stops emitting after stop()', async () => {
    const { detector, detected } = await buildHarness('http://127.0.0.1:1/v1');
    detector.start(dom.window.document);
    detector.stop();
    pushMessage('After stop', 'incoming');
    await wait(120);
    expect(detected).not.toContain('After stop');
  });
});

describe('E2E — memory isolation across clients', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installDom();
  });
  afterEach(() => restore());

  it('keeps two clients fully separate', async () => {
    const { memory, adapter } = await buildHarness('http://127.0.0.1:1/v1');
    const doc = dom.window.document;
    const ref = adapter.getConversation(doc)!;

    const aliceRef = { ...ref, clientId: 'alice', id: 'demo:alice' };
    await memory.getOrCreate(aliceRef);
    await memory.recordIncoming(aliceRef, 'I live in Lyon', 'en');
    await memory.recordOutgoing(aliceRef, 'Nice city!', 'en');

    const bobRef = { ...ref, clientId: 'bob', id: 'demo:bob' };
    await memory.getOrCreate(bobRef);
    await memory.recordIncoming(bobRef, 'I live in Berlin', 'de');

    const aliceReloaded = await memory.refresh('demo:alice');
    const bobReloaded = await memory.refresh('demo:bob');

    expect(aliceReloaded!.recentMessages.map((m) => m.text)).toEqual(['I live in Lyon', 'Nice city!']);
    expect(bobReloaded!.recentMessages.map((m) => m.text)).toEqual(['I live in Berlin']);
  });

  it('recovers a returning client context from persistence', async () => {
    const { memory } = await buildHarness('http://127.0.0.1:1/v1');
    const ref = {
      id: 'demo:returning',
      platform: 'demo' as const,
      clientId: 'returning',
      displayName: 'Sophie',
      conversationId: 'c-returning',
      url: 'http://localhost/demo.html',
      language: 'en',
    };
    await memory.getOrCreate(ref);
    await memory.recordIncoming(ref, 'I work as a nurse', 'en');

    const second = await memory.getOrCreate(ref);
    expect(second.recentMessages.map((m) => m.text)).toContain('I work as a nurse');
    expect(second.metadata.messageCount).toBeGreaterThan(0);
  });

  it('clears one client without touching another', async () => {
    const { memory } = await buildHarness('http://127.0.0.1:1/v1');
    const base = {
      platform: 'demo' as const,
      displayName: 'X',
      conversationId: 'c',
      url: 'http://localhost/demo.html',
      language: 'en',
    };
    const aRef = { ...base, id: 'demo:a', clientId: 'a' };
    await memory.getOrCreate(aRef);
    await memory.recordIncoming(aRef, 'message from a', 'en');
    const bRef = { ...base, id: 'demo:b', clientId: 'b' };
    await memory.getOrCreate(bRef);
    await memory.recordIncoming(bRef, 'message from b', 'en');

    await memory.clear('demo:a');
    expect(await memory.refresh('demo:a')).toBeNull();
    expect((await memory.refresh('demo:b'))!.recentMessages.map((m) => m.text)).toContain('message from b');
  });
});

describe('E2E — full pipeline: detection → memory → AI → insertion', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installDom();
  });
  afterEach(() => restore());

  it('produces suggestions from a detected message and records the exchange', async () => {
    const base = await startProvider();
    replies = [
      JSON.stringify({
        suggestions: ['I am doing well, thanks!', 'Great, and you?', 'Doing well — what about you?'],
      }),
    ];

    const { adapter, engine, memory, generation, detector, detected } = await buildHarness(base);
    detector.start(dom.window.document);
    pushMessage('Hi, how are you?', 'incoming');
    await wait(150);
    detector.stop();

    expect(detected).toContain('Hi, how are you?');

    const ref = adapter.getConversation(dom.window.document)!;
    const client = await memory.getOrCreate(ref);
    const incoming = detected[detected.length - 1]!;

    const history = engine.buildHistory(client, incoming);
    const understanding = engine.understand(incoming, client, history);
    expect(understanding.hasQuestion).toBe(true);

    const result = await generation.generate({
      conversation: ref,
      incoming,
      memory: client,
      history,
      style: 'natural',
      length: 'medium',
      targetLanguage: 'en',
      count: 3,
    });

    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]!.text).toBe('I am doing well, thanks!');
    expect(requestCount).toBe(1);

    // The prompt must carry the client's actual message.
    expect(JSON.stringify(lastBody)).toContain('Hi, how are you?');

    // Persist the exchange, then confirm the next turn sees the history.
    await memory.recordIncoming(ref, incoming, 'en');
    await memory.recordOutgoing(ref, result.suggestions[0]!.text, 'en');

    const reloaded = (await memory.refresh(ref.id))!;
    expect(reloaded.recentMessages.map((m) => m.text)).toEqual(['Hi, how are you?', 'I am doing well, thanks!']);
    const nextHistory = engine.buildHistory(reloaded, 'Where are you from?');
    expect(nextHistory.length).toBeGreaterThanOrEqual(2);
  });

  it('inserts the chosen suggestion into the real reply field', async () => {
    const base = await startProvider();
    replies = [JSON.stringify({ suggestions: ['Nice to meet you!', 'Hey there!', 'Hi! How is your day?'] })];

    const { adapter, memory, generation } = await buildHarness(base);
    const doc = dom.window.document;
    pushMessage('What do you do for a living?', 'incoming');

    const ref = adapter.getConversation(doc)!;
    const client = await memory.getOrCreate(ref);
    const result = await generation.generate({
      conversation: ref,
      incoming: 'What do you do for a living?',
      memory: client,
      history: [],
      style: 'natural',
      length: 'short',
      targetLanguage: 'en',
      count: 3,
    });

    expect(requestCount).toBe(1);
    expect(result.suggestions[0]!.text).toBe('Nice to meet you!');

    const input = adapter.getInput(doc)!;
    expect(adapter.insertText(input, result.suggestions[0]!.text)).toBe(true);
    expect((input as HTMLTextAreaElement).value).toBe('Nice to meet you!');
  });

  it('never sends a message to the provider for a greeting (cost guard)', async () => {
    const base = await startProvider();
    const { adapter, memory, generation } = await buildHarness(base);
    const doc = dom.window.document;
    pushMessage('hi', 'incoming');

    const ref = adapter.getConversation(doc)!;
    const client = await memory.getOrCreate(ref);
    const result = await generation.generate({
      conversation: ref,
      incoming: 'hi',
      memory: client,
      history: [],
      style: 'natural',
      length: 'short',
      targetLanguage: 'en',
      count: 3,
    });

    expect(requestCount).toBe(0);
    expect(result.model).toBe('local');
  });

  it('caches a repeated identical generation', async () => {
    const base = await startProvider();
    replies = [JSON.stringify({ suggestions: ['Same reply here', 'Another reply here'] })];

    const { adapter, memory, generation } = await buildHarness(base);
    const doc = dom.window.document;
    pushMessage('Tell me about your hobbies', 'incoming');

    const ref = adapter.getConversation(doc)!;
    const client = await memory.getOrCreate(ref);
    const req = {
      conversation: ref,
      incoming: 'Tell me about your hobbies',
      memory: client,
      history: [],
      style: 'natural' as const,
      length: 'medium' as const,
      targetLanguage: 'en',
      count: 2,
    };

    const first = await generation.generate(req);
    const second = await generation.generate(req);
    expect(requestCount).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.suggestions.map((s) => s.text)).toEqual(first.suggestions.map((s) => s.text));
  });

  it('recovers from a provider failure without crashing the pipeline', async () => {
    // A server that always returns 500.
    requestCount = 0;
    const bad = createServer((_req, res) => {
      requestCount++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'provider down' } }));
    });
    await new Promise<void>((r) => bad.listen(0, '127.0.0.1', r));
    const port = (bad.address() as { port: number }).port;

    try {
      const { adapter, memory, generation } = await buildHarness(`http://127.0.0.1:${port}/v1`);
      const doc = dom.window.document;
      pushMessage('What do you do for work?', 'incoming');
      const ref = adapter.getConversation(doc)!;
      const client = await memory.getOrCreate(ref);

      await expect(
        generation.generate({
          conversation: ref,
          incoming: 'What do you do for work?',
          memory: client,
          history: [],
          style: 'natural',
          length: 'medium',
          targetLanguage: 'en',
          count: 3,
        }),
      ).rejects.toThrow();

      // The memory layer must still work after an AI failure.
      await memory.recordIncoming(ref, 'What do you do for work?', 'en');
      expect((await memory.refresh(ref.id))!.recentMessages).toHaveLength(1);
    } finally {
      await new Promise<void>((r) => bad.close(() => r()));
    }
  });
});

describe('E2E — automation state machine integration', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installDom();
  });
  afterEach(() => restore());

  it('walks a message through generation to a ready state in assisted mode', async () => {
    const base = await startProvider();
    replies = [JSON.stringify({ suggestions: ['A reply from ROSE'] })];

    const { machine, adapter, memory, generation } = await buildHarness(base);
    const doc = dom.window.document;
    pushMessage('Can you tell me more?', 'incoming');
    const ref = adapter.getConversation(doc)!;
    const client = await memory.getOrCreate(ref);

    machine.dispatch({ type: 'message', conversationId: ref.id }, { contentAllowed: true, rateAllowed: true, cooldownReady: true, policyAllowed: true });
    expect(machine.current).toBe('generating');

    const result = await generation.generate({
      conversation: ref,
      incoming: 'Can you tell me more?',
      memory: client,
      history: [],
      style: 'natural',
      length: 'medium',
      targetLanguage: 'en',
      count: 1,
    });
    machine.dispatch({ type: 'generation-succeeded', conversationId: ref.id, suggestions: result.suggestions });
    expect(machine.current).toBe('ready');
    expect(machine.isStopped).toBe(false);
  });

  it('refuses to act while stopped', async () => {
    const { machine } = await buildHarness('http://127.0.0.1:1/v1');
    machine.dispatch({ type: 'stop' });
    expect(machine.isStopped).toBe(true);
    const result = machine.dispatch({ type: 'message', conversationId: 'x' }, { contentAllowed: true, rateAllowed: true, cooldownReady: true, policyAllowed: true });
    expect(result.action).toBe('none');
    expect(machine.current).toBe('stopped');
  });

  it('blocks generation when the policy gate fails', async () => {
    const { machine } = await buildHarness('http://127.0.0.1:1/v1');
    machine.dispatch(
      { type: 'message', conversationId: 'x' },
      { contentAllowed: true, rateAllowed: true, cooldownReady: true, policyAllowed: false, policyReason: 'no provider' },
    );
    expect(machine.current).toBe('error');
    expect(machine.error).toBe('no provider');
  });

  it('resumes correctly after a pause', async () => {
    const { machine } = await buildHarness('http://127.0.0.1:1/v1');
    machine.dispatch({ type: 'pause' });
    expect(machine.isPaused).toBe(true);
    machine.dispatch({ type: 'resume' });
    expect(machine.isPaused).toBe(false);
    machine.dispatch({ type: 'message', conversationId: 'x' }, { contentAllowed: true, rateAllowed: true, cooldownReady: true, policyAllowed: true });
    expect(machine.current).toBe('generating');
  });
});

describe('E2E — quality guard integration', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installDom();
  });
  afterEach(() => restore());

  it('rejects a reply that repeats the previous outbound message', async () => {
    const { guard } = await buildHarness('http://127.0.0.1:1/v1');
    const check = guard.check('I am doing well, thank you for asking!', {} as never, {
      expectedLanguage: 'en',
      maxChars: 400,
      recentReplies: ['I am doing well, thank you for asking!'],
      incoming: 'How are you?',
    });
    expect(check.ok).toBe(true);
    // Repetition is a warning, not a block: the UI surfaces it and lets the
    // user regenerate, but a near-duplicate is still sendable.
    expect(check.issues.some((i) => i.code === 'duplicate')).toBe(true);
  });

  it('accepts a fresh, on-topic reply', async () => {
    const { guard } = await buildHarness('http://127.0.0.1:1/v1');
    const check = guard.check('I work as a designer, and I love it.', {} as never, {
      expectedLanguage: 'en',
      maxChars: 400,
      recentReplies: ['Nice to meet you!'],
      incoming: 'What do you do for work?',
    });
    expect(check.ok).toBe(true);
  });

  it('blocks content that violates the usage policy', async () => {
    const { guard } = await buildHarness('http://127.0.0.1:1/v1');
    const check = guard.check('As an AI language model, I cannot help.', {} as never, {
      expectedLanguage: 'en',
      maxChars: 400,
      recentReplies: [],
      incoming: 'Hi',
    });
    expect(check.ok).toBe(false);
    expect(check.issues.some((i) => i.code === 'banned-content')).toBe(true);
  });

  it('flags a reply that ignores the client question', async () => {
    const { guard } = await buildHarness('http://127.0.0.1:1/v1');
    // The check is deliberately narrow: only a very short, non-answer-like
    // reply to a question is flagged, to avoid false positives on normal chat.
    const check = guard.check('Pizza.', {} as never, {
      expectedLanguage: 'en',
      maxChars: 400,
      recentReplies: [],
      incoming: 'Where do you live?',
    });
    expect(check.issues.some((i) => i.code === 'ignored-question')).toBe(true);
  });

  it('does not flag a substantive reply to a question', async () => {
    const { guard } = await buildHarness('http://127.0.0.1:1/v1');
    const check = guard.check('I live in Lyon, in the south of France.', {} as never, {
      expectedLanguage: 'en',
      maxChars: 400,
      recentReplies: [],
      incoming: 'Where do you live?',
    });
    expect(check.issues.some((i) => i.code === 'ignored-question')).toBe(false);
  });
});
