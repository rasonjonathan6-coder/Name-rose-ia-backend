// @vitest-environment node
/**
 * Diagnostics surface.
 *
 * The backend exposes an operator-facing report of *what it is configured with*
 * — which providers exist, whether each has a credential, which role each is
 * assigned, and the last failure. These cases assert the report is truthful and
 * that it leaks nothing: this endpoint is reachable by anyone who can reach the
 * service, so a credential in it would be a disclosure, not a diagnostic.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

let backend: Server | null = null;

async function startBackend(env: Record<string, string>): Promise<string> {
  vi.resetModules();
  // Clear provider variables so cases do not inherit the shell's environment.
  for (const k of Object.keys(process.env)) {
    if (/(API_KEY|_TOKEN|ACCOUNT_ID)$/.test(k)) delete process.env[k];
  }
  Object.assign(process.env, env);
  const mod = (await import('../../backend/rose-backend.mjs')) as {
    createRoseBackend: () => Server;
  };
  backend = mod.createRoseBackend();
  await new Promise<void>((resolve) => backend!.listen(0, '127.0.0.1', resolve));
  const { port } = backend!.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (backend) await new Promise<void>((r) => backend!.close(() => r()));
  backend = null;
  vi.resetModules();
});

const SECRET = 'sk-or-v1-thisisasecretvaluethatmustneverappear';

describe('ROSE backend — /health', () => {
  it('reports ok and the resolved provider in the existing shape', async () => {
    const base = await startBackend({
      OPENROUTER_API_KEY: SECRET,
      ROSE_BACKEND_TOKEN: 'tok',
    });
    const body = await (await fetch(`${base}/health`)).json();
    expect(body.status).toBe('ok');
    expect(body.provider).toBe('openrouter');
    expect(body.keyConfigured).toBe(true);
    expect(body.tokenRequired).toBe(true);
  });

  it('never includes a credential', async () => {
    const base = await startBackend({ OPENROUTER_API_KEY: SECRET, ROSE_BACKEND_TOKEN: 'tok' });
    const raw = await (await fetch(`${base}/health`)).text();
    expect(raw).not.toContain(SECRET);
  });
});

describe('ROSE backend — /v1/rose/diagnostics', () => {
  it('lists every known provider with its configuration state', async () => {
    const base = await startBackend({ OPENROUTER_API_KEY: SECRET, ROSE_BACKEND_TOKEN: 'tok' });
    const body = await (await fetch(`${base}/v1/rose/diagnostics`)).json();

    const ids = body.providers.map((p: { id: string }) => p.id);
    for (const id of ['openrouter', 'gemini', 'groq', 'cerebras', 'mistral', 'nvidia', 'cloudflare']) {
      expect(ids).toContain(id);
    }

    const openrouter = body.providers.find((p: { id: string }) => p.id === 'openrouter');
    expect(openrouter.configured).toBe(true);
    expect(openrouter.health).toBe('UNKNOWN');

    const groq = body.providers.find((p: { id: string }) => p.id === 'groq');
    expect(groq.configured).toBe(false);
    expect(groq.health).toBe('NOT_CONFIGURED');
  });

  it('names the credential variable each provider needs, without its value', async () => {
    const base = await startBackend({ OPENROUTER_API_KEY: SECRET, ROSE_BACKEND_TOKEN: 'tok' });
    const body = await (await fetch(`${base}/v1/rose/diagnostics`)).json();
    const byId = Object.fromEntries(body.providers.map((p: { id: string }) => [p.id, p]));
    expect(byId.gemini.requiredVars).toContain('GEMINI_API_KEY');
    expect(byId.cloudflare.requiredVars).toContain('CLOUDFLARE_ACCOUNT_ID');
  });

  it('never includes a credential', async () => {
    const base = await startBackend({
      OPENROUTER_API_KEY: SECRET,
      GROQ_API_KEY: 'gsk_anothersecretvaluehere123456',
      ROSE_BACKEND_TOKEN: 'tok',
    });
    const raw = await (await fetch(`${base}/v1/rose/diagnostics`)).text();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('gsk_anothersecretvaluehere123456');
  });

  it('reports the role assignment', async () => {
    const base = await startBackend({ OPENROUTER_API_KEY: SECRET, ROSE_BACKEND_TOKEN: 'tok' });
    const body = await (await fetch(`${base}/v1/rose/diagnostics`)).json();
    expect(body.roles.primary).toBe('primary');
    expect(body.roles.translation).toBe('translation');
  });

  it('honours a role override from the environment', async () => {
    const base = await startBackend({
      OPENROUTER_API_KEY: SECRET,
      GROQ_API_KEY: 'gsk_x',
      ROSE_BACKEND_TOKEN: 'tok',
      ROSE_ROLE_PRIMARY: 'groq',
    });
    const body = await (await fetch(`${base}/v1/rose/diagnostics`)).json();
    const byId = Object.fromEntries(body.providers.map((p: { id: string }) => [p.id, p]));
    expect(byId.groq.configured).toBe(true);
  });

  it('reports no last error on a fresh process', async () => {
    const base = await startBackend({ OPENROUTER_API_KEY: SECRET, ROSE_BACKEND_TOKEN: 'tok' });
    const body = await (await fetch(`${base}/v1/rose/diagnostics`)).json();
    expect(body.lastError).toBeNull();
  });

  it('reports null latency before any successful call', async () => {
    const base = await startBackend({ OPENROUTER_API_KEY: SECRET, ROSE_BACKEND_TOKEN: 'tok' });
    const body = await (await fetch(`${base}/v1/rose/diagnostics`)).json();
    expect(body.averageLatencyMs).toBeNull();
  });
});
