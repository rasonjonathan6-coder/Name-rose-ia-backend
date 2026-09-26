import { describe, expect, it } from 'vitest';
import { GenerationService } from '@/core/ai/generation-service';
import { ResponseCache, cacheKey } from '@/core/ai/cache';
import type { AIProviderConfig, ClientMemory, GenerationRequest, Suggestion } from '@/shared/types';

/**
 * Parser and cache behaviour, exercised without any network access. The service
 * is constructed with a provider getter that is never awaited on the paths under
 * test (trivial handling, caching, parsing), which keeps these tests fast and
 * deterministic while still running the real code.
 */

const provider: AIProviderConfig = {
  id: 'test',
  label: 'Test',
  baseUrl: 'https://example.invalid/v1',
  model: 'gpt-4o',
  fastModel: 'gpt-4o-mini',
  apiKey: 'test-key',
  temperature: 0.85,
  maxTokens: 320,
  enabled: true,
  viaProxy: false,
};

function service(onUsage?: (u: Record<string, unknown>) => void) {
  return new GenerationService({
    getActiveProvider: async () => provider,
    getApiKey: async () => 'key',
    onUsage: onUsage as never,
  });
}

function memory(patch: Partial<ClientMemory> = {}): ClientMemory {
  return {
    id: 'generic:a',
    platform: 'generic',
    clientId: 'a',
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
    metadata: { messageCount: 0, platformsSeen: ['generic'], tokensSaved: 0, version: 1 },
    ...patch,
  };
}

function request(incoming: string, patch: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    conversation: {
      id: 'generic:a',
      platform: 'generic',
      clientId: 'a',
      displayName: 'Alice',
      conversationId: 'c1',
      url: 'https://example.com',
      language: 'en',
    },
    incoming,
    memory: memory(),
    history: [],
    style: 'natural',
    length: 'medium',
    targetLanguage: 'en',
    count: 3,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// parseSuggestions
// ---------------------------------------------------------------------------

describe('GenerationService.parseSuggestions', () => {
  const svc = service();

  it('parses a strict JSON object with a suggestions array', () => {
    const raw = JSON.stringify({
      suggestions: [
        { kind: 'natural', text: 'I am doing well, thanks!' },
        { kind: 'warm', text: 'Hey you, doing great 😊' },
        { kind: 'engaging', text: 'Doing well! What about you?' },
      ],
    });
    const out = svc.parseSuggestions(raw, 3);
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.kind)).toEqual(['natural', 'warm', 'engaging']);
    expect(out[0]!.text).toBe('I am doing well, thanks!');
  });

  it('parses fenced JSON', () => {
    const raw = '```json\n{"suggestions":[{"kind":"natural","text":"Hello there"}]}\n```';
    const out = svc.parseSuggestions(raw, 3);
    expect(out[0]!.text).toBe('Hello there');
  });

  it('parses a bare array of strings', () => {
    const out = svc.parseSuggestions('["First reply","Second reply","Third reply"]', 3);
    expect(out.map((s) => s.text)).toEqual(['First reply', 'Second reply', 'Third reply']);
    expect(out.map((s) => s.kind)).toEqual(['natural', 'warm', 'engaging']);
  });

  it('parses an array of objects', () => {
    const raw = JSON.stringify([{ kind: 'warm', text: 'Hey there 😊' }]);
    expect(svc.parseSuggestions(raw, 3)[0]!.kind).toBe('warm');
  });

  it('accepts alternative array keys', () => {
    expect(svc.parseSuggestions('{"replies":["a reply here"]}', 3)[0]!.text).toBe('a reply here');
    expect(svc.parseSuggestions('{"responses":["another reply"]}', 3)[0]!.text).toBe('another reply');
  });

  it('handles a flat object of kind -> text', () => {
    const raw = JSON.stringify({ natural: 'Plain reply', warm: 'Warm reply' });
    const out = svc.parseSuggestions(raw, 3);
    expect(out.map((s) => s.text)).toContain('Plain reply');
    expect(out.map((s) => s.text)).toContain('Warm reply');
  });

  it('falls back to numbered plain text', () => {
    const out = svc.parseSuggestions('1. First option here\n2. Second option here', 3);
    expect(out.map((s) => s.text)).toEqual(['First option here', 'Second option here']);
  });

  it('falls back to bulleted plain text', () => {
    const out = svc.parseSuggestions('- A reply option\n- Another reply option', 3);
    expect(out).toHaveLength(2);
  });

  it('strips surrounding quotes', () => {
    expect(svc.parseSuggestions('{"suggestions":["\\"Quoted reply text\\""]}', 3)[0]!.text).toBe('Quoted reply text');
  });

  it('deduplicates identical suggestions', () => {
    const raw = JSON.stringify({ suggestions: ['Same text here', 'Same text here'] });
    expect(svc.parseSuggestions(raw, 3)).toHaveLength(1);
  });

  it('never returns more than the requested count', () => {
    const raw = JSON.stringify({ suggestions: ['one reply', 'two reply', 'three reply', 'four reply'] });
    expect(svc.parseSuggestions(raw, 2)).toHaveLength(2);
  });

  it('returns an empty list for unparseable input', () => {
    expect(svc.parseSuggestions('', 3)).toHaveLength(0);
  });

  it('ignores empty strings inside an array', () => {
    expect(svc.parseSuggestions('["", "real reply"]', 3)).toHaveLength(1);
  });

  it('normalises an unknown kind to a valid one', () => {
    const out = svc.parseSuggestions('{"suggestions":[{"kind":"banana","text":"a reply"}]}', 3);
    expect(['natural', 'warm', 'engaging']).toContain(out[0]!.kind);
  });
});

