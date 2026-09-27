/**
 * Provider health tracking and a bounded circuit breaker.
 *
 * Keeps only the counters the router needs to make a routing decision, and never
 * a prompt, a response body or a credential. Metrics are per-process and reset
 * on restart — this is operational state, not persisted history.
 *
 * Degradation is deliberately conservative:
 *  - a provider moves to DEGRADED only after `DEGRADE_AFTER` consecutive
 *    failures of a *retryable* kind (transient);
 *  - an authentication failure degrades immediately and for longer, because
 *    retrying a rejected credential cannot succeed;
 *  - degradation expires after a TTL, so a recovered provider is tried again
 *    without an operator restart. It never becomes permanent, and no loop can
 *    depend on it.
 */

const DEGRADE_AFTER = Number(process.env.ROSE_DEGRADE_AFTER ?? 2);
const DEGRADED_TTL_MS = Number(process.env.ROSE_DEGRADED_TTL_MS ?? 60_000);
const AUTH_DEGRADED_TTL_MS = Number(process.env.ROSE_AUTH_DEGRADED_TTL_MS ?? 300_000);

/** @typedef {{lastSuccess:number|null,lastFailure:number|null,latencyMs:number|null,timeoutCount:number,rateLimitCount:number,serverErrorCount:number,authError:boolean,consecutiveFailures:number,degradedUntil:number}} Health */

const FAILURE_KIND = {
  timeout: 'timeoutCount',
  'rate-limited': 'rateLimitCount',
  server: 'serverErrorCount',
  network: 'serverErrorCount',
};

/** @type {Map<string, Health>} */
const metrics = new Map();

function blank() {
  return {
    lastSuccess: null,
    lastFailure: null,
    latencyMs: null,
    timeoutCount: 0,
    rateLimitCount: 0,
    serverErrorCount: 0,
    authError: false,
    consecutiveFailures: 0,
    degradedUntil: 0,
  };
}

function get(id) {
  let m = metrics.get(id);
  if (!m) {
    m = blank();
    metrics.set(id, m);
  }
  return m;
}

export function recordSuccess(id, latencyMs = null) {
  const m = get(id);
  m.lastSuccess = Date.now();
  m.latencyMs = latencyMs;
  m.consecutiveFailures = 0;
  m.authError = false;
  m.degradedUntil = 0;
}

export function recordFailure(id, code) {
  const m = get(id);
  m.lastFailure = Date.now();
  m.consecutiveFailures += 1;

  const counter = FAILURE_KIND[code];
  if (counter) m[counter] += 1;

  if (code === 'unauthorized' || code === 'credits') {
    m.authError = true;
    m.degradedUntil = Date.now() + AUTH_DEGRADED_TTL_MS;
    return m;
  }

  if (m.consecutiveFailures >= DEGRADE_AFTER) {
    m.degradedUntil = Date.now() + DEGRADED_TTL_MS;
  }
  return m;
}

/** True while the provider is being temporarily skipped. */
export function isDegraded(id, now = Date.now()) {
  const m = metrics.get(id);
  if (!m) return false;
  if (m.degradedUntil === 0) return false;
  if (m.degradedUntil <= now) {
    // TTL elapsed: allow a fresh attempt rather than staying degraded forever.
    m.degradedUntil = 0;
    m.consecutiveFailures = 0;
    m.authError = false;
    return false;
  }
  return true;
}

export function statusOf(id) {
  const m = metrics.get(id) ?? blank();
  return {
    ...m,
    state: isDegraded(id) ? (m.authError ? 'AUTH_FAILED' : 'DEGRADED') : m.lastSuccess ? 'HEALTHY' : 'UNKNOWN',
  };
}

export function snapshot() {
  const out = {};
  for (const id of metrics.keys()) out[id] = statusOf(id);
  return out;
}

/** Test seam. */
export function __resetHealth() {
  metrics.clear();
}

export { DEGRADE_AFTER, DEGRADED_TTL_MS, AUTH_DEGRADED_TTL_MS };
