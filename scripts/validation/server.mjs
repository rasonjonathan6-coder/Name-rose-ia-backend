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

/**
 * Origin of the cross-origin chat frame for fixture G.
 *
 * Kept separate from the shell's port so the browser treats the frame as a
 * genuinely different origin. That is what makes the test meaningful: the parent
 * cannot reach into the frame, so only the service worker can bridge them.
 */
export const CHAT_FRAME_PORT = Number(process.env.CHAT_FRAME_PORT ?? 8789);

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

  // Route on the distinctive opening line of each system prompt. Matching on
  // loose words like "fact" is wrong: the generation prompt contains the rule
  // "Do not invent personal facts", so it was misclassified as fact extraction
  // and the generation call was answered with a fact payload — which made ROSE
  // look broken when the provider was the thing lying.
  const system = String(body.messages?.[0]?.content ?? '');
  let text;
  if (/You compress chat history/.test(system)) {
    // Summary: plain prose, not JSON.
    text = 'The client asked whether the operator remembers their cat. No personal facts confirmed yet.';
  } else if (/You extract durable personal facts/.test(system)) {
    // Facts: a JSON array of {key,value,weight}, which is what extractFacts reads.
    text = JSON.stringify([
      { key: 'pet', value: 'Has a cat', weight: 0.9 },
      { key: 'city', value: 'Lyon', weight: 0.7 },
    ]);
  } else if (/You are a professional translator/.test(system)) {
    // Translation: plain translated text, not JSON.
    text = 'Salut, comment vas-tu ?';
  } else {
    text = JSON.stringify({
      suggestions: [
        { kind: 'natural', text: aiBehaviour.replies[0] },
        { kind: 'warm', text: aiBehaviour.replies[1] },
        { kind: 'engaging', text: aiBehaviour.replies[2] },
      ],
    });
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

    // Demo harness, built by `npm run build` into dist/demo/. Served from the
    // same origin as the fixtures so it exercises the real content script.
    if (url.pathname.startsWith('/demo/')) {
      const demoRoot = path.resolve(here, '..', '..', 'dist');
      const demoFile = path.join(demoRoot, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (!demoFile.startsWith(demoRoot) || !fs.existsSync(demoFile) || fs.statSync(demoFile).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('demo not built — run `npm run build`');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(demoFile)] ?? 'application/octet-stream' });
      fs.createReadStream(demoFile).pipe(res);
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

/**
 * A second origin for the iframe fixture.
 *
 * The whole point of fixture G is that the chat frame is *cross-origin* relative
 * to the shell that embeds it, like www.coomeet.com embedding
 * iframe.coomeet.com. Serving both from one port would make the frame
 * same-origin and the test would prove nothing.
 *
 * This server deliberately exposes no AI endpoint and no control plane: it only
 * exists to give the chat frame a different origin.
 */
export function startChatFrameServer(port = 8789) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(fixturesDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(fixturesDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      // The shell and this origin differ only by port, which is enough for the
      // browser to treat them as separate origins, but not enough for a default
      // `X-Frame-Options`/CSP to matter. Nothing here needs framing headers.
    });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Run standalone: `node scripts/validation/server.mjs`
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  await startServer();
  // The chat frame of fixture G must be on a *different* origin from its shell,
  // otherwise the frame is same-origin and the cross-origin path goes untested.
  await startChatFrameServer(CHAT_FRAME_PORT);
  process.stdout.write(`[validation] fixtures + mock AI on http://127.0.0.1:${AI_PORT}/\n`);
  process.stdout.write(`[validation] cross-origin chat frame on http://127.0.0.1:${CHAT_FRAME_PORT}/\n`);
}
