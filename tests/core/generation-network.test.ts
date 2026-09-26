// @vitest-environment node
/**
 * Runs in the Node environment rather than jsdom.
 *
 * These cases drive the real GenerationService against a real local HTTP
 * server, so the actual fetch, JSON extraction and guard paths run. jsdom
 * hands Node's fetch an AbortSignal it refuses to accept ("Expected signal to
 * be an instance of AbortSignal"), which made every request fail with a
 * network error for reasons unrelated to the code under test.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { GenerationService } from '@/core/ai/generation-service';
import type { AIProviderConfig } from '@/shared/types';

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

let server: Server | null = null;
let replyBody = '[]';

async function serve(reply: string): Promise<string> {
  replyBody = reply;
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: replyBody }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server!.address() as { port: number }).port;
  return `http://127.0.0.1:${port}/v1`;
}

function serviceAt(baseUrl: string, onUsage?: (u: unknown) => void) {
  return new GenerationService({
    getActiveProvider: async () => ({ ...provider, baseUrl }),
    getApiKey: async () => 'key',
    onUsage: onUsage as never,
  });
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

// ---------------------------------------------------------------------------
// Fact extraction and translation
//
// Both are driven against a real local HTTP server so the actual JSON
// extraction, normalisation and guard paths run — the parts that broke in
// practice against a real model.
// ---------------------------------------------------------------------------

describe('GenerationService — fact extraction', () => {
  it('reads a bare fact object as a one-item list', async () => {
    // Real models answer with a single object when a message yields one fact,
    // even though the prompt asks for an array. Dropping that reply silently
    // lost the fact.
    const base = await serve('{"key":"name","value":"Sofia","weight":1.0}');
    const svc = serviceAt(base);
    const facts = await svc.extractFacts('My name is Sofia.', []);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: 'name', value: 'Sofia' });
  });

  it('reads an array of facts', async () => {
    const base = await serve('[{"key":"city","value":"Madrid"},{"key":"job","value":"nurse"}]');
    const svc = serviceAt(base);
    const facts = await svc.extractFacts('I live in Madrid and I am a nurse.', []);
    expect(facts.map((f) => f.key)).toEqual(['city', 'job']);
  });

  it('reads a {facts:[...]} envelope', async () => {
    const base = await serve('{"facts":[{"key":"city","value":"Madrid"}]}');
    const svc = serviceAt(base);
    const facts = await svc.extractFacts('I live in Madrid.', []);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe('Madrid');
  });

  it('drops malformed entries instead of crashing', async () => {
    const base = await serve('[{"key":"ok","value":"yes"},{"nope":1},"junk",null]');
    const svc = serviceAt(base);
    const facts = await svc.extractFacts('anything', []);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.key).toBe('ok');
  });

  it('returns nothing for an empty array', async () => {
    const base = await serve('[]');
    const svc = serviceAt(base);
    expect(await svc.extractFacts('hello there', [])).toEqual([]);
  });
});

describe('GenerationService — translation guard', () => {
  it('refuses an empty request without calling the provider', async () => {
    let calls = 0;
    const counting = createServer((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '""""""' } }] }));
    });
    await new Promise<void>((r) => counting.listen(0, '127.0.0.1', r));
    const port = (counting.address() as { port: number }).port;

    const svc = serviceAt(`http://127.0.0.1:${port}/v1`);
    expect(await svc.translate('', 'en', 'neutral')).toBeNull();
    expect(await svc.translate('   ', 'en', 'neutral')).toBeNull();
    expect(calls).toBe(0);
    await new Promise<void>((r) => counting.close(() => r()));
  });
});
