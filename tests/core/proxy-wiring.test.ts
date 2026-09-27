// @vitest-environment node
/**
 * The extension must never hold a provider credential when it talks to the ROSE
 * backend. These cases drive the real GenerationService against a local server
 * that impersonates the backend, and assert on what the extension actually put
 * on the wire: the routing hints it must send, and the model name it must NOT.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { GenerationService } from '@/core/ai/generation-service';
import type { AIProviderConfig, ClientMemory, GenerationRequest } from '@/shared/types';

const proxyProvider: AIProviderConfig = {
  id: 'rose-backend',
  label: 'ROSE Backend',
  baseUrl: 'https://example.invalid/v1',
  model: 'rose-default',
  fastModel: 'rose-fast',
  apiKey: '',
  temperature: 0.85,
  maxTokens: 320,
  enabled: true,
  viaProxy: true,
};

let server: Server | null = null;
let lastBody: Record<string, unknown> | null = null;
let lastHeaders: Record<string, string | string[] | undefined> = {};

async function serve(content: string): Promise<string> {
  lastBody = null;
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'groq/llama-3.1-8b-instant',
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server!.address() as { port: number }).port;
  return `http://127.0.0.1:${port}/v1`;
}

function memory(): ClientMemory {
  return {
    id: 'generic:alice',
    platform: 'generic',
    clientId: 'alice',
    displayName: 'Alice',
    language: 'en',
    conversationId: 'c1',
    summary: '',
    recentMessages: [],
    importantFacts: [],
    preferences: {},
    topics: [],
    lastInteraction: Date.now(),
    createdAt: Date.now(),
    metadata: { messageCount: 3, platformsSeen: ['generic'], tokensSaved: 0, version: 1 },
  };
}

function request(over: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    conversation: {
      id: 'generic:alice',
      platform: 'generic',
      clientId: 'alice',
      displayName: 'Alice',
      conversationId: 'c1',
      url: 'http://localhost/demo',
    },
    memory: memory(),
    incoming: 'What do you do for a living?',
    history: [],
    style: 'natural',
    length: 'medium',
    count: 3,
    targetLanguage: 'en',
    ...over,
  };
}

function serviceAt(baseUrl: string) {
  return new GenerationService({
    getActiveProvider: async () => ({ ...proxyProvider, baseUrl }),
    getApiKey: async () => '',
  });
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

const SUGGESTIONS = JSON.stringify({
  suggestions: [
    { kind: 'natural', text: 'I work as a designer.' },
    { kind: 'warm', text: 'I am a designer, and I love it.' },
    { kind: 'engaging', text: 'Designer here — what about you?' },
  ],
});

describe('GenerationService — proxy backend wiring', () => {
  it('does not send the extension placeholder model to the backend', async () => {
    const base = await serve(SUGGESTIONS);
    await serviceAt(base).generate(request(), { force: true });
    // The backend picks the real model; a placeholder would address a model it
    // does not have.
    expect(lastBody?.model).toBeUndefined();
  });

  it('tags the request as a generation task so the router can pick a role', async () => {
    const base = await serve(SUGGESTIONS);
    await serviceAt(base).generate(request(), { force: true });
    expect(lastBody?.rose_task).toBe('generation');
  });

  it('flags a complex message for the complex role', async () => {
    const base = await serve(SUGGESTIONS);
    const long = 'I have been thinking a lot about what you said last night and I feel confused.';
    await serviceAt(base).generate(request({ incoming: long }), { force: true });
    expect(lastBody?.rose_complex).toBe(true);
  });

  it('sends no Authorization header when no local key is configured', async () => {
    const base = await serve(SUGGESTIONS);
    await serviceAt(base).generate(request(), { force: true });
    expect(lastHeaders.authorization).toBeUndefined();
  });

  it('still returns parsed suggestions from the backend response', async () => {
    const base = await serve(SUGGESTIONS);
    const res = await serviceAt(base).generate(request(), { force: true });
    expect(res.suggestions).toHaveLength(3);
    expect(res.suggestions[0]!.text).toBe('I work as a designer.');
  });

  it('reports the model the backend actually used, not the placeholder', async () => {
    const base = await serve(SUGGESTIONS);
    const res = await serviceAt(base).generate(request(), { force: true });
    expect(res.model).toBe('groq/llama-3.1-8b-instant');
  });

  it('tags a translation as a translation task', async () => {
    const base = await serve('{"translation":"Bonjour"}');
    await serviceAt(base).translate('Hello', 'fr', 'natural');
    expect(lastBody?.rose_task).toBe('translation');
    expect(lastBody?.model).toBeUndefined();
  });
});
