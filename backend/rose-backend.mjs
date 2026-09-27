#!/usr/bin/env node
/**
 * ROSE backend — a minimal, dependency-free proxy in front of OpenRouter.
 *
 *   ROSE extension → this backend (HTTPS in deployment) → OpenRouter
 *
 * The extension never holds the OpenRouter credential. It calls this service,
 * which attaches the key server-side and forwards only the provider's response.
 *
 * Configuration (environment only — no key is ever read from a file or a
 * request):
 *
 *   OPENROUTER_API_KEY   required. The provider credential. Never logged,
 *                        never returned, never echoed.
 *   OPENROUTER_BASE_URL  default https://openrouter.ai/api/v1
 *   PORT                 default 8787, or the platform's PORT when hosted.
 *                        `0` binds an ephemeral port.
 *   HOST                 default 0.0.0.0 when a hosting platform is detected
 *                        (Render, Railway, Fly, Heroku, …), otherwise
 *                        127.0.0.1. A loopback socket is unreachable from a
 *                        platform router, so binding loopback in the cloud
 *                        serves nothing — hence the detection. Set it
 *                        explicitly to override.
 *   ROSE_BACKEND_TOKEN   optional. When set, callers must present it as
 *                        `Authorization: Bearer <token>`. Set this before
 *                        exposing the service publicly: without it, the
 *                        endpoint is an open relay for your provider quota.
 *   ALLOWED_ORIGINS      optional. Comma-separated allowlist; default `*`.
 *                        `*` is correct for a browser extension, which sends
 *                        no cookies, and keeps the service usable from any
 *                        extension id.
 *   REQUEST_TIMEOUT_MS   default 60000.
 *
 * Start:  OPENROUTER_API_KEY=... node backend/rose-backend.mjs
 *
 * This file is not part of the extension bundle and must never be shipped
 * inside the .zip.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { hasAnyProvider, listProviders } from './providers.mjs';
import { roleForTask, routeCompletion } from './router.mjs';
import { recordFailure, recordSuccess, snapshot } from './health.mjs';

const PORT = Number(process.env.PORT ?? 8787);

/**
 * Hosting platforms route external traffic into the container, so a loopback
 * socket is invisible to them: the service starts, logs that it is listening,
 * and never answers a single request. That is a silent, total failure, so the
 * default host depends on where we are running.
 *
 * Binding all interfaces is only done when we are confident we are hosted —
 * a platform marker, or a container with a platform-assigned PORT. A plain
 * `PORT=3000 node backend/rose-backend.mjs` on a laptop keeps the loopback
 * default rather than quietly exposing the service to the local network.
 */
