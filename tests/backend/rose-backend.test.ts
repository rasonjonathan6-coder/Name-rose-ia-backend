// @vitest-environment node
/**
 * Tests for the ROSE backend proxy.
 *
 * The upstream OpenRouter endpoint is replaced by a local HTTP server, so the
 * real request construction, header handling, error mapping and — most
 * importantly — the guarantee that the credential never escapes are all
 * exercised. No real provider credential is involved or required.
 *
 * The module reads its configuration at import time, so each case imports it
 * fresh with `vi.resetModules()` after setting the environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';

const TEST_KEY = 'test-key-not-a-real-credential';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let upstream: Server | null = null;
let backend: Server | null = null;
const captured: Captured[] = [];

async function startUpstream(status: number, body: string): Promise<string> {
  captured.length = 0;
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      captured.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body: raw });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  const { port } = upstream!.address() as { port: number };
  return `http://127.0.0.1:${port}/v1`;
}

/** Loads the backend module fresh, with the given environment, and starts it. */
async function startBackend(env: Record<string, string>): Promise<string> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = (await import('../../backend/rose-backend.mjs')) as {
    createRoseBackend: () => Server;
  };
  backend = mod.createRoseBackend();
  await new Promise<void>((resolve) => backend!.listen(0, '127.0.0.1', resolve));
  const { port } = backend!.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

const COMPLETION = JSON.stringify({
  id: 'gen-test',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello! I am well.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
});

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ROSE_BACKEND_TOKEN;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.ALLOWED_ORIGINS;
});

afterEach(async () => {
  for (const s of [backend, upstream]) {
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  backend = null;
  upstream = null;
});

function ask(base: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hello, how are you?' }] }),
  });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('ROSE backend — health', () => {
  it('reports ok and keyConfigured=true when a key is present', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });

    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.provider).toBe('openrouter');
    expect(body.keyConfigured).toBe(true);
  });

  it('reports degraded when no key is configured', async () => {
    const base = await startBackend({ OPENROUTER_BASE_URL: 'http://127.0.0.1:1/v1' });
    const body = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.keyConfigured).toBe(false);
  });

  it('never exposes the key through /health', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });

    const raw = await (await fetch(`${base}/health`)).text();
    expect(raw).not.toContain(TEST_KEY);
    expect(raw).not.toMatch(/sk-or-v1-/);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('ROSE backend — generation', () => {
  it('forwards the completion and returns the provider response', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });

    const res = await ask(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('Hello! I am well.');
  });

  it('attaches the key server-side and never returns it', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });

    const raw = await (await ask(base)).text();
    expect(raw).not.toContain(TEST_KEY);
    // The key did reach the provider, as a bearer header.
    expect(captured[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(captured[0].url).toContain('/chat/completions');
  });

  it('accepts the request without any client credential when no backend token is set', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });

    expect((await ask(base)).status).toBe(200);
  });

  it('answers CORS preflight', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });

    const res = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// ---------------------------------------------------------------------------
// Backend token
// ---------------------------------------------------------------------------

describe('ROSE backend — backend token', () => {
  it('rejects a request with no token', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({
      OPENROUTER_API_KEY: TEST_KEY,
      OPENROUTER_BASE_URL: up,
      ROSE_BACKEND_TOKEN: 'gateway-token',
    });

    const res = await ask(base);
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0); // never reached the provider
  });

  it('accepts the correct token and forwards the provider credential instead', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({
      OPENROUTER_API_KEY: TEST_KEY,
      OPENROUTER_BASE_URL: up,
      ROSE_BACKEND_TOKEN: 'gateway-token',
    });

    const res = await ask(base, { authorization: 'Bearer gateway-token' });
    expect(res.status).toBe(200);
    // The caller's token must not be forwarded upstream; the provider key is.
    expect(captured[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('rejects a wrong token of the same length', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({
      OPENROUTER_API_KEY: TEST_KEY,
      OPENROUTER_BASE_URL: up,
      ROSE_BACKEND_TOKEN: 'gateway-token',
    });

    expect((await ask(base, { authorization: 'Bearer gateway-tokeX' })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe('ROSE backend — failures', () => {
  it('refuses to forward when no key is configured (503, no upstream call)', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({ OPENROUTER_BASE_URL: up });

    const res = await ask(base);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('no-key');
    expect(captured).toHaveLength(0);
  });

  it.each([
    [401, 'unauthorized'],
    [402, 'credits'],
    [429, 'rate-limited'],
    [500, 'server'],
    [503, 'server'],
  ])('maps upstream %i to a typed %s error', async (status, code) => {
    const up = await startUpstream(status, JSON.stringify({ error: { message: 'upstream says no' } }));
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });

    const res = await ask(base);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(code);
    expect([401, 402, 429, 502]).toContain(res.status);
  });

  it('redacts a credential echoed back in an upstream error body', async () => {
    const up = await startUpstream(401, JSON.stringify({ error: { message: `bad key ${TEST_KEY}` } }));
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });

    const raw = await (await ask(base)).text();
    expect(raw).not.toContain(TEST_KEY);
    expect(raw).toContain('[redacted]');
  });

  it('rejects a body that is not JSON', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 502 when the upstream is unreachable', async () => {
    // Port 1 is reserved and refuses connections.
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: 'http://127.0.0.1:1/v1' });

    const res = await ask(base);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('network');
  });

  it('rejects a non-POST completion request', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });

    expect((await fetch(`${base}/v1/chat/completions`)).status).toBe(405);
  });

  it('404s an unknown path', async () => {
    const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: 'http://127.0.0.1:1/v1' });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// CORS allowlist
