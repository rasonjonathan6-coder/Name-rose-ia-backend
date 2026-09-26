/**
 * Validation server: serves the fixture pages AND a real OpenAI-compatible
 * `/v1/chat/completions` endpoint.
 *
 * This is not a stub of ROSE's AI client — ROSE makes a genuine `fetch()` to
 * this server from the extension service worker, over the real network stack,
 * with the real Authorization header and the real request body. The server
 * records every request so the validation run can assert on what ROSE actually
 * sent (model, prompt content, headers) rather than on what it intended to send.
 *
 * Fixtures are served over http://127.0.0.1/ because that origin is in the
 * manifest's content-script match list, so the browser injects the real
 * content script — no manual injection anywhere in this harness.
 */

import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

export const AI_PORT = Number(process.env.AI_PORT ?? 8788);

/** Every AI request ROSE made, newest last. */
export const aiRequests = [];

/**
 * Reply text the mock provider returns. Tests can swap this to simulate a
 * provider failure, an empty completion, or a malformed body.
 */
export const aiBehaviour = {
  /** 'ok' | 'error' | 'empty' | 'prose' | 'slow' | 'invalid-json' */
  mode: 'ok',
  status: 200,
  delayMs: 0,
  /** Canned suggestions, in order. */
  replies: [
    'I live in Lyon, in the south of France. What about you?',
    'Lyon — a lovely city in the south of France. Where are you based?',
    'I am from Lyon. It is a beautiful place, you would like it!',
  ],
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
  });
  res.end(payload);
}

function completion(text, model) {
  return {
    id: 'chatcmpl-validation',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
  };
}

async function handleCompletion(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* recorded below as-is */
  }

  aiRequests.push({
    at: Date.now(),
    authorization: req.headers.authorization ?? null,
    contentType: req.headers['content-type'] ?? null,
    referer: req.headers['http-referer'] ?? null,
    title: req.headers['x-title'] ?? null,
    model: body.model ?? null,
    temperature: body.temperature ?? null,
    maxTokens: body.max_tokens ?? null,
    responseFormat: body.response_format ?? null,
    messages: body.messages ?? [],
    url: req.url,
  });

  const mode = aiBehaviour.mode;
  if (aiBehaviour.delayMs) await new Promise((r) => setTimeout(r, aiBehaviour.delayMs));

  if (mode === 'error') {
    json(res, aiBehaviour.status, { error: { message: 'validation: simulated provider failure' } });
    return;
  }
  if (mode === 'invalid-json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{not json at all');
    return;
  }
  if (mode === 'empty') {
    json(res, 200, completion('', body.model));
    return;
  }
  if (mode === 'prose') {
    // A model that ignored response_format and wrapped JSON in prose. ROSE is
    // expected to retry without the JSON constraint and still succeed.
    json(res, 200, completion(`Sure! Here you go:\n\`\`\`json\n${JSON.stringify({ suggestions: aiBehaviour.replies })}\n\`\`\``, body.model));
    return;
  }

  // Distinguish the secondary tasks (summary / facts) from reply generation by
  // looking at the system prompt, so each path gets a plausible answer.
  const system = String(body.messages?.[0]?.content ?? '');
  let text;
  if (/summar/i.test(system)) {
    text = JSON.stringify({ summary: 'Client asked where the operator is from. Operator lives in Lyon.' });
  } else if (/fact|extract/i.test(system)) {
    text = JSON.stringify({ facts: ['Lives in Lyon'], topics: ['location'] });
  } else if (/translat/i.test(system)) {
    text = JSON.stringify({ text: 'Salut, comment vas-tu ?', lang: 'fr' });
  } else {
    text = JSON.stringify({ suggestions: aiBehaviour.replies });
  }

  json(res, 200, completion(text, body.model));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function startServer(port = AI_PORT) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
      });
      res.end();
      return;
    }

    if (url.pathname.endsWith('/chat/completions')) {
      await handleCompletion(req, res);
      return;
    }

    // Control plane for the harness itself.
    if (url.pathname === '/__control/reset') {
      aiRequests.length = 0;
      aiBehaviour.mode = 'ok';
      aiBehaviour.status = 200;
      aiBehaviour.delayMs = 0;
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/__control/requests') {
      json(res, 200, { requests: aiRequests });
      return;
    }
    if (url.pathname === '/__control/behaviour') {
      const patch = Object.fromEntries(url.searchParams);
      if (patch.mode) aiBehaviour.mode = patch.mode;
      if (patch.status) aiBehaviour.status = Number(patch.status);
      if (patch.delayMs) aiBehaviour.delayMs = Number(patch.delayMs);
      json(res, 200, { ok: true, behaviour: aiBehaviour });
      return;
    }

    // Fixture pages.
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(fixturesDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(fixturesDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Run standalone: `node scripts/validation/server.mjs`
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  await startServer();
  process.stdout.write(`[validation] fixtures + mock AI on http://127.0.0.1:${AI_PORT}/\n`);
}
