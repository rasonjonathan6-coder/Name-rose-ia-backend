/**
 * Phase 7 — the extension against a REAL proxy backend.
 *
 * Proves the deployment shape the docs recommend, end to end:
 *
 *   extension → ROSE backend (backend/rose-backend.mjs) → provider
 *
 * The backend process is the real one, started with a **dummy** credential that
 * is not a real OpenRouter key and grants nothing. The "provider" is the local
 * mock, so no network egress and no real credential are involved. What is being
 * tested is the wiring that matters:
 *
 *   1. the extension sends NO Authorization header of its own;
 *   2. the backend attaches the credential server-side, upstream only;
 *   3. the credential never appears in anything the extension can observe;
 *   4. provider failures surface as clean, typed errors.
 *
 *   node scripts/validation/phase7-proxy.mjs [extensionDir]
 *
 * Requires the validation server (`node scripts/validation/server.mjs`), which
 * also hosts the mock provider this backend forwards to.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from '../cdp.mjs';
import {
  Checks,
  configureRose,
  setApiKey,
  evalInWorker,
  waitForOverlay,
  clearAllRoseData,
  readOverlay,
  aiRequests,
  resetAi,
} from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const extensionDir = process.argv[2] ?? path.join(repoRoot, 'dist');

/** A placeholder. It is not a real credential and is never used against a real provider. */
const DUMMY_KEY = 'dummy-backend-key-for-wiring-test';

const BACKEND_PORT = 8799;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const DEMO_URL = 'http://127.0.0.1:8788/demo/demo.html';

const checks = new Checks('PHASE 7 — proxy backend (extension → backend → provider)');

/** Starts the real backend process pointed at the local mock provider. */
async function startBackend(env = {}) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'backend', 'rose-backend.mjs')], {
    env: {
      ...process.env,
      PORT: String(BACKEND_PORT),
      HOST: '127.0.0.1',
      OPENROUTER_BASE_URL: 'http://127.0.0.1:8788/v1',
      OPENROUTER_API_KEY: DUMMY_KEY,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));

  // Wait for the readiness line rather than sleeping a fixed amount.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !out.includes('ROSE_BACKEND_READY')) await sleep(100);
  if (!out.includes('ROSE_BACKEND_READY')) {
    child.kill();
    throw new Error(`backend did not start:\n${out}`);
  }
  return { child, log: () => out };
}

async function stopBackend(handle) {
  if (!handle) return;
  handle.child.kill('SIGTERM');
  await sleep(200);
  if (!handle.child.killed) handle.child.kill('SIGKILL');
}

async function overlay(page) {
  return browser.eval(page, readOverlay()).catch(() => null);
}

async function ask(page, text, { timeout = 60_000 } = {}) {
  const before = await overlay(page);
  const beforeFp = JSON.stringify((before?.suggestions ?? []).map((s) => s.text ?? ''));
  // The overlay keeps the previous error on screen, so a stale error must not
  // be mistaken for this message's outcome.
  const beforeError = before?.errorText ?? null;
  await browser.eval(page, `window.ROSE_DEMO.addIncoming(${JSON.stringify(text)})`);

  const deadline = Date.now() + timeout;
  let last = before;
  while (Date.now() < deadline) {
    last = await overlay(page);
    const texts = (last?.suggestions ?? []).map((s) => s.text ?? '');
    if (JSON.stringify(texts) !== beforeFp && texts.some((t) => t.trim().length > 5)) return last;
    const error = last?.errorText ?? null;
    if (error && error !== beforeError && !/No incoming message detected/i.test(error)) return last;
    await sleep(1000);
  }
  return last;
}

/** Points ROSE at the proxy backend: no key, viaProxy. */
async function useProxyProvider(browser, baseUrl) {
  await configureRose(browser, {
    ai: {
      activeProvider: 'rose-backend',
      providers: [
        {
          id: 'rose-backend',
          label: 'ROSE Backend (secure proxy)',
          baseUrl: `${baseUrl}/v1`,
          model: 'openai/gpt-4o-mini',
          fastModel: 'openai/gpt-4o-mini',
          enabled: true,
          viaProxy: true,
          temperature: 0.7,
          maxTokens: 320,
        },
      ],
      acknowledgedPolicy: true,
      maxResponseChars: 600,
    },
    conversation: { style: 'natural', length: 'short', suggestionCount: 3, targetLanguage: 'auto' },
    automation: { mode: 'manual', globalEnabled: true, replyDelayMs: 1500 },
    memory: { enabled: true, maxRecentMessages: 12 },
    debug: { enabled: true, verbose: true, showOverlay: true },
  });
  // Clear any key that a previous phase may have left behind: the proxy path
  // must work with none.
  await evalInWorker(browser, `(async () => { await chrome.storage.local.remove('rose:secrets'); return true; })()`);
}

let backend = null;
const browser = await Browser.launch({ extensionDir });