// ---------------------------------------------------------------------------

describe('ROSE backend — ALLOWED_ORIGINS', () => {
  it('echoes an allowed origin instead of *', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({
      OPENROUTER_API_KEY: TEST_KEY,
      OPENROUTER_BASE_URL: up,
      ALLOWED_ORIGINS: 'chrome-extension://abc,https://rose.example',
    });

    const res = await fetch(`${base}/health`, { headers: { origin: 'https://rose.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://rose.example');
  });

  it('omits the CORS header for an origin that is not allowed', async () => {
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({
      OPENROUTER_API_KEY: TEST_KEY,
      OPENROUTER_BASE_URL: up,
      ALLOWED_ORIGINS: 'https://rose.example',
    });

    const res = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('vary')).toBe('origin');
  });

  it('still serves the request body to a disallowed origin (CORS is browser-enforced)', async () => {
    // The server does not block the request; it declines to authorise the
    // browser to read the response. Worth pinning so the behaviour is known.
    const up = await startUpstream(200, COMPLETION);
    const base = await startBackend({
      OPENROUTER_API_KEY: TEST_KEY,
      OPENROUTER_BASE_URL: up,
      ALLOWED_ORIGINS: 'https://rose.example',
    });

    const res = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Host binding
// ---------------------------------------------------------------------------

describe('ROSE backend — host binding', () => {
  // Runs the real process: the host is chosen at import time, and importing the
  // module repeatedly would hit Node's module cache and re-report the first
  // evaluation. Spawning also exercises the actual startup path.
  const hostFor = (env: Record<string, string>): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['backend/rose-backend.mjs'], {
        env: { ...cleanEnv, ...env, PORT: '0', OPENROUTER_API_KEY: 'dummy-not-a-credential' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      const done = (fn: () => void) => {
        child.kill();
        fn();
      };
      const timer = setTimeout(() => done(() => reject(new Error(`no startup line; got: ${out}`))), 10_000);
      child.stdout.on('data', (c) => {
        out += String(c);
        const m = out.match(/listening host=(\S+)/);
        if (m) {
          clearTimeout(timer);
          done(() => resolve(m[1]));
        }
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

  const cleanEnv = (() => {
    const env = { ...process.env } as Record<string, string>;
    for (const k of ['RENDER', 'RENDER_EXTERNAL_URL', 'RAILWAY_ENVIRONMENT', 'DYNO', 'FLY_APP_NAME', 'K_SERVICE', 'HOST', 'PORT', 'WEBSITE_SITE_NAME', 'VERCEL']) {
      delete env[k];
    }
    return env;
  })();

  it('binds loopback when run plainly on a laptop', async () => {
    expect(await hostFor({})).toBe('127.0.0.1');
  });

  it('binds all interfaces when a platform marker is present', async () => {
    expect(await hostFor({ RENDER: 'true' })).toBe('0.0.0.0');
    expect(await hostFor({ RAILWAY_ENVIRONMENT: 'production' })).toBe('0.0.0.0');
    expect(await hostFor({ DYNO: 'web.1' })).toBe('0.0.0.0');
  });

  it('honours an explicit HOST over detection', async () => {
    expect(await hostFor({ RENDER: 'true', HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });
});

// ---------------------------------------------------------------------------
// Log hygiene
// ---------------------------------------------------------------------------

describe('ROSE backend — log hygiene', () => {
  it('never writes the key to stdout', async () => {
    const up = await startUpstream(200, COMPLETION);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      const base = await startBackend({ OPENROUTER_API_KEY: TEST_KEY, OPENROUTER_BASE_URL: up });
      await ask(base);
    } finally {
      spy.mockRestore();
    }

    const all = writes.join('');
    expect(all).not.toContain(TEST_KEY);
    expect(all).not.toMatch(/sk-or-v1-/);
  });
});
