/**
 * Phase 5 — the pipeline against a REAL model.
 *
 * Everything before this phase ran against a mock provider on localhost. That
 * proves the plumbing but not that a real model's output survives ROSE's
 * parsers, or that a real provider's failures degrade safely. This phase drives
 * the built extension through the demo page and lets it talk to a genuine
 * OpenAI-compatible endpoint over the public internet.
 *
 * Provider: Pollinations (`https://text.pollinations.ai/openai`) — a real,
 * keyless endpoint serving a real model. It was chosen because this environment
 * holds no provider credential and none may be invented or committed. Nothing
 * here is mocked: the request, the model, the tokens and the error statuses are
 * all real. If ROSE_PHASE5_API_KEY and ROSE_PHASE5_BASE_URL are set, those are
 * used instead so the same phase can be run against a paid provider.
 *
 *   node scripts/validation/phase5-real-ai.mjs
 */

import { Browser, sleep } from '../cdp.mjs';
import {
  Checks,
  configureRose,
  setApiKey,
  evalInWorker,
  waitForOverlay,
  sendCommandToTab,
  clearAllRoseData,
  readOverlay,
} from './helpers.mjs';

const extensionDir = process.argv[2] ?? '/workspace/project/dist';
const checks = new Checks('PHASE 5 — real AI provider');
const report = { provider: {}, cases: [] };

// A paid provider can be swapped in without touching the harness.
const PROVIDER = process.env.ROSE_PHASE5_BASE_URL
  ? {
      id: 'openai',
      label: 'ROSE_PHASE5_BASE_URL',
      baseUrl: process.env.ROSE_PHASE5_BASE_URL,
      model: process.env.ROSE_PHASE5_MODEL ?? 'gpt-4o-mini',
      apiKey: process.env.ROSE_PHASE5_API_KEY ?? '',
    }
  : {
      id: 'pollinations',
      label: 'Pollinations (keyless)',
      baseUrl: 'https://text.pollinations.ai/openai',
      model: process.env.ROSE_PHASE5_MODEL ?? 'openai',
      apiKey: '',
      requiresKey: false,
    };

const DEMO_URL = 'http://127.0.0.1:8788/demo/demo.html';

/** Calls one of the demo's exposed helpers in the page's own world. */
function demo(page, expression) {
  return browser.eval(page, `(() => { const d = window.ROSE_DEMO; return ${expression}; })()`);
}

/** Reads the overlay's rendered state, tolerating a missing overlay. */
async function overlay(page) {
  return browser.eval(page, readOverlay()).catch(() => null);
}

/**
 * Adds an incoming message and waits for ROSE to react to *that* message.
 *
 * Waiting for "any suggestion is on screen" is wrong: the overlay keeps the
 * previous message's suggestions visible, so the wait returned instantly and
 * every assertion afterwards read stale state. This waits for the suggestion
 * set to actually change (or, in auto mode, for a new outgoing message).
 */
async function ask(page, text, { timeout = 90_000, expect = 'suggestions' } = {}) {
  const before = await overlay(page);
  const beforeFp = JSON.stringify((before?.suggestions ?? []).map((s) => s.text ?? ''));
  const beforeOutgoing = await outgoingCount(page);

  await browser.eval(page, `window.ROSE_DEMO.addIncoming(${JSON.stringify(text)})`);

  const deadline = Date.now() + timeout;
  let last = before;
  while (Date.now() < deadline) {
    last = await overlay(page);
    const texts = (last?.suggestions ?? []).map((s) => s.text ?? '');
    const fp = JSON.stringify(texts);

    if (expect === 'send' && (await outgoingCount(page)) > beforeOutgoing) return last;
    if (expect === 'suggestions' && fp !== beforeFp && texts.some((t) => t.trim().length > 5)) return last;
    // A generation that genuinely failed is a result, not something to keep
    // waiting on.
    if (last?.errorText && !/No incoming message detected/i.test(last.errorText)) return last;
    await sleep(1200);
  }
  return last;
}

/** True when a message was auto-answered (auto mode), so no suggestion shows. */
async function outgoingCount(page) {
  const msgs = JSON.parse(await demo(page, `JSON.stringify(d.messages())`));
  return msgs.filter((m) => m.dir === 'out').length;
}

/**
 * Runs a real extension RPC from the content script's isolated world.
 *
 * The service worker cannot `sendMessage` to itself, so every RPC has to
 * originate in a page context. The main world cannot see `chrome.runtime`, so
 * the call is staged across the two worlds: the isolated world installs a
 * listener and performs the RPC, the main world dispatches the request event.
 */