function detectHosted() {
  const markers = [
    'RENDER', 'RENDER_EXTERNAL_URL', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME',
    'DYNO', 'HEROKU_APP_NAME', 'K_SERVICE', 'WEBSITE_SITE_NAME', 'VERCEL',
  ];
  if (markers.some((m) => process.env[m])) return true;
  if (process.env.PORT === undefined) return false;
  if (process.pid === 1) return true; // containers run the service as PID 1
  if (existsSync('/.dockerenv')) return true;
  try {
    return /docker|kubepods|containerd|podman/.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}
const HOST = process.env.HOST ?? (detectHosted() ? '0.0.0.0' : '127.0.0.1');
const BACKEND_TOKEN = process.env.ROSE_BACKEND_TOKEN ?? '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60_000);
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Credentials the redactor scrubs, identified by *variable name* rather than by
 * value shape. A provider key is not obliged to look like any known pattern —
 * a self-hosted gateway token is arbitrary — so matching on shape alone would
 * leave exactly those values unredacted. Names ending in KEY/TOKEN/SECRET are
 * treated as credential-bearing, and their values are scrubbed from every
 * response body and log line.
 */
const CREDENTIAL_NAME_RE = /(API_KEY|API_TOKEN|_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)$/i;

const ALL_KEYS = Object.entries(process.env)
  .filter(([name, v]) => CREDENTIAL_NAME_RE.test(name) && typeof v === 'string' && v.trim().length >= 6)
  .map(([, v]) => v.trim());

/** Reported by /health as `provider`; keeps the existing contract stable. */
const PRIMARY_PROVIDER_ID = process.env.ROSE_ROLE_PRIMARY?.trim() || 'openrouter';

/** Last failure, for diagnostics. Holds a code and a time — never a body. */
let lastError = null;
function noteFailure(providerId, code) {
  recordFailure(providerId, code);
  lastError = { code, provider: providerId, at: Date.now() };
}

function noteSuccess(providerId, latencyMs) {
  recordSuccess(providerId, latencyMs);
}

/** Mean of the measured provider latencies, or null when nothing succeeded yet. */
function averageLatency() {
  const latencies = Object.values(snapshot())
    .map((s) => s.latencyMs)
    .filter((v) => typeof v === 'number');
  if (!latencies.length) return null;
  return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
}

// Any credential-shaped string is stripped before it can reach a log line or a
// response body. Belt and braces: we also never put the key into either on
// purpose.
const SECRET_PATTERNS = [
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
];

/**
 * Scrubs every provider credential we can see from `input`.
 *
 * The subscriber's own value is matched even when it does not look like any
 * known key shape — an upstream that echoes a credential in an error body is a
 * realistic path, and a shape-based filter alone would miss a custom gateway
 * token.
 */
function redact(input) {
  let out = String(input ?? '');
  for (const key of ALL_KEYS) {
    if (key.length >= 6) out = out.split(key).join('[redacted]');
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

/** Logs carry metadata only — never prompts, never credentials. */
function log(event, fields = {}) {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${redact(v)}`);
  process.stdout.write(`[rose-backend] ${event}${parts.length ? ' ' + parts.join(' ') : ''}\n`);
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : ALLOWED_ORIGINS.includes(origin ?? '')
      ? origin
      : null;
  if (!allow) return { vary: 'origin' };
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-rose-token',
    // Without this the browser hides the routing headers from the extension's
    // fetch, and they are exactly what the debug panel reads.
    'access-control-expose-headers': 'x-rose-provider, x-rose-model, x-rose-role, x-rose-latency-ms',
    'access-control-max-age': '86400',
  };
}

function send(res, status, body, extraHeaders = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...corsHeaders(res.__origin),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { code: 'too-large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Constant-time-ish comparison; avoids leaking length via early-exit timing. */
function tokenMatches(presented) {
  if (!BACKEND_TOKEN) return true;
  if (!presented || presented.length !== BACKEND_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < BACKEND_TOKEN.length; i++) diff |= presented.charCodeAt(i) ^ BACKEND_TOKEN.charCodeAt(i);
  return diff === 0;
}

async function handleCompletion(req, res) {
  const started = Date.now();
  const id = Math.random().toString(36).slice(2, 10);

  if (!hasAnyProvider()) {
    // Fail loudly and early. Forwarding without a provider would turn a clear
    // configuration error into a confusing upstream 401.
    send(res, 503, {
      error: { message: 'ROSE backend: no provider is configured on the server.', code: 'no-key' },
    });
    log('completion', { id, status: 503, reason: 'no-provider' });
    return;
  }

  const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!tokenMatches(presented)) {
    send(res, 401, { error: { message: 'ROSE backend: invalid or missing backend token.', code: 'unauthorized' } });
    log('completion', { id, status: 401, reason: 'bad-token' });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    const status = err?.code === 'too-large' ? 413 : 400;
    send(res, status, { error: { message: 'ROSE backend: unreadable request body.', code: 'bad-request' } });
    log('completion', { id, status, reason: 'body' });
    return;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    send(res, 400, { error: { message: 'ROSE backend: request body is not valid JSON.', code: 'bad-request' } });
    log('completion', { id, status: 400, reason: 'json' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortOnClientClose = () => controller.abort();
  req.on('close', abortOnClientClose);

  // Task shape drives the role: a translation call is a translation, and a
  // deliberately complex generation is routed to the complex slot. The client
  // states this explicitly so the router does not have to guess from the prompt.
  const kind = typeof body?.rose_task === 'string' ? body.rose_task : 'generation';
  const role = roleForTask(kind, { complex: body?.rose_complex === true });

  const routed = await routeCompletion({
    role,
    attempt: async (provider, model) => {
      const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${provider.apiKey}`,
          // OpenRouter attributes usage to the calling app via these headers.
          'http-referer': 'https://github.com/rose-ia',
          'x-title': 'ROSE IA',
        },
        body: JSON.stringify({ ...body, model: body?.model || model }),
        signal: controller.signal,
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        throw { status: upstream.status, body: text };
      }
      return { body: text, model: safeModel(text) ?? model };
    },
  });

  try {
    if (routed.ok) {
      noteSuccess(routed.provider, routed.latencyMs);
      // Which provider and model actually served this request is operator-visible
      // in the dashboard/debug panel; exposing it as headers costs nothing and
      // saves guessing from the body.
      send(res, 200, routed.body, {
        'x-rose-provider': routed.provider,
        'x-rose-model': routed.model ?? '',
        'x-rose-role': routed.role,
        'x-rose-latency-ms': String(routed.latencyMs ?? 0),
      });
      log('completion', {
        id,
        status: 200,
        provider: routed.provider,
        model: routed.model,
        role: routed.role,
        latency_ms: routed.latencyMs,
        ms: Date.now() - started,
      });
      return;
    }

    const { code, message, lastStatus } = routed.error;
    const status = statusForCode(code, lastStatus);
    for (const t of routed.tried) noteFailure(t.provider, t.code);
    // The upstream body is reported (clients rely on it for diagnostics) but
    // only after redaction — never a raw provider payload.
    const upstream = routed.tried.map((t) => t.upstream).filter(Boolean).join('\n');
    send(res, status, {
      error: {
        message,
        code,
        tried: routed.tried.map((t) => ({ provider: t.provider, code: t.code })),
        ...(upstream ? { upstream: redact(upstream).slice(0, 2000) } : {}),
      },
    });
    log('completion', {
      id,
      status,
      reason: code,
      providers: routed.tried.map((t) => t.provider).join(','),
      ms: Date.now() - started,
    });
  } finally {
    clearTimeout(timer);
    req.off('close', abortOnClientClose);
  }
}

