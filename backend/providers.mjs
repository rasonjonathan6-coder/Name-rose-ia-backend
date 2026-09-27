/**
 * Provider registry + availability.
 *
 * Every supported provider exposes an OpenAI-compatible
 * `POST {baseUrl}/chat/completions`, so one request shape reaches all of them.
 * The provider-specific parts are the base URL, the credential variable names,
 * and the default models — all declared here, nowhere else.
 *
 * Availability rule: a provider is `configured` only when every credential
 * variable it needs exists AND is non-empty. A variable that is present but
 * blank is not a credential, and treating it as one turns a missing key into a
 * confusing upstream 401.
 *
 * `configured` is a statement about configuration, not about reachability. A
 * provider is only reported as `available` after a real request succeeds (see
 * `verifyProvider`), and results are cached so the check is not paid for on
 * every diagnostic call.
 */

/** @typedef {{id:string,label:string,keyEnvs:string[],baseUrl:string|null,defaultModel:string,fastDefault:string}} ProviderDef */

/** @type {ProviderDef[]} */
export const PROVIDER_DEFS = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyEnvs: ['OPENROUTER_API_KEY'],
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    fastDefault: 'openai/gpt-4o-mini',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    keyEnvs: ['GEMINI_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    fastDefault: 'gemini-2.0-flash',
  },
  {
    id: 'groq',
    label: 'Groq',
    keyEnvs: ['GROQ_API_KEY'],
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    fastDefault: 'llama-3.1-8b-instant',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    keyEnvs: ['CEREBRAS_API_KEY'],
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama3.1-8b',
    fastDefault: 'llama3.1-8b',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    keyEnvs: ['MISTRAL_API_KEY'],
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    fastDefault: 'mistral-small-latest',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    keyEnvs: ['NVIDIA_API_KEY'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.1-8b-instruct',
    fastDefault: 'meta/llama-3.1-8b-instruct',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    // Two variables: the token alone cannot address the account.
    keyEnvs: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    baseUrl: null, // composed per-request from the account id
    defaultModel: '@cf/meta/llama-3.1-8b-instruct',
    fastDefault: '@cf/meta/llama-3.1-8b-instruct',
  },
];

const BY_ID = new Map(PROVIDER_DEFS.map((p) => [p.id, p]));

