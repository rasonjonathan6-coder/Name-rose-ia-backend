// @vitest-environment node
/**
 * Tests for the multi-provider registry, health tracking and model router.
 *
 * Everything here runs against the real modules. Provider "verification" is
 * exercised against a local HTTP server so no external call and no credential is
 * needed; the ability to detect a *real* failure is what these tests pin.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import {
  PROVIDER_DEFS,
  baseUrlOf,
  chainFor,
  hasAnyProvider,
  listProviders,
  providerDef,
  resolveProvider,
  roleProviderId,
  verifyProvider,
  __resetVerifyCache,
} from '../../backend/providers.mjs';
import {
  DEGRADE_AFTER,
  isDegraded,
  recordFailure,
  recordSuccess,
  statusOf,
  __resetHealth,
} from '../../backend/health.mjs';
import { classifyFailure, orderChain, pickModelForRole, roleForTask, routeCompletion } from '../../backend/router.mjs';

let upstream: Server | null = null;

async function startUpstream(
  handler: (n: number) => { status: number; body: string },
): Promise<string> {
  let calls = 0;
  upstream = createServer((_req, res) => {
    calls += 1;
    const { status, body } = handler(calls);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  const { port } = upstream!.address() as { port: number };
  return `http://127.0.0.1:${port}/v1`;
}

afterEach(async () => {
  if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  upstream = null;
});

beforeEach(() => {
  __resetHealth();
  __resetVerifyCache();
});

const env = (over: Record<string, string> = {}) => ({ ...over }) as NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

describe('ProviderRegistry — configuration', () => {
  it('declares every provider the mission requires', () => {
    const ids = PROVIDER_DEFS.map((p) => p.id);
    for (const id of ['openrouter', 'gemini', 'groq', 'cerebras', 'mistral', 'nvidia', 'cloudflare']) {
      expect(ids).toContain(id);
    }
  });

  it('uses the documented base URLs', () => {
    const cases: Array<[string, string]> = [
      ['openrouter', 'https://openrouter.ai/api/v1'],
      ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'],
      ['groq', 'https://api.groq.com/openai/v1'],
      ['cerebras', 'https://api.cerebras.ai/v1'],
      ['mistral', 'https://api.mistral.ai/v1'],
      ['nvidia', 'https://integrate.api.nvidia.com/v1'],
    ];
    for (const [id, url] of cases) {
      expect(baseUrlOf(providerDef(id)!, env())).toBe(url);
    }
  });

  it('builds the Cloudflare URL from the account id', () => {
    const url = baseUrlOf(providerDef('cloudflare')!, env({ CLOUDFLARE_ACCOUNT_ID: 'acct-123' }));
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1');
  });

  it('is not configured when the credential variable is absent', () => {
    expect(resolveProvider('openrouter', env())!.configured).toBe(false);
    expect(hasAnyProvider(env())).toBe(false);
  });

  it('is not configured when the credential variable exists but is blank', () => {
    // A blank variable is a very common deployment mistake; treating it as a
    // credential turns a clear config error into an opaque upstream 401.
    expect(resolveProvider('openrouter', env({ OPENROUTER_API_KEY: '   ' }))!.configured).toBe(false);
    expect(hasAnyProvider(env({ OPENROUTER_API_KEY: '' }))).toBe(false);
  });

  it('is configured once its credential is present', () => {
    const p = resolveProvider('openrouter', env({ OPENROUTER_API_KEY: 'not-a-real-key' }))!;
    expect(p.configured).toBe(true);
    expect(hasAnyProvider(env({ OPENROUTER_API_KEY: 'not-a-real-key' }))).toBe(true);
  });

  it('requires BOTH Cloudflare variables', () => {
    expect(resolveProvider('cloudflare', env({ CLOUDFLARE_API_TOKEN: 'tok' }))!.configured).toBe(false);
    expect(
      resolveProvider('cloudflare', env({ CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' }))!
        .configured,
    ).toBe(true);
  });

  it('never exposes a credential through listProviders', () => {
    const listed = listProviders(env({ OPENROUTER_API_KEY: 'super-secret-value' }));
    const raw = JSON.stringify(listed);
    expect(raw).not.toContain('super-secret-value');
    expect(listed.find((p) => p.id === 'openrouter')!.configured).toBe(true);
  });

  it('does not list unconfigured providers as usable in a chain', () => {
    expect(chainFor('primary', env())).toHaveLength(0);
  });

  it('orders the chain with the role provider first', () => {
    const chain = chainFor(
      'primary',
      env({ OPENROUTER_API_KEY: 'k1', GROQ_API_KEY: 'k2', GEMINI_API_KEY: 'k3' }),
    );
    expect(chain[0]!.id).toBe('openrouter');
    expect(chain.map((p) => p.id)).toContain('groq');
    expect(chain.map((p) => p.id)).toContain('gemini');
  });

  it('honours an explicit role override', () => {
    expect(roleProviderId('primary', env({ ROSE_ROLE_PRIMARY: 'groq' }))).toBe('groq');
  });

  it('defaults the roles to the documented assignment', () => {
    expect(roleProviderId('primary', env())).toBe('openrouter');
    expect(roleProviderId('fast', env())).toBe('groq');
    expect(roleProviderId('complex', env())).toBe('cerebras');
    expect(roleProviderId('translation', env())).toBe('mistral');
  });

  it('degrades gracefully for an unknown role', () => {
    expect(roleProviderId('nonexistent' as never, env())).toBe('openrouter');
  });
});

// ---------------------------------------------------------------------------
// Provider health / verification
// ---------------------------------------------------------------------------

describe('ProviderHealth — real verification', () => {
  it('reports unavailable when not configured, without a request', async () => {
    expect(await verifyProvider('groq', { env: env() })).toEqual({
      id: 'groq',
      available: false,
      reason: 'not-configured',
    });
  });

  it('reports available only after a real successful request', async () => {
    const base = await startUpstream(() => ({ status: 200, body: '{"choices":[]}' }));
    const result = await verifyProvider('groq', {
      env: env({ GROQ_API_KEY: 'k', GROQ_BASE_URL: base }),
    });
    expect(result.available).toBe(true);
    expect(result.status).toBe(200);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('reports a credential rejection distinctly from an outage', async () => {
    const base = await startUpstream(() => ({ status: 401, body: '{"error":{}}' }));
    const result = await verifyProvider('groq', {
      env: env({ GROQ_API_KEY: 'k', GROQ_BASE_URL: base }),
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('unauthorized');
  });

  it('distinguishes a wrong model name from an auth failure', async () => {
    const base = await startUpstream(() => ({ status: 404, body: '{"error":{}}' }));
    const result = await verifyProvider('groq', {
      env: env({ GROQ_API_KEY: 'k', GROQ_BASE_URL: base }),
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('model-not-found');
  });

  it('reports a network failure rather than inventing a result', async () => {
    // Port 1 is reserved and refuses connections.
    const result = await verifyProvider('groq', {
      env: env({ GROQ_API_KEY: 'k', GROQ_BASE_URL: 'http://127.0.0.1:1/v1' }),
      timeoutMs: 3000,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('network');
  });

  it('never includes the credential in the verification result', async () => {
    const base = await startUpstream(() => ({ status: 200, body: '{"choices":[]}' }));
    const result = await verifyProvider('groq', {
      env: env({ GROQ_API_KEY: 'secret-verification-key', GROQ_BASE_URL: base }),
    });
    expect(JSON.stringify(result)).not.toContain('secret-verification-key');
  });
});

describe('ProviderHealth — metrics and degradation', () => {
  it('starts UNKNOWN with no successful call', () => {
    expect(statusOf('groq').state).toBe('UNKNOWN');
  });

  it('becomes HEALTHY after a success', () => {
    recordSuccess('groq', 120);
    const s = statusOf('groq');
    expect(s.state).toBe('HEALTHY');
    expect(s.latencyMs).toBe(120);
    expect(isDegraded('groq')).toBe(false);
  });

  it('degrades only after the configured number of transient failures', () => {
    for (let i = 0; i < DEGRADE_AFTER; i++) recordFailure('groq', 'server');
    expect(isDegraded('groq')).toBe(true);
    expect(statusOf('groq').state).toBe('DEGRADED');
  });

  it('counts failure kinds separately', () => {
    recordFailure('groq', 'timeout');
    recordFailure('groq', 'rate-limited');
    recordFailure('groq', 'server');
    const s = statusOf('groq');
    expect(s.timeoutCount).toBe(1);
    expect(s.rateLimitCount).toBe(1);
    expect(s.serverErrorCount).toBe(1);
  });

  it('degrades immediately on an authentication failure', () => {
    recordFailure('groq', 'unauthorized');
    expect(isDegraded('groq')).toBe(true);
    expect(statusOf('groq').state).toBe('AUTH_FAILED');
    expect(statusOf('groq').authError).toBe(true);
  });

  it('clears degradation after a success', () => {
    recordFailure('groq', 'unauthorized');
    expect(isDegraded('groq')).toBe(true);
    recordSuccess('groq', 90);
    expect(isDegraded('groq')).toBe(false);
    expect(statusOf('groq').authError).toBe(false);
  });

  it('expires degradation after its TTL rather than staying degraded forever', () => {
    recordFailure('groq', 'server');
    recordFailure('groq', 'server');
    const later = Date.now() + 1000_000;
    expect(isDegraded('groq', later)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

describe('ModelRouter — roles', () => {
  it('routes a plain generation to the primary role', () => {
    expect(roleForTask('generation', {})).toBe('primary');
  });

  it('routes a complex generation to the complex role', () => {
    expect(roleForTask('generation', { complex: true })).toBe('complex');
  });

  it('routes a translation to the translation role', () => {
    expect(roleForTask('translation', {})).toBe('translation');
  });

  it('uses the fast model for summaries and translation', () => {
    const p = { model: 'big', fastModel: 'small' } as never;
    expect(pickModelForRole(p, 'translation', {})).toBe('small');
    expect(pickModelForRole(p, 'primary', { summary: true })).toBe('small');
    expect(pickModelForRole(p, 'primary', {})).toBe('big');
    expect(pickModelForRole(p, 'complex', {})).toBe('big');
  });
});

describe('ModelRouter — failure classification', () => {
  it.each([
    [429, 'rate-limited', true],
    [500, 'server', true],
    [502, 'server', true],
    [503, 'server', true],
    [408, 'server', true],
  ])('treats HTTP %i as a retryable %s', (status, code, retryable) => {
    const f = classifyFailure({ status });
    expect(f.code).toBe(code);
    expect(f.retryable).toBe(retryable);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [402, 'credits'],
  ])('never retries HTTP %i (%s)', (status, code) => {
    const f = classifyFailure({ status });
    expect(f.code).toBe(code);
    expect(f.retryable).toBe(false);
  });

  it('classifies a timeout and a network error as retryable transport failures', () => {
    expect(classifyFailure({ error: { name: 'TimeoutError' } })).toEqual({
      retryable: true,
      code: 'timeout',
    });
    expect(classifyFailure({ error: new TypeError('fetch failed') })).toEqual({
      retryable: true,
      code: 'network',
    });
  });
});

describe('ModelRouter — fallback and retry', () => {
  const threeProviders = {
    OPENROUTER_API_KEY: 'k1',
    GROQ_API_KEY: 'k2',
    GEMINI_API_KEY: 'k3',
  };

  it('returns a clear error when nothing is configured', async () => {
    const res = await routeCompletion({
      role: 'primary',
      attempt: async () => {
        throw new Error('must not be called');
      },
      env: env(),
    });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('no-provider');
  });

  it('succeeds on the first provider without touching the fallback', async () => {
    const seen: string[] = [];
    const res = await routeCompletion({
      role: 'primary',
      attempt: async (p: { id: string }) => {
        seen.push(p.id);
        return { body: '{"ok":true}', model: 'm' };
      },
      env: env(threeProviders),
    });
    expect(res.ok).toBe(true);
    expect(seen).toEqual(['openrouter']);
  });

  it('falls back to the next provider after a retryable failure', async () => {
    const seen: string[] = [];
    const res = await routeCompletion({
      role: 'primary',
      attempt: async (p: { id: string }) => {
        seen.push(p.id);
        if (p.id === 'openrouter') throw { status: 503 };
        return { body: '{"ok":true}', model: 'm' };
      },
      env: env(threeProviders),
    });
    expect(res.ok).toBe(true);
    // The fallback tail follows the configured order; Gemini is next after
    // OpenRouter per DEFAULT_FALLBACK_ORDER, unless measured latency reorders it.
    expect(res.provider).toBe('gemini');
    expect(seen[0]).toBe('openrouter');
    expect(res.tried[0]!.provider).toBe('openrouter');
  });

  it('does NOT retry an auth failure and moves to the next provider', async () => {
    const counts = new Map<string, number>();
    const res = await routeCompletion({
      role: 'primary',
      attempt: async (p: { id: string }) => {
        counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
        if (p.id === 'openrouter') throw { status: 401 };
        return { body: '{"ok":true}', model: 'm' };
      },
      env: env(threeProviders),
    });
    expect(res.ok).toBe(true);
    // Exactly one attempt against the provider that rejected the credential.
    expect(counts.get('openrouter')).toBe(1);
  });

  it('retries a transient failure within the same provider before falling back', async () => {
    let calls = 0;
    const res = await routeCompletion({
      role: 'primary',
      attempt: async () => {
        calls += 1;
        if (calls === 1) throw { status: 429 };
        return { body: '{"ok":true}', model: 'm' };
      },
      env: env({ OPENROUTER_API_KEY: 'k1' }),
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
    expect(res.provider).toBe('openrouter');
  });

  it('reports a typed error when every provider fails', async () => {
    const res = await routeCompletion({
      role: 'primary',
      attempt: async () => {
        throw { status: 500 };
      },
      env: env(threeProviders),
    });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('server');
    expect(res.tried.length).toBeGreaterThan(1);
  });

  it('reports the transport code when the provider is unreachable', async () => {
    const res = await routeCompletion({
      role: 'primary',
      attempt: async () => {
        throw new TypeError('fetch failed');
      },
      env: env({ OPENROUTER_API_KEY: 'k1' }),
    });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('network');
  });

  it('is bounded: never more attempts than the configured budget', async () => {
    const calls: string[] = [];
    await routeCompletion({
      role: 'primary',
      attempt: async (p: { id: string }) => {
        calls.push(p.id);
        throw { status: 503 };
      },
      env: env(threeProviders),
    });
    // 3 providers x 2 attempts = 6, the documented ceiling.
    expect(calls.length).toBe(6);
  });

  it('records the failing provider in the health snapshot', async () => {
    await routeCompletion({
      role: 'primary',
      attempt: async () => {
        throw { status: 401 };
      },
      env: env(threeProviders),
    });
    expect(statusOf('openrouter').authError).toBe(true);
  });

  it('carries the upstream body through for the caller to redact', async () => {
    const res = await routeCompletion({
      role: 'primary',
      attempt: async () => {
        throw { status: 401, body: '{"error":"bad key"}' };
      },
      env: env({ OPENROUTER_API_KEY: 'k1' }),
    });
    expect(res.tried[0]!.upstream).toBe('{"error":"bad key"}');
  });
});

describe('ModelRouter — ordering by measured evidence', () => {
  it('keeps the role provider first regardless of other latencies', () => {
    recordSuccess('groq', 10);
    const chain: Array<{ id: string }> = [{ id: 'openrouter' }, { id: 'groq' }, { id: 'gemini' }];
    expect(orderChain(chain)[0]!.id).toBe('openrouter');
  });

  it('moves a degraded provider to the end of the fallback tail', () => {
    recordFailure('groq', 'server');
    recordFailure('groq', 'server');
    const chain: Array<{ id: string }> = [{ id: 'openrouter' }, { id: 'groq' }, { id: 'gemini' }];
    const ordered = orderChain<{ id: string }>(chain).map((p) => p.id);
    expect(ordered[0]).toBe('openrouter');
    expect(ordered[ordered.length - 1]).toBe('groq');
  });

  it('prefers the lower measured latency among the fallback tail', () => {
    recordSuccess('gemini', 400);
    recordSuccess('groq', 120);
    const chain: Array<{ id: string }> = [{ id: 'openrouter' }, { id: 'gemini' }, { id: 'groq' }];
    const ordered = orderChain<{ id: string }>(chain).map((p) => p.id);
    expect(ordered).toEqual(['openrouter', 'groq', 'gemini']);
  });

  it('keeps config order when no latency has been measured', () => {
    const chain: Array<{ id: string }> = [{ id: 'openrouter' }, { id: 'gemini' }, { id: 'groq' }];
    expect(orderChain(chain).map((p: { id: string }) => p.id)).toEqual(['openrouter', 'gemini', 'groq']);
  });
});
