// @vitest-environment node
/**
 * Runs in the Node environment rather than jsdom.
 *
 * The AI client is pure network code with no DOM dependency, and jsdom's
 * AbortController produces a signal that Node's fetch refuses to accept
 * ("Expected signal to be an instance of AbortSignal"), which would make every
 * request fail for reasons unrelated to the code under test.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AIClient, AIError } from '@/core/ai/client';
import type { AIProviderConfig } from '@/shared/types';

/**
 * The AI client is tested against a real local HTTP server rather than a mock.
 * That exercises the actual request construction, header handling, response
 * parsing, retry and error paths — the parts most likely to break against a
 * real provider.
 */

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let server: Server | null = null;
const captured: Captured[] = [];

async function startServer(handler: (req: Captured, res: ResponseBuilder) => void): Promise<string> {
  captured.length = 0;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const record: Captured = {
        url: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers as Record<string, string>,
        body: raw ? safeParse(raw) : null,
      };
      captured.push(record);
      const builder = makeBuilder(res);
      handler(record, builder);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server!.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/v1`;
}

interface ResponseBuilder {
  json(status: number, body: unknown): void;
  raw(status: number, body: string, contentType?: string): void;
}

function makeBuilder(res: import('node:http').ServerResponse): ResponseBuilder {
  return {
    json(status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
    raw(status, body, contentType = 'text/plain') {
      res.writeHead(status, { 'Content-Type': contentType });
      res.end(body);
    },
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function provider(baseUrl: string, over: Partial<AIProviderConfig> = {}): AIProviderConfig {
  return {
    id: 'test',
    label: 'Test provider',
    baseUrl,
    model: 'test-model',
    fastModel: 'test-fast',
    apiKey: 'test-key',
    temperature: 0.85,
    maxTokens: 320,
    enabled: true,
    viaProxy: false,
    ...over,
  };
}

/** A well-formed OpenAI-compatible chat completion. */
function completion(content: string, over: Record<string, unknown> = {}): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
    ...over,
  };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('AIClient — successful completion', () => {
  it('sends a well-formed chat completion request', async () => {
    const base = await startServer((_req, res) => res.json(200, completion('Hello there')));
    const client = new AIClient(async () => provider(base), async () => 'secret-key');

    const result = await client.complete({
      messages: [
        { role: 'system', content: 'You are ROSE.' },
        { role: 'user', content: 'Say hi' },
      ],
      model: 'test-model',
      maxTokens: 100,
    });

    expect(result.text).toBe('Hello there');
    expect(result.promptTokens).toBe(42);
    expect(result.completionTokens).toBe(17);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.url).toBe('/v1/chat/completions');

    const body = captured[0]!.body as { model: string; messages: unknown[]; max_tokens: number };
    expect(body.model).toBe('test-model');
    expect(body.messages).toHaveLength(2);
    expect(body.max_tokens).toBe(100);
  });

  it('authenticates with a bearer token', async () => {
    const base = await startServer((_req, res) => res.json(200, completion('ok')));
    const client = new AIClient(async () => provider(base), async () => 'secret-key');
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'test-model' });
    expect(captured[0]!.headers['authorization']).toBe('Bearer secret-key');
  });

  it('requests JSON output when asked', async () => {
    const base = await startServer((_req, res) => res.json(200, completion('{"a":1}')));
    const client = new AIClient(async () => provider(base), async () => 'k');
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm', json: true });
    const body = captured[0]!.body as { response_format?: { type: string } };
    expect(body.response_format?.type).toBe('json_object');
  });

  it('omits the JSON constraint by default', async () => {
    const base = await startServer((_req, res) => res.json(200, completion('ok')));
    const client = new AIClient(async () => provider(base), async () => 'k');
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });
    const body = captured[0]!.body as { response_format?: unknown };
    expect(body.response_format).toBeUndefined();
  });

  it('adds extra headers for OpenRouter', async () => {
    const base = await startServer((_req, res) => res.json(200, completion('ok')));
    const client = new AIClient(
      async () => provider(base, { id: 'openrouter' }),
      async () => 'k',
    );
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });
    expect(captured[0]!.headers['http-referer']).toBeTruthy();
    expect(captured[0]!.headers['x-title']).toBeTruthy();
  });

  it('reports latency', async () => {
    const base = await startServer((_req, res) => res.json(200, completion('ok')));
    const client = new AIClient(async () => provider(base), async () => 'k');
    const result = await client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.latencyMs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('AIClient — error handling', () => {
  it('throws a typed error carrying the provider message on 401', async () => {
    const base = await startServer((_req, res) =>
      res.json(401, { error: { message: 'Incorrect API key provided' } }),
    );
    const client = new AIClient(async () => provider(base), async () => 'bad');
    await expect(
      client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    ).rejects.toThrow(/Incorrect API key/);
  });

  it('surfaces a rate-limit error distinctly', async () => {
    const base = await startServer((_req, res) =>
      res.json(429, { error: { message: 'Rate limit reached' } }),
    );
    const client = new AIClient(async () => provider(base), async () => 'k');
    const err = await client
      .complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).code).toBe('rate-limited');
  });

  it('classifies an auth failure', async () => {
    const base = await startServer((_req, res) => res.json(403, { error: { message: 'Forbidden' } }));
    const client = new AIClient(async () => provider(base), async () => 'k');
    const err = (await client
      .complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })
      .catch((e: unknown) => e)) as AIError;
    expect(err.code).toBe('unauthorized');
  });

  it('classifies a server failure', async () => {
    const base = await startServer((_req, res) => res.json(500, { error: { message: 'boom' } }));
    const client = new AIClient(async () => provider(base), async () => 'k');
    const err = (await client
      .complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })
      .catch((e: unknown) => e)) as AIError;
    expect(err.code).toBe('server');
  });

  it('handles a non-JSON error body without crashing', async () => {
    const base = await startServer((_req, res) => res.raw(502, '<html>Bad gateway</html>'));
    const client = new AIClient(async () => provider(base), async () => 'k');
    const err = (await client
      .complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })
      .catch((e: unknown) => e)) as AIError;
    expect(err).toBeInstanceOf(AIError);
  });

  it('throws when the response has no content', async () => {
    const base = await startServer((_req, res) =>
      res.json(200, { choices: [{ message: { role: 'assistant' } }] }),
    );
    const client = new AIClient(async () => provider(base), async () => 'k');
    await expect(
      client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    ).rejects.toThrow(AIError);
  });

  it('never leaks the API key in an error message', async () => {
    const base = await startServer((_req, res) => res.json(401, { error: { message: 'Unauthorized' } }));
    const client = new AIClient(async () => provider(base), async () => 'super-secret-key-123');
    const err = (await client
      .complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })
      .catch((e: unknown) => e)) as AIError;
    expect(err.message).not.toContain('super-secret-key-123');
  });

  it('fails clearly when no provider is configured', async () => {
    const client = new AIClient(
      async () => {
        throw new Error('no provider');
      },
      async () => '',
    );
    await expect(
      client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }),
    ).rejects.toThrow();
  });

  it('still demands a key for a normal provider when none is stored', async () => {
    const base = await startServer((_req, res) => res.json(200, completion('unused')));
    const client = new AIClient(async () => provider(base), async () => '');
    const err = (await client
      .complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })
      .catch((e: unknown) => e)) as AIError;
    expect(err).toBeInstanceOf(AIError);
    expect(err.code).toBe('no-key');
  });

  it('does not demand a key when the provider declares it needs none', async () => {
    const base = await startServer((_req, res) => res.json(200, completion('keyless works')));
    const client = new AIClient(
      async () => provider(base, { requiresKey: false }),
      async () => '',
    );
    const res = await client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });
    expect(res.text).toBe('keyless works');
  });

  it('sends no Authorization header for a keyless provider', async () => {
    const base = await startServer((_req, res) => res.json(200, completion('ok')));
    const client = new AIClient(
      async () => provider(base, { requiresKey: false }),
      async () => '',
    );
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });
    expect(captured.at(-1)?.headers.authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Retry behaviour
// ---------------------------------------------------------------------------

describe('AIClient — retries', () => {
  it('retries once on a 429 and then succeeds', async () => {
    let calls = 0;
    const base = await startServer((_req, res) => {
      calls++;
      if (calls === 1) res.json(429, { error: { message: 'slow down' } });
      else res.json(200, completion('recovered'));
    });

    const client = new AIClient(async () => provider(base), async () => 'k');
    const result = await client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });
    expect(result.text).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('does not retry an auth failure', async () => {
    let calls = 0;
    const base = await startServer((_req, res) => {
      calls++;
      res.json(401, { error: { message: 'bad key' } });
    });
    const client = new AIClient(async () => provider(base), async () => 'k');
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }).catch(() => {});
    expect(calls).toBe(1);
  });

  it('gives up after the retry budget is exhausted', async () => {
    let calls = 0;
    const base = await startServer((_req, res) => {
      calls++;
      res.json(500, { error: { message: 'always broken' } });
    });
    const client = new AIClient(async () => provider(base), async () => 'k');
    await client.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }).catch(() => {});
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe('AIClient — cancellation', () => {
  it('aborts an in-flight request when the signal fires', async () => {
    const base = await startServer((_req, res) => {
      // Deliberately slow, so the abort lands first.
      setTimeout(() => res.json(200, completion('too late')), 300);
    });
    const client = new AIClient(async () => provider(base), async () => 'k');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const err = (await client
      .complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm', signal: controller.signal })
      .catch((e: unknown) => e)) as AIError;
    expect(err).toBeInstanceOf(AIError);
    expect(err.code).toBe('aborted');
  });
});