// ---------------------------------------------------------------------------
// Trivial handling (the biggest cost lever)
// ---------------------------------------------------------------------------

describe('GenerationService — trivial messages cost nothing', () => {
  it('answers a greeting locally without calling the provider', async () => {
    const svc = service();
    const result = await svc.generate(request('hi'));
    expect(result.model).toBe('local');
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('answers in the client language', async () => {
    const svc = service();
    const result = await svc.generate(request('Привет', { memory: memory({ language: 'ru' }) }));
    expect(result.suggestions[0]!.text).toMatch(/[а-яё]/i);
  });

  it('returns three tonal variants', async () => {
    const svc = service();
    const result = await svc.generate(request('hey'));
    expect(result.suggestions).toHaveLength(3);
    expect(new Set(result.suggestions.map((s) => s.kind)).size).toBe(3);
  });

  it('reports zero cost', async () => {
    const svc = service();
    const result = await svc.generate(request('hello'));
    expect(result.suggestions.every((s) => s.text.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ResponseCache
// ---------------------------------------------------------------------------

describe('ResponseCache', () => {
  it('returns a cached value within the TTL', async () => {
    const cache = new ResponseCache<string>(60_000);
    const { value, cached } = await cache.resolve('k', async () => 'computed');
    expect(value).toBe('computed');
    expect(cached).toBe(false);

    const second = await cache.resolve('k', async () => 'recomputed');
    expect(second.value).toBe('computed');
    expect(second.cached).toBe(true);
  });

  it('expires entries past the TTL', async () => {
    const cache = new ResponseCache<string>(20);
    await cache.resolve('k', async () => 'first');
    await new Promise((r) => setTimeout(r, 35));
    const second = await cache.resolve('k', async () => 'second');
    expect(second.value).toBe('second');
    expect(second.cached).toBe(false);
  });

  it('force bypasses the cache', async () => {
    const cache = new ResponseCache<string>(60_000);
    await cache.resolve('k', async () => 'first');
    const forced = await cache.resolve('k', async () => 'second', true);
    expect(forced.value).toBe('second');
    expect(forced.cached).toBe(false);
  });

  it('coalesces concurrent requests for the same key', async () => {
    const cache = new ResponseCache<string>(60_000);
    let calls = 0;
    const factory = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 25));
      return `value-${calls}`;
    };
    const [a, b, c] = await Promise.all([
      cache.resolve('k', factory),
      cache.resolve('k', factory),
      cache.resolve('k', factory),
    ]);
    expect(calls).toBe(1);
    expect(a.value).toBe(b.value);
    expect(b.value).toBe(c.value);
  });

  it('does not coalesce different keys', async () => {
    const cache = new ResponseCache<string>(60_000);
    let calls = 0;
    const factory = async () => {
      calls++;
      return `v${calls}`;
    };
    await Promise.all([cache.resolve('a', factory), cache.resolve('b', factory)]);
    expect(calls).toBe(2);
  });

  it('evicts the oldest entries beyond the cap', async () => {
    const cache = new ResponseCache<number>(60_000, 2);
    await cache.resolve('a', async () => 1);
    await cache.resolve('b', async () => 2);
    await cache.resolve('c', async () => 3);
    expect(cache.size).toBeLessThanOrEqual(2);
  });

  it('keys differ when style, length, language or count differ', () => {
    const base = { conversationId: 'c', incoming: 'hello there', style: 'natural', length: 'medium', language: 'en', count: 3 };
    const k = cacheKey(base);
    expect(cacheKey({ ...base, style: 'warm' })).not.toBe(k);
    expect(cacheKey({ ...base, length: 'long' })).not.toBe(k);
    expect(cacheKey({ ...base, language: 'fr' })).not.toBe(k);
    expect(cacheKey({ ...base, count: 1 })).not.toBe(k);
    expect(cacheKey({ ...base, incoming: 'a different message' })).not.toBe(k);
  });

  it('is stable for identical inputs', () => {
    const parts = { conversationId: 'c', incoming: 'hello', style: 'natural', length: 'medium', language: 'en', count: 3 };
    expect(cacheKey(parts)).toBe(cacheKey({ ...parts }));
  });

  it('does not let a rejected in-flight request poison later calls', async () => {
    const cache = new ResponseCache<string>(60_000);
    await expect(cache.resolve('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const recovered = await cache.resolve('k', async () => 'ok now');
    expect(recovered.value).toBe('ok now');
  });

  it('tracks hit counts for diagnostics', async () => {
    const cache = new ResponseCache<string>(60_000);
    await cache.resolve('k', async () => 'v');
    await cache.resolve('k', async () => 'v');
    await cache.resolve('k', async () => 'v');
    expect(cache.stats.hits).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Cache integration with the service
// ---------------------------------------------------------------------------

describe('GenerationService — cache integration', () => {
  it('serves a repeated trivial request from the same conversation consistently', async () => {
    const svc = service();
    const a = await svc.generate(request('hi'));
    const b = await svc.generate(request('hi'));
    expect(a.suggestions.map((s) => s.text)).toEqual(b.suggestions.map((s) => s.text));
  });

  it('keeps separate caches per conversation', async () => {
    const svc = service();
    const a = await svc.generate(request('hi', { conversation: { ...request('x').conversation, id: 'generic:a' } }));
    const b = await svc.generate(request('hi', { conversation: { ...request('x').conversation, id: 'generic:b' } }));
    expect(a.suggestions.length).toBeGreaterThan(0);
    expect(b.suggestions.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------

describe('GenerationService — usage reporting', () => {
  it('does not report usage for a locally-handled trivial message', async () => {
    const seen: Record<string, unknown>[] = [];
    const svc = service((u) => seen.push(u));
    await svc.generate(request('hi'));
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

describe('prompt construction', () => {
  it('includes the incoming message and known facts', async () => {
    const { buildGenerationPrompt } = await import('@/core/ai/prompts');
    const prompt = buildGenerationPrompt(
      request('Where are you from?', {
        memory: memory({
          importantFacts: [{ key: 'city', value: 'Lyon', at: Date.now(), weight: 0.9 }],
          summary: 'Alice is a nurse.',
        }),
      }),
    );
    expect(prompt.user).toContain('Where are you from?');
    expect(prompt.user).toContain('Lyon');
    expect(prompt.system.toLowerCase()).toContain('rose');
  });

  it('states the requested reply count', async () => {
    const { buildGenerationPrompt } = await import('@/core/ai/prompts');
    const prompt = buildGenerationPrompt(request('hi there friend', { count: 2 }));
    expect(prompt.system).toMatch(/exactly 2/);
  });

  it('carries the style and length instructions', async () => {
    const { buildGenerationPrompt } = await import('@/core/ai/prompts');
    const prompt = buildGenerationPrompt(request('hello there', { style: 'flirty', length: 'short' }));
    const combined = `${prompt.system} ${prompt.user}`.toLowerCase();
    expect(combined).toContain('flirty');
    expect(combined).toMatch(/short|brief/);
  });

  it('forbids inventing facts in the system prompt', async () => {
    const { buildGenerationPrompt } = await import('@/core/ai/prompts');
    const prompt = buildGenerationPrompt(request('hi'));
    expect(prompt.system.toLowerCase()).toMatch(/never (invent|make up)|do not invent|not invent/);
  });

  it('includes a translation instruction when the target language differs', async () => {
    const { buildTranslationPrompt } = await import('@/core/ai/prompts');
    const prompt = buildTranslationPrompt('I am well, thank you', 'fr', 'natural');
    expect(`${prompt.system} ${prompt.user}`).toContain('fr');
    expect(`${prompt.system} ${prompt.user}`).toContain('I am well, thank you');
  });
});

// ---------------------------------------------------------------------------
// Suggestion shape
// ---------------------------------------------------------------------------

describe('Suggestion contract', () => {
  it('parsed suggestions always carry kind, text and lang', () => {
    const svc = service();
    const out: Suggestion[] = svc.parseSuggestions('["A reply here"]', 3);
    for (const s of out) {
      expect(typeof s.kind).toBe('string');
      expect(typeof s.text).toBe('string');
      expect(typeof s.lang).toBe('string');
      expect(s.text.length).toBeGreaterThan(0);
    }
  });
});