/** Maps a router failure onto the HTTP status the extension already understands. */
function statusForCode(code, lastStatus) {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'credits':
      return 402;
    case 'rate-limited':
      return 429;
    case 'timeout':
      return 504;
    case 'network':
      return 502;
    case 'server':
      return 502;
    default:
      return lastStatus && lastStatus >= 400 && lastStatus < 500 ? lastStatus : 502;
  }
}

/** Reads the model the provider actually used, without trusting the request. */
function safeModel(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.model === 'string' ? parsed.model : null;
  } catch {
    return null;
  }
}

export function createRoseBackend() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    res.__origin = req.headers.origin;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req.headers.origin));
      res.end();
      return;
    }

    // Liveness. Reports only whether a credential is present — never its value.
    // `provider` stays the primary provider's id so the contract the extension
    // and the uptime checks already rely on is unchanged.
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      const providers = listProviders();
      const primary = providers.find((p) => p.id === PRIMARY_PROVIDER_ID) ?? providers[0];
      send(res, 200, {
        status: hasAnyProvider() ? 'ok' : 'degraded',
        provider: primary?.id ?? 'openrouter',
        keyConfigured: hasAnyProvider(),
        tokenRequired: BACKEND_TOKEN.length > 0,
        configuredProviders: providers.filter((p) => p.configured).map((p) => p.id),
      });
      return;
    }

    // Diagnostics: configuration and last-known health, never a credential.
    // Deliberately does not call `verifyProvider` — a diagnostic read must not
    // spend a provider request. Verification happens where it is paid for, and
    // its cached result is reported here.
    if (url.pathname === '/v1/rose/diagnostics') {
      const providers = listProviders();
      send(res, 200, {
        status: 'ok',
        tokenRequired: BACKEND_TOKEN.length > 0,
        providers: providers.map((p) => ({
          id: p.id,
          label: p.label,
          configured: p.configured,
          requiredVars: p.requiredVars,
          defaultModel: p.model,
          health: snapshot()[p.id]?.state ?? (p.configured ? 'UNKNOWN' : 'NOT_CONFIGURED'),
        })),
        roles: {
          primary: roleForTask('generation', {}),
          complex: roleForTask('generation', { complex: true }),
          translation: roleForTask('translation', {}),
        },
        lastError: lastError ?? null,
        averageLatencyMs: averageLatency(),
      });
      return;
    }

    if (url.pathname === '/v1/chat/completions') {
      if (req.method !== 'POST') {
        send(res, 405, { error: { message: 'Use POST.', code: 'method' } });
        return;
      }
      await handleCompletion(req, res);
      return;
    }

    // Enough of the OpenAI surface for a client that probes it first.
    if (url.pathname === '/v1/models') {
      send(res, 200, { object: 'list', data: [] });
      return;
    }

    send(res, 404, { error: { message: 'Not found.', code: 'not-found' } });
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = createRoseBackend();
  server.listen(PORT, HOST, () => {
    const actual = server.address().port;
    log('listening', { host: HOST, port: actual, keyConfigured: hasAnyProvider() });
    if (!hasAnyProvider()) log('warning', { message: 'no AI provider is configured; requests will be refused with 503.' });
    if (!BACKEND_TOKEN) log('warning', { message: 'ROSE_BACKEND_TOKEN is not set; the endpoint is unauthenticated.' });
    // Machine-readable line so a supervisor or test can discover the port.
    process.stdout.write(`ROSE_BACKEND_READY ${JSON.stringify({ port: actual, keyConfigured: hasAnyProvider() })}\n`);
  });
}