async function rpcViaPage(browser, page, type, payload, timeout = 45_000) {
  const channel = `rose-phase5-${type.replace(/\W/g, '-')}-${Date.now()}`;
  await browser.evalIsolated(
    page,
    `(() => {
       window.__rosePhase5 = window.__rosePhase5 ?? {};
       window.addEventListener(${JSON.stringify(channel)}, async (e) => {
         try {
           const res = await chrome.runtime.sendMessage({ type: ${JSON.stringify(type)}, payload: e.detail.payload, requestId: e.detail.requestId });
           window.__rosePhase5[${JSON.stringify(channel)}] = { done: true, res };
         } catch (err) {
           window.__rosePhase5[${JSON.stringify(channel)}] = { done: true, error: String(err && err.message || err) };
         }
       });
       return true;
     })()`,
  );

  await browser.eval(
    page,
    `(() => {
       window.dispatchEvent(new CustomEvent(${JSON.stringify(channel)}, {
         detail: { payload: ${JSON.stringify(payload)}, requestId: ${JSON.stringify(channel)} },
       }));
       return true;
     })()`,
  );

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const got = await browser.evalIsolated(
      page,
      `(() => { const r = window.__rosePhase5?.[${JSON.stringify(channel)}]; return r && r.done ? r : null; })()`,
    );
    if (got) {
      // `got.res` is the RPC response itself (`{ok, data|error}`); returning
      // `got` would bury it one level down and make every assertion read
      // `ok: undefined`.
      return got.res ? got.res : { ok: false, error: got.error };
    }
    await sleep(500);
  }
  return { ok: false, error: 'timeout waiting for RPC result' };
}

/** Forces a regeneration through the overlay's own Regenerate button. */
async function regenerate(page) {
  return browser.eval(
    page,
    `(() => {
       const root = document.getElementById('rose-shadow-host')?.shadowRoot;
       if (!root) return { ok: false, error: 'no overlay' };
       const btn = Array.from(root.querySelectorAll('button'))
         .find((b) => /Regenerate|Generate/i.test(b.textContent) && !b.disabled);
       if (!btn) return { ok: false, error: 'no regenerate button' };
       btn.click();
       return { ok: true };
     })()`,
  );
}

/** Reads ROSE's persisted daily stats out of chrome.storage. */
function readStats() {
  return `(async () => {
    const all = await chrome.storage.local.get(null);
    const days = Object.entries(all).filter(([k]) => k.startsWith('rose:stats:') && !k.endsWith('__index__'));
    return days.map(([k, v]) => ({ day: k.replace('rose:stats:', ''), ...v }));
  })()`;
}

const browser = await Browser.launch({ extensionDir });