export function providerDef(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Base URL, composed at call time.
 *
 * `<ID>_BASE_URL` overrides the default — used by tests and by anyone proxying a
 * provider through a gateway. Cloudflare's URL is built from the account id
 * because the vendor has no fixed per-account host.
 */
export function baseUrlOf(def, env = process.env) {
  const varName = `${def.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BASE_URL`;
  const override =
    env[varName] ?? (def.id === 'openrouter' ? env.OPENROUTER_BASE_URL : undefined);
  if (typeof override === 'string' && override.trim()) return override.trim().replace(/\/+$/, '');
  if (def.id === 'cloudflare') {
    return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`;
  }
  return def.baseUrl;
}

/**
 * Resolves the credential for a provider.
 *
 * A provider is configured only when EVERY variable it declares is present and
 * non-blank — Cloudflare needs both a token and an account id, and half of that
 * pair is not a usable credential. The value of the first declared variable is
 * the one sent as the bearer credential.
 */
function readKey(env, names) {
  let first = '';
  for (const n of names) {
    const v = env[n];
    if (typeof v !== 'string' || v.trim().length === 0) return '';
    if (!first) first = v.trim();
  }
  return first;
}

/**
 * Resolves a provider's runtime configuration, or a `configured: false` record
 * when its credentials are absent. Never returns the credential to a caller that
 * would serialise it — `describe()` strips it.
 */
export function resolveProvider(id, env = process.env) {
  const def = providerDef(id);
  if (!def) return null;
  const apiKey = readKey(env, def.keyEnvs);
  const model = env[`${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MODEL`] || def.defaultModel;
  return {
    id: def.id,
    label: def.label,
    configured: apiKey.length > 0,
    apiKey,
    baseUrl: baseUrlOf(def, env),
    model,
    fastModel: env[`${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FAST_MODEL`] || def.fastDefault,
    keyEnvs: def.keyEnvs,
  };
}

/** Secret-free description, safe to serialise into a response or a log. */
export function describe(resolved) {
  return {
    id: resolved.id,
    label: resolved.label,
    configured: resolved.configured,
    model: resolved.model,
    fastModel: resolved.fastModel,
    requiredVars: resolved.keyEnvs,
  };
}

/** Every provider, with configuration state. No values, only variable names. */
export function listProviders(env = process.env) {
  return PROVIDER_DEFS.map((d) => describe(resolveProvider(d.id, env)));
}

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

/**
 * Default role assignment. These are configurable defaults, not claims of
 * superiority: nothing here says a provider is "better", only which slot it
 * fills when the operator has not chosen.
 */
export const DEFAULT_ROLES = {
  primary: 'openrouter',
  fast: 'groq',
  complex: 'cerebras',
  translation: 'mistral',
};

/** Fallback order tried after the role provider fails transiently. */
export const DEFAULT_FALLBACK_ORDER = ['openrouter', 'gemini', 'nvidia', 'cloudflare', 'groq', 'cerebras', 'mistral'];

export function roleProviderId(role, env = process.env) {
  const key = `ROSE_ROLE_${role.toUpperCase()}`;
  const configured = env[key]?.trim();
  if (configured) return configured;
  return DEFAULT_ROLES[role] ?? DEFAULT_ROLES.primary;
}

/**
 * Ordered provider chain for a role: the role's provider first, then the
 * configured fallbacks (deduplicated, unconfigured ones dropped).
 *
 * Returns an empty array when nothing is configured — the caller surfaces that
 * as a clear configuration error rather than attempting a call that cannot work.
 */
export function chainFor(role, env = process.env) {
  const first = roleProviderId(role, env);
  const explicit = env.ROSE_FALLBACK_ORDER?.split(',').map((s) => s.trim()).filter(Boolean);
  const order = explicit?.length ? explicit : DEFAULT_FALLBACK_ORDER;

  const ids = [first, ...order.filter((id) => id !== first)];
  const seen = new Set();
  const chain = [];
  for (const id of ids) {
    if (seen.has(id) || !providerDef(id)) continue;
    seen.add(id);
    const resolved = resolveProvider(id, env);
    if (resolved?.configured) chain.push(resolved);
  }
  return chain;
}

/** True when at least one provider is usable. */
export function hasAnyProvider(env = process.env) {
  return PROVIDER_DEFS.some((d) => resolveProvider(d.id, env)?.configured);
}

// ---------------------------------------------------------------------------
// Real verification
// ---------------------------------------------------------------------------

const VERIFY_TTL_MS = Number(process.env.PROVIDER_VERIFY_TTL_MS ?? 300_000);
/** @type {Map<string, {at:number, result:object}>} */
const verifyCache = new Map();

/**
 * Performs a real, minimal completion against the provider.
 *
 * This is the only thing that may report a provider as `available`. A cached
 * result is reused within the TTL so a diagnostics call does not spend a request
 * every time it is read.
 */
export async function verifyProvider(id, opts = {}) {
  const resolved = resolveProvider(id, opts.env ?? process.env);
  if (!resolved) return { id, available: false, reason: 'unknown-provider' };
  if (!resolved.configured) return { id, available: false, reason: 'not-configured' };

  const cached = verifyCache.get(id);
  if (cached && Date.now() - cached.at < VERIFY_TTL_MS && !opts.force) {
    return { ...cached.result, cached: true };
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const started = Date.now();
  let result;
  try {
    const res = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: resolved.fastModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      result = { id, available: true, status: res.status, latencyMs, model: resolved.fastModel };
    } else {
      // 401/403 is a credential problem; 404 usually means the model name is
      // wrong. Both are configuration errors, reported distinctly.
      const reason =
        res.status === 401 || res.status === 403
          ? 'unauthorized'
          : res.status === 404
            ? 'model-not-found'
            : res.status === 429
              ? 'rate-limited'
              : 'provider-error';
      result = { id, available: false, reason, status: res.status, latencyMs, model: resolved.fastModel };
    }
  } catch (err) {
    const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    result = {
      id,
      available: false,
      reason: aborted ? 'timeout' : 'network',
      latencyMs: Date.now() - started,
      model: resolved.fastModel,
    };
  }
  verifyCache.set(id, { at: Date.now(), result });
  return result;
}

/** Test seam: forget cached verification results. */
export function __resetVerifyCache() {
  verifyCache.clear();
}
