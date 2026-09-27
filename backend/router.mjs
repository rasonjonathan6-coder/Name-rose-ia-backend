/**
 * Model router.
 *
 * Picks a provider/model for a task by *role* (primary / fast / complex /
 * translation) and walks a fallback chain when a call fails transiently.
 *
 * Design rules:
 *  - No provider is ranked by an invented quality score. Roles are configured,
 *    and the fallback order is configured; the router only respects them.
 *  - Retries happen inside a single provider for genuinely transient failures,
 *    and across providers once the chain is exhausted for that provider.
 *  - A non-retryable failure (bad credential) does not burn the whole chain's
 *    budget on retries: it moves straight to the next provider.
 *  - Bounded: at most `MAX_PROVIDER_HOPS` providers and `MAX_ATTEMPTS_PER_PROVIDER`
 *    attempts each. No unbounded loop is possible.
 */

import { chainFor } from './providers.mjs';
import { isDegraded, recordFailure, recordSuccess, statusOf } from './health.mjs';

const MAX_PROVIDER_HOPS = Number(process.env.ROSE_MAX_PROVIDER_HOPS ?? 3);
const MAX_ATTEMPTS_PER_PROVIDER = Number(process.env.ROSE_MAX_ATTEMPTS_PER_PROVIDER ?? 2);

/**
 * Orders the chain for a real attempt.
 *
 * The role's own provider is never displaced — that is the operator's stated
 * preference. The fallback tail is ordered by two *measured* signals and nothing
 * else: a currently degraded provider goes last, and among the rest the one with
 * the lower observed latency goes first. A provider with no measurement yet
 * keeps its configured position, so config still decides until evidence exists.
 */
export function orderChain(chain, now = Date.now()) {
  if (chain.length <= 1) return chain;
  const [first, ...rest] = chain;
  const measured = (id) => {
    const s = statusOf(id);
    return typeof s.latencyMs === 'number' ? s.latencyMs : null;
  };
  const ordered = [...rest].sort((a, b) => {
    const da = isDegraded(a.id, now) ? 1 : 0;
    const db = isDegraded(b.id, now) ? 1 : 0;
    if (da !== db) return da - db;
    const la = measured(a.id);
    const lb = measured(b.id);
    if (la === null && lb === null) return 0; // both unknown: keep config order
    if (la === null) return 1;
    if (lb === null) return -1;
    return la - lb;
  });
  return [first, ...ordered];
}

/** Statuses worth retrying: load, timeout and server faults, never auth. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

/** @returns {'generation'|'translation'} */
export function roleForTask(kind, meta = {}) {
  if (kind === 'translation') return 'translation';
  return meta.complex ? 'complex' : 'primary';
}

export function pickModelForRole(provider, role, meta = {}) {
  if (role === 'complex') return provider.model;
  if (role === 'translation') return provider.fastModel || provider.model;
  return meta.summary ? provider.fastModel || provider.model : provider.model;
}

/**
 * Classifies a failed attempt so the caller can decide whether to retry here or
 * move on. Kept separate from the HTTP call so it is directly testable.
 */
export function classifyFailure({ status, error }) {
  if (error) {
    const name = error?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return { retryable: true, code: 'timeout' };
    return { retryable: true, code: 'network' };
  }
  if (status === 401 || status === 403) return { retryable: false, code: 'unauthorized' };
  if (status === 402) return { retryable: false, code: 'credits' };
  if (status === 429) return { retryable: true, code: 'rate-limited' };
  if (RETRYABLE_STATUS.has(status)) return { retryable: true, code: 'server' };
  return { retryable: false, code: 'bad-response' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `attempt(provider, model)` down the chain for `role`.
 *
 * `attempt` must throw an object carrying `status` and/or `error`. The router
 * returns the first success, or a typed failure describing what was tried.
 */
export async function routeCompletion({
  role,
  meta = {},
  attempt,
  env = process.env,
  attentionBudget = 0,
}) {
  const chain = chainFor(role, env);
  if (chain.length === 0) {
    return {
      ok: false,
      error: {
        code: 'no-provider',
        message:
          'ROSE backend: no AI provider is configured. Set at least one provider credential (e.g. OPENROUTER_API_KEY) in the deployment environment.',
      },
      tried: [],
    };
  }

  const hops = orderChain(chain).slice(0, MAX_PROVIDER_HOPS);
  const tried = [];
  let lastFailure = null;

  for (const provider of hops) {
    const model = pickModelForRole(provider, role, meta);

    for (let n = 0; n < MAX_ATTEMPTS_PER_PROVIDER; n++) {
      const started = Date.now();
      try {
        const result = await attempt(provider, model);
        const latencyMs = Date.now() - started;
        recordSuccess(provider.id, latencyMs);
        return {
          ok: true,
          provider: provider.id,
          model: result.model ?? model,
          body: result.body,
          latencyMs,
          role,
          tried,
        };
      } catch (err) {
        // A thrown `{status, body}` is an HTTP failure; anything else (a fetch
        // TypeError, a TimeoutError) is a transport failure. Preserving that
        // distinction is what lets the caller report "network" versus
        // "bad-response" honestly.
        const httpFailure = err && typeof err === 'object' && 'status' in err;
        const failure = classifyFailure({
          status: httpFailure ? err.status : undefined,
          error: httpFailure ? undefined : err,
        });
        const entry = {
          provider: provider.id,
          model,
          code: failure.code,
          status: httpFailure ? err.status : null,
          latencyMs: Date.now() - started,
          /** Raw upstream body; redacted by the caller before it is serialised. */
          upstream: typeof err?.body === 'string' ? err.body : null,
        };
        tried.push(entry);
        lastFailure = entry;
        recordFailure(provider.id, failure.code);

        // A credential problem is a configuration fact, not a transient blip:
        // retrying it just burns the request budget.
        if (!failure.retryable) break;

        if (n < MAX_ATTEMPTS_PER_PROVIDER - 1) {
          const backoff = Math.min(2000, 250 * 2 ** n) * (0.7 + Math.random() * 0.6);
          await sleep(backoff + attentionBudget);
        }
      }
    }
  }

  const code = lastFailure?.code ?? 'unknown';
  return {
    ok: false,
    error: {
      code,
      message: messageFor(code),
      lastStatus: lastFailure?.status ?? null,
    },
    tried,
  };
}

function messageFor(code) {
  switch (code) {
    case 'unauthorized':
      return 'ROSE backend: every configured provider rejected the server credential.';
    case 'credits':
      return 'ROSE backend: the configured provider reports insufficient credits.';
    case 'rate-limited':
      return 'ROSE backend: all configured providers are rate limited right now.';
    case 'timeout':
      return 'ROSE backend: the provider did not answer in time.';
    case 'network':
      return 'ROSE backend: could not reach any configured provider.';
    case 'server':
      return 'ROSE backend: the provider is unavailable.';
    default:
      return 'ROSE backend: the provider rejected the request.';
  }
}

export { MAX_PROVIDER_HOPS, MAX_ATTEMPTS_PER_PROVIDER };