try {
  await browser.waitForServiceWorker(30_000);
  await clearAllRoseData();

  // No key is passed for the keyless provider; setApiKey is still called so a
  // paid provider configured through the env vars works unchanged.
  await configureRose(browser, {
    ai: {
      activeProvider: PROVIDER.id,
      providers: [
        {
          id: PROVIDER.id,
          label: PROVIDER.label,
          baseUrl: PROVIDER.baseUrl,
          model: PROVIDER.model,
          fastModel: PROVIDER.model,
          enabled: true,
          viaProxy: false,
          requiresKey: PROVIDER.requiresKey !== false,
          temperature: 0.7,
          maxTokens: 320,
        },
      ],
      // The consent gate keeps AI off until the policy is acknowledged.
      acknowledgedPolicy: true,
      maxResponseChars: 600,
    },
    conversation: { style: 'natural', length: 'short', suggestionCount: 3, targetLanguage: 'auto' },
    automation: { mode: 'manual', globalEnabled: true, replyDelayMs: 2000 },
    translation: { enabled: true, autoTranslateIncoming: false, myLanguage: 'fr' },
    memory: { enabled: true, maxRecentMessages: 12 },
    debug: { enabled: true, verbose: true, showOverlay: true },
  });
  if (PROVIDER.apiKey) await setApiKey(browser, PROVIDER.id, PROVIDER.apiKey);

  const page = await browser.newPage(DEMO_URL);
  const loaded = await browser
    .waitFor(page, `!!window.ROSE_DEMO`, { timeout: 20_000, label: 'demo page' })
    .catch(() => false);
  checks.add('demo page loads', !!loaded);
  if (!loaded) throw new Error('demo page did not initialise');

  const mounted = await waitForOverlay(browser, page, 25_000).catch(() => false);
  checks.add('ROSE attaches to the demo page', !!mounted);

  const tabs = await evalInWorker(browser, `(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url })))()`);
  const tab = tabs.find((t) => t.url.includes('demo.html'));
  checks.add('demo tab found for command routing', !!tab);

  // Nothing in this phase should send anything until the auto-mode section, so
  // the outgoing count is captured once here and compared against at the end.
  const outgoingBaseline = await outgoingCount(page);

  // -------------------------------------------------------------------------
  // 1. Normal reply — a real model answer must survive the parser
  // -------------------------------------------------------------------------
  const normal = await ask(page, 'What do you do for a living?');
  report.cases.push({ name: 'normal', overlay: normal });
  checks.add(
    'real provider returns parseable suggestions',
    (normal?.suggestionCount ?? 0) > 0,
    `${normal?.suggestionCount ?? 0} suggestion(s); error=${normal?.errorText ?? 'none'}`,
  );
  checks.add(
    'suggestions carry real text (not a placeholder)',
    (normal?.suggestions ?? []).some((s) => (s.text ?? '').length > 5),
    JSON.stringify((normal?.suggestions ?? []).map((s) => (s.text ?? '').slice(0, 70))),
  );
  checks.add(
    'no provider error surfaced on the happy path',
    !normal?.errorText,
    normal?.errorText ?? 'clean',
  );

  // -------------------------------------------------------------------------
  // 2. Multilingual — a French message answered in English
  // -------------------------------------------------------------------------
  const multi = await ask(page, "Bonjour ! Comment vas-tu aujourd'hui ?");
  report.cases.push({ name: 'multilingual', overlay: multi });
  const multiText = (multi?.suggestions ?? []).map((s) => s.text ?? '').join(' | ');
  checks.add(
    'a French message still produces suggestions',
    (multi?.suggestionCount ?? 0) > 0,
    `${multi?.suggestionCount ?? 0} suggestion(s)`,
  );
  checks.add(
    'the reply is not a copy of the French prompt',
    multiText.length > 0 && !/Bonjour ! Comment vas-tu/.test(multiText),
    multiText.slice(0, 90),
  );

  // -------------------------------------------------------------------------
  // 3. Context — a follow-up must not be answered as if it were the first
  // -------------------------------------------------------------------------
  const context = await ask(page, 'And what about you, what do you do?');
  report.cases.push({ name: 'context', overlay: context });
  checks.add(
    'a follow-up message is answered too',
    (context?.suggestionCount ?? 0) > 0,
    `${context?.suggestionCount ?? 0} suggestion(s)`,
  );

  // -------------------------------------------------------------------------
  // 4. Memory — a fact stated in the conversation must be extracted and stored
  // -------------------------------------------------------------------------
  // Memory maintenance is deliberately throttled in production (it runs every
  // sixth message so a chat does not pay for a summary on every line). The test
  // therefore drives a dedicated conversation past that threshold through the
  // real RPC the content script uses, instead of expecting one message to
  // trigger extraction.
  const memoryClient = { id: 'generic:phase5-memory', platform: 'generic', clientId: 'phase5-memory', displayName: 'Sofia' };
  const factsClientText = 'My name is Sofia and I live in Madrid, I work as a nurse.';
  for (let i = 0; i < 6; i++) {
    await rpcViaPage(browser, page, 'rose/message/detected', {
      conversation: memoryClient,
      text: i === 0 ? factsClientText : `Follow-up message number ${i} in this conversation.`,
      language: 'en',
    });
    await sleep(300);
  }
  // Fact extraction is a background call to the real model; give it room.
  const factsDeadline = Date.now() + 60_000;
  let memoryRecord = null;
  while (Date.now() < factsDeadline) {
    memoryRecord = await evalInWorker(browser, `(async () => (await chrome.storage.local.get(['rose:memory:generic:phase5-memory']))['rose:memory:generic:phase5-memory'] ?? null)()`);
    const blob = JSON.stringify(memoryRecord?.importantFacts ?? []).toLowerCase();
    if (blob.includes('madrid') || blob.includes('sofia') || blob.includes('nurse')) break;
    await sleep(2500);
  }
  report.memory = {
    id: memoryRecord?.id ?? null,
    facts: (memoryRecord?.importantFacts ?? []).map((f) => `${f.key}=${f.value}`),
    summary: (memoryRecord?.summary ?? '').slice(0, 160),
    recent: (memoryRecord?.recentMessages ?? []).length,
  };
  checks.add(
    'memory records exist for the conversation',
    !!memoryRecord,
    memoryRecord?.id ?? 'none',
  );
  checks.add(
    'recent messages are stored for context',
    (memoryRecord?.recentMessages ?? []).length > 0,
    `${(memoryRecord?.recentMessages ?? []).length} message(s)`,
  );
  const factsBlob = JSON.stringify(memoryRecord?.importantFacts ?? []).toLowerCase();
  checks.add(
    'a stated fact is extracted and persisted',
    factsBlob.includes('madrid') || factsBlob.includes('sofia') || factsBlob.includes('nurse'),
    JSON.stringify(report.memory.facts),
  );
  checks.add(
    'the conversation summary is rolled forward by the real model',
    (memoryRecord?.summary ?? '').trim().length > 0,
    JSON.stringify(report.memory.summary),
  );

  // Memory must stay isolated per client: the demo's own client must not have
  // inherited the facts stated in the memory-test conversation.
  const otherMemory = await evalInWorker(browser, `(async () => (await chrome.storage.local.get(['rose:memory:generic:sophie-4821']))['rose:memory:generic:sophie-4821'] ?? null)()`);
  const otherBlob = JSON.stringify(otherMemory?.importantFacts ?? []).toLowerCase();
  checks.add(
    'facts do not leak into another client’s memory',
    !otherBlob.includes('madrid') && !otherBlob.includes('nurse'),
    JSON.stringify((otherMemory?.importantFacts ?? []).map((f) => f.value)),
  );

  // -------------------------------------------------------------------------
  // 5. Translation — real French → English through the real provider
  // -------------------------------------------------------------------------
  const translated = await rpcViaPage(browser, page, 'rose/translate', {
    text: 'Salut, comment vas-tu ?',
    targetLanguage: 'en',
    tone: 'neutral',
  });
  report.translation = translated;
  checks.add(
    'translation fr→en returns text',
    translated?.ok === true && (translated?.data?.text ?? '').length > 0,
    JSON.stringify(translated?.data?.text ?? translated?.error ?? translated).slice(0, 160),
  );
  checks.add(
    'the translation is actually English',
    /\b(how are you|hello|hi|hey|what'?s up|doing)\b/i.test(String(translated?.data?.text ?? '')),
    JSON.stringify(translated?.data?.text ?? '').slice(0, 120),
  );

  const backToFr = await rpcViaPage(browser, page, 'rose/translate', {
    text: "I'm doing well, and you?",
    targetLanguage: 'fr',
    tone: 'neutral',
  });
  report.translationBack = backToFr;
  const frText = String(backToFr?.data?.text ?? '');
  checks.add(
    'translation en→fr returns French text',
    backToFr?.ok === true &&
      (/[àâçéèêëîïôûùüÿœ]/i.test(frText) || /\b(je|tu|vous|bien|et toi|comment)\b/i.test(frText)),
    JSON.stringify(frText || backToFr?.error || backToFr).slice(0, 160),
  );

  // An empty input must be rejected, not sent to the provider.
  const emptyTranslation = await rpcViaPage(browser, page, 'rose/translate', {
    text: '',
    targetLanguage: 'en',
    tone: 'neutral',
  });
  checks.add(
    'an empty translation request fails cleanly',
    emptyTranslation?.ok !== true || (emptyTranslation?.data?.text ?? '') === '',
    JSON.stringify(emptyTranslation).slice(0, 160),
  );

  // -------------------------------------------------------------------------
  // 6. Manual mode — suggestions appear, nothing is ever sent
  // -------------------------------------------------------------------------
  const manualState = await overlay(page);
  report.manual = { overlay: manualState };
  checks.add(
    'manual mode shows suggestions without sending',
    (manualState?.suggestionCount ?? 0) > 0 && (await outgoingCount(page)) === outgoingBaseline,
    `suggestions=${manualState?.suggestionCount ?? 0}, outgoing unchanged`,
  );

  // -------------------------------------------------------------------------
  // 7. Assisted mode — prepares text in the field, still no send
  // -------------------------------------------------------------------------
  if (tab) await sendCommandToTab(browser, tab.id, { action: 'set-mode', mode: 'assisted' });
  await sleep(1000);

  const assisted = await ask(page, 'That sounds nice! Tell me more about it.');
  report.assisted = assisted;
  const fieldValue = await demo(page, `d.getInput()`);
  checks.add(
    'assisted mode prepares text in the message field',
    String(fieldValue ?? '').trim().length > 0,
    JSON.stringify(String(fieldValue ?? '').slice(0, 90)),
  );
  checks.add(
    'assisted mode does not send on its own',
    (await outgoingCount(page)) === outgoingBaseline,
    `outgoing still ${outgoingBaseline}`,
  );

  // -------------------------------------------------------------------------
  // 8. Auto mode — exactly one send per message, and STOP is immediate
  // -------------------------------------------------------------------------
  if (tab) await sendCommandToTab(browser, tab.id, { action: 'set-mode', mode: 'auto' });
  await sleep(800);
  const autoMessages = JSON.parse(await demo(page, `JSON.stringify(d.messages())`));
  const outBefore = autoMessages.filter((m) => m.dir === 'out').length;

  await browser.eval(page, `window.ROSE_DEMO.addIncoming('Are you free to talk later tonight?')`);
  // The delay gate is 2s; allow for the model plus the send delay.
  const sentDeadline = Date.now() + 90_000;
  let outAfter = outBefore;
  while (Date.now() < sentDeadline) {
    const msgs = JSON.parse(await demo(page, `JSON.stringify(d.messages())`));
    outAfter = msgs.filter((m) => m.dir === 'out').length;
    if (outAfter > outBefore) break;
    await sleep(2000);
  }
  report.auto = { outBefore, outAfter };
  checks.add(
    'auto mode sends exactly one reply for the message',
    outAfter === outBefore + 1,
    `${outBefore} → ${outAfter} outgoing message(s)`,
  );

  // STOP must be immediate and must prevent any further automatic send.
  await browser.eval(page, readOverlay()).catch(() => null);
  const stopped = await browser.eval(
    page,
    `(() => {
       const root = document.getElementById('rose-shadow-host')?.shadowRoot;
       const btn = root?.querySelector('.stop-btn');
       if (!btn || btn.disabled) return { ok: false, error: 'stop unavailable' };
       btn.click();
       return { ok: true };
     })()`,
  );
  checks.add('STOP button is clickable', stopped?.ok === true, JSON.stringify(stopped));
  await sleep(500);

  const outAtStop = JSON.parse(await demo(page, `JSON.stringify(d.messages())`)).filter((m) => m.dir === 'out').length;
  await browser.eval(page, `window.ROSE_DEMO.addIncoming('One more question for you!')`);
  await sleep(12_000);
  const outAfterStop = JSON.parse(await demo(page, `JSON.stringify(d.messages())`)).filter((m) => m.dir === 'out').length;
  checks.add(
    'STOP prevents any further automatic send',
    outAfterStop === outAtStop,
    `${outAtStop} → ${outAfterStop} outgoing message(s) after STOP`,
  );

  // -------------------------------------------------------------------------
  // 9. Provider failures — ROSE must fail cleanly and never inject garbage
  // -------------------------------------------------------------------------
  // A real 4xx from the real provider: an unknown model is the honest way to
  // provoke one without a credential.
  await configureRose(browser, {
    ai: {
      activeProvider: PROVIDER.id,
      providers: [
        {
          id: PROVIDER.id,
          label: PROVIDER.label,
          baseUrl: PROVIDER.baseUrl,
          model: 'rose-model-that-does-not-exist-xyz',
          fastModel: 'rose-model-that-does-not-exist-xyz',
          enabled: true,
          viaProxy: false,
          requiresKey: PROVIDER.requiresKey !== false,
        },
      ],
    },
    automation: { mode: 'manual' },
  });
  if (tab) await sendCommandToTab(browser, tab.id, { action: 'set-mode', mode: 'manual' });
  await sleep(1200);

  const beforeError = await demo(page, `d.getInput()`);
  const failed = await ask(page, 'Please answer this with a model that does not exist.', { timeout: 60_000 });
  report.providerError = failed;
  checks.add(
    'an unknown model produces an error, not a suggestion',
    (failed?.suggestionCount ?? 0) === 0,
    `suggestions=${failed?.suggestionCount ?? 0}`,
  );
  checks.add(
    'the failure is surfaced to the operator',
    !!(failed?.errorText || failed?.statusNote),
    `error=${JSON.stringify(failed?.errorText)} note=${JSON.stringify(failed?.statusNote)}`,
  );
  const afterError = await demo(page, `d.getInput()`);
  checks.add(
    'a failed generation injects nothing into the message field',
    String(afterError ?? '') === String(beforeError ?? ''),
    JSON.stringify(String(afterError ?? '').slice(0, 80)),
  );

  // -------------------------------------------------------------------------
  // 10. Unreachable provider — a network failure must also be clean
  // -------------------------------------------------------------------------
  await configureRose(browser, {
    ai: {
      activeProvider: PROVIDER.id,
      providers: [
        {
          id: PROVIDER.id,
          label: 'unreachable',
          // Reserved for documentation/testing; nothing listens here.
          baseUrl: 'https://text.pollinations.ai:9/openai',
          model: 'openai',
          fastModel: 'openai',
          enabled: true,
          viaProxy: false,
          requiresKey: PROVIDER.requiresKey !== false,
        },
      ],
    },
  });
  await sleep(1200);
  const unreachable = await ask(page, 'Is anyone there?', { timeout: 60_000 });
  report.unreachable = unreachable;
  checks.add(
    'an unreachable provider produces an error, not a suggestion',
    (unreachable?.suggestionCount ?? 0) === 0 && !!(unreachable?.errorText || unreachable?.statusNote),
    `error=${JSON.stringify(unreachable?.errorText)}`,
  );

  // -------------------------------------------------------------------------
  // 11. Token accounting — real usage, not an estimate
  // -------------------------------------------------------------------------
  const stats = await evalInWorker(browser, readStats());
  report.stats = stats;
  const total = (stats ?? []).reduce(
    (acc, d) => ({
      requests: acc.requests + (d.requests ?? 0),
      tokensPrompt: acc.tokensPrompt + (d.tokensPrompt ?? 0),
      tokensCompletion: acc.tokensCompletion + (d.tokensCompletion ?? 0),
      responsesGenerated: acc.responsesGenerated + (d.responsesGenerated ?? 0),
    }),
    { requests: 0, tokensPrompt: 0, tokensCompletion: 0, responsesGenerated: 0 },
  );
  report.tokenTotals = total;
  checks.add(
    'real token usage was recorded',
    total.tokensPrompt > 0 && total.tokensCompletion > 0,
    `prompt=${total.tokensPrompt} completion=${total.tokensCompletion} requests=${total.requests}`,
  );
  checks.add(
    'a successful generation was counted',
    total.responsesGenerated > 0,
    `responsesGenerated=${total.responsesGenerated}`,
  );

  // -------------------------------------------------------------------------
  // 12. Latency
  // -------------------------------------------------------------------------
  // The unreachable provider from section 10 is still active; restore the real
  // one or every latency call fails for the wrong reason.
  await configureRose(browser, {
    ai: {
      activeProvider: PROVIDER.id,
      providers: [
        {
          id: PROVIDER.id,
          label: PROVIDER.label,
          baseUrl: PROVIDER.baseUrl,
          model: PROVIDER.model,
          fastModel: PROVIDER.model,
          enabled: true,
          viaProxy: false,
          requiresKey: PROVIDER.requiresKey !== false,
        },
      ],
    },
  });
  await sleep(1500);

  const timings = [];
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const r = await rpcViaPage(
      browser,
      page,
      'rose/ai/suggestions',
      {
        conversation: { id: `latency-${i}`, platform: 'generic', clientId: `latency-${i}`, displayName: 'Latency' },
        incoming: 'Tell me something interesting about yourself',
        style: 'natural',
        length: 'short',
        targetLanguage: 'auto',
        count: 1,
        force: true,
      },
      70_000,
    );
    timings.push({ ms: Date.now() - t0, ok: r?.ok === true, model: r?.data?.result?.model ?? null });
  }
  report.latency = timings;
  checks.add(
    'generation latency measured against the real provider',
    timings.some((t) => t.ok && t.ms > 0),
    timings.map((t) => `${t.ok ? 'ok' : 'fail'} ${t.ms}ms (${t.model ?? 'n/a'})`).join(', '),
  );
} catch (err) {
  checks.add('phase completed without harness error', false, err.message);
} finally {
  await browser.close();
}

process.stdout.write(`\n${checks.summary()}\n`);
for (const f of checks.failed) process.stdout.write(`  FAILED: ${f.name} — ${f.detail}\n`);
process.stdout.write(`\nfull report: /tmp/rose-phase5.json\n`);
import fs from 'node:fs';
fs.writeFileSync('/tmp/rose-phase5.json', JSON.stringify(report, null, 2));
process.exit(checks.failed.length ? 1 : 0);
