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
 *   PORT                 default 8787. `0` binds an ephemeral port.
 *   HOST                 default 127.0.0.1. Bind 0.0.0.0 behind TLS/a proxy.
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

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const API_KEY = process.env.OPENROUTER_API_KEY ?? '';
const BACKEND_TOKEN = process.env.ROSE_BACKEND_TOKEN ?? '';
const UPSTREAM = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60_000);
const MAX_BODY_BYTES = 256 * 1024;

// Any credential-shaped string is stripped before it can reach a log line or a
// response body. Belt and braces: we also never put the key into either on
// purpose.
const SECRET_PATTERNS = [/sk-or-v1-[A-Za-z0-9_-]{8,}/g, /\bsk-[A-Za-z0-9]{20,}\b/g];

function redact(input) {
  let out = String(input ?? '');
  if (API_KEY) out = out.split(API_KEY).join('[redacted]');
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

  if (!API_KEY) {
    // Fail loudly and early. Forwarding without a key would turn a clear
    // configuration error into a confusing upstream 401.
    send(res, 503, {
      error: { message: 'ROSE backend: OPENROUTER_API_KEY is not configured on the server.', code: 'no-key' },
    });
    log('completion', { id, status: 503, reason: 'no-key' });
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

  try {
    const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
        // OpenRouter attributes usage to the calling app via these headers.
        'http-referer': 'https://github.com/rose-ia',
        'x-title': 'ROSE IA',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await upstream.text();
    const status = upstream.status;

    if (upstream.ok) {
      send(res, 200, text);
      log('completion', { id, status: 200, ms: Date.now() - started });
      return;
    }

    // Map provider failures onto codes the extension already understands, and
    // sanitize the upstream body: an error payload is the last place a
    // credential should be able to escape.
    const safe = redact(text).slice(0, 2000);
    if (status === 401) send(res, 401, { error: { message: 'OpenRouter rejected the server credential.', code: 'unauthorized', upstream: safe } });
    else if (status === 402) send(res, 402, { error: { message: 'OpenRouter reports insufficient credits.', code: 'credits', upstream: safe } });
    else if (status === 429) send(res, 429, { error: { message: 'OpenRouter rate limit reached.', code: 'rate-limited', upstream: safe } });
    else if (status >= 500) send(res, 502, { error: { message: 'OpenRouter is unavailable.', code: 'server', upstream: safe } });
    else send(res, status, { error: { message: 'OpenRouter rejected the request.', code: 'bad-response', upstream: safe } });
    log('completion', { id, status, upstream: status, ms: Date.now() - started });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    const status = aborted ? 504 : 502;
    send(res, status, {
      error: {
        message: aborted ? 'ROSE backend: upstream request timed out.' : 'ROSE backend: could not reach OpenRouter.',
        code: aborted ? 'timeout' : 'network',
      },
    });
    log('completion', { id, status, reason: aborted ? 'timeout' : 'network', ms: Date.now() - started });
  } finally {
    clearTimeout(timer);
    req.off('close', abortOnClientClose);
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
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      send(res, 200, {
        status: API_KEY ? 'ok' : 'degraded',
        provider: 'openrouter',
        keyConfigured: API_KEY.length > 0,
        tokenRequired: BACKEND_TOKEN.length > 0,
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
    log('listening', { host: HOST, port: actual, keyConfigured: API_KEY.length > 0 });
    if (!API_KEY) log('warning', { message: 'OPENROUTER_API_KEY is not set; requests will be refused with 503.' });
    if (!BACKEND_TOKEN) log('warning', { message: 'ROSE_BACKEND_TOKEN is not set; the endpoint is unauthenticated.' });
    // Machine-readable line so a supervisor or test can discover the port.
    process.stdout.write(`ROSE_BACKEND_READY ${JSON.stringify({ port: actual, keyConfigured: API_KEY.length > 0 })}\n`);
  });
}