try {
  await browser.waitForServiceWorker(30_000);
  await clearAllRoseData();
  await resetAi();

  // ---------------------------------------------------------------------
  // Backend liveness, before involving the browser at all.
  // ---------------------------------------------------------------------
  backend = await startBackend();
  const health = await fetch(`${BACKEND_URL}/health`).then((r) => r.json());
  checks.add('the backend starts and answers /health', health.status === 'ok');
  checks.add('the backend reports a credential is configured', health.keyConfigured === true);
  checks.add('the backend names openrouter as the provider', health.provider === 'openrouter');
  const healthRaw = JSON.stringify(health);
  checks.add('the credential is absent from /health', !healthRaw.includes(DUMMY_KEY) && !/sk-or-v1-/.test(healthRaw));

  // ---------------------------------------------------------------------
  // Drive a real generation through the extension.
  // ---------------------------------------------------------------------
  await useProxyProvider(browser, BACKEND_URL);

  const page = await browser.newPage(DEMO_URL);
  const loaded = await browser
    .waitFor(page, `!!window.ROSE_DEMO`, { timeout: 20_000, label: 'demo page' })
    .catch(() => false);
  checks.add('the demo page loads', !!loaded);
  if (!loaded) throw new Error('demo page did not initialise');

  const mounted = await waitForOverlay(browser, page, 25_000).catch(() => false);
  checks.add('ROSE attaches with the proxy provider and no local key', !!mounted);

  const state = await ask(page, 'Hello, how are you?');
  const texts = (state?.suggestions ?? []).map((s) => s.text ?? '');
  checks.add('a generation through the proxy returns suggestions', texts.length === 3, `${texts.length} suggestion(s)`);
  checks.add('the suggestions carry real text', texts.every((t) => t.trim().length > 5), JSON.stringify(texts[0] ?? ''));

  // ---------------------------------------------------------------------
  // What actually crossed the wire.
  // ---------------------------------------------------------------------
  const requests = await aiRequests();
  const upstream = requests.at(-1);
  checks.add('the request reached the provider through the backend', !!upstream);
  checks.add(
    'the backend attached the credential upstream',
    upstream?.authorization === `Bearer ${DUMMY_KEY}`,
    String(upstream?.authorization ?? 'none'),
  );
  checks.add('the backend forwarded OpenRouter attribution headers', upstream?.referer === 'https://github.com/rose-ia');
  checks.add('the model reached the provider unchanged', upstream?.model === 'openai/gpt-4o-mini', String(upstream?.model));

  // The extension must not be able to see the credential anywhere.
  const extensionView = await evalInWorker(
    browser,
    `(async () => {
       const all = await chrome.storage.local.get(null);
       return JSON.stringify(all);
     })()`,
  );
  checks.add(
    'the credential is absent from extension storage',
    !String(extensionView).includes(DUMMY_KEY),
  );

  const pageView = await browser.eval(page, `JSON.stringify({ html: document.documentElement.outerHTML.length })`);
  checks.add('the credential is absent from the page', !String(pageView).includes(DUMMY_KEY));

  const backendLog = backend.log();
  checks.add('the credential is absent from the backend log', !backendLog.includes(DUMMY_KEY));

  // ---------------------------------------------------------------------
  // Failure paths.
  // ---------------------------------------------------------------------
  // A provider error must surface cleanly, without crashing and without a secret.
  await fetch('http://127.0.0.1:8788/__control/behaviour?mode=error&status=429').catch(() => {});
  const failed = await ask(page, 'Second message, provider will fail.');
  checks.add(
    'a provider failure surfaces an error rather than a suggestion',
    (failed?.suggestions ?? []).length === 0 || !!failed?.errorText,
    `error=${JSON.stringify(failed?.errorText ?? null)}`,
  );
  await fetch('http://127.0.0.1:8788/__control/behaviour?mode=ok&status=200').catch(() => {});

  // A dead backend must fail cleanly, not hang.
  await stopBackend(backend);
  backend = null;
  const dead = await ask(page, 'Third message, backend is gone.', { timeout: 30_000 });
  checks.add(
    'an unreachable backend produces an error, not a crash',
    (dead?.suggestions ?? []).length === 0 || !!dead?.errorText,
    `error=${JSON.stringify(dead?.errorText ?? null)}`,
  );
  checks.add('ROSE is still mounted after the backend died', !!(await overlay(page)));

  // ---------------------------------------------------------------------
  // Restarting the backend recovers without a page reload.
  // ---------------------------------------------------------------------
  backend = await startBackend();
  const recovered = await ask(page, 'Fourth message, backend is back.');
  checks.add(
    'generation recovers once the backend is back',
    (recovered?.suggestions ?? []).length === 3,
    `${(recovered?.suggestions ?? []).length} suggestion(s), error=${JSON.stringify(recovered?.errorText ?? null)}`,
  );

  // A backend with no credential must refuse, and say so, without leaking.
  await stopBackend(backend);
  backend = await startBackend({ OPENROUTER_API_KEY: '' });
  const noKey = await ask(page, 'Fifth message, backend has no credential.');
  checks.add(
    'a backend without a credential refuses instead of forwarding',
    (noKey?.suggestions ?? []).length === 0 || !!noKey?.errorText,
    `error=${JSON.stringify(noKey?.errorText ?? null)}`,
  );
  const noKeyLog = backend.log();
  checks.add('the keyless backend log carries no credential', !/sk-or-v1-/.test(noKeyLog));
} catch (err) {
  checks.add('phase completed without an unhandled exception', false, String(err?.message ?? err));
} finally {
  await stopBackend(backend);
  await browser.close().catch(() => {});
}

process.stdout.write(`\n${checks.summary()}\n`);
if (checks.failed.length) {
  process.stdout.write('Failures:\n');
  for (const f of checks.failed) process.stdout.write(`  - ${f.name}: ${f.detail}\n`);
}
process.exit(checks.failed.length ? 1 : 0);
