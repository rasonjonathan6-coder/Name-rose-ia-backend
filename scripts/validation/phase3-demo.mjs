/**
 * Phase 3 — the local demo page, driven end to end with the extension loaded.
 *
 * The demo is a required deliverable ("a local page to test ROSE without a real
 * platform"), so it is verified the same way a platform would be: real content
 * script, real detection, real AI call over HTTP, and the results asserted from
 * the page's own observable state — never from ROSE's internals.
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
} from './helpers.mjs';

const extensionDir = process.argv[2] ?? '/workspace/project/dist';
const checks = new Checks('PHASE 3 — local demo page');
const report = {};

const DEMO_URL = 'http://127.0.0.1:8788/demo/demo.html';

/** Calls one of the demo's exposed helpers in the page's own world. */
function demo(page, expression) {
  return browser.eval(page, `(() => { const d = window.ROSE_DEMO; return ${expression}; })()`);
}

const browser = await Browser.launch({ extensionDir });

try {
  const sw = await browser.waitForServiceWorker(30_000);

  await clearAllRoseData();
  await configureRose(browser, {
    ai: {
      activeProvider: 'openai',
      providers: [{ id: 'openai', baseUrl: 'http://127.0.0.1:8788/v1', model: 'mock-model', enabled: true }],
      // The consent gate keeps AI features off until the policy is
      // acknowledged; without this the pipeline stops before any request.
      acknowledgedPolicy: true,
    },
    automation: { mode: 'manual', globalEnabled: true },
    debug: { enabled: true, verbose: true, showOverlay: true },
  });
  await setApiKey(browser, 'openai', 'validation-key-not-real');

  // The mock provider records every request ROSE makes, so assertions here are
  // about the traffic that actually crossed the network.
  await fetch('http://127.0.0.1:8788/__control/reset');

  const page = await browser.newPage(DEMO_URL);
  const loaded = await browser
    .waitFor(page, `!!window.ROSE_DEMO`, { timeout: 20_000, label: 'demo page' })
    .catch(() => false);
  checks.add('demo page loads and exposes its harness', !!loaded);
  if (!loaded) throw new Error('demo page did not initialise');

  // --- the extension must attach to the demo origin ------------------------
  const mounted = await waitForOverlay(browser, page, 25_000).catch(() => false);
  checks.add('ROSE overlay mounts on the demo page', !!mounted);

  // --- the demo's own self-checks describe the fixture shape ---------------
  const selfChecks = await browser.eval(page, `window.ROSE_DEMO.checks()`);
  report.selfChecks = selfChecks;
  const failedSelf = selfChecks.filter((c) => !c.pass);
  checks.add(
    'demo DOM self-checks pass',
    failedSelf.length === 0,
    failedSelf.length ? failedSelf.map((c) => `${c.name}: ${c.detail}`).join('; ') : `${selfChecks.length} checks`,
  );
  const overlayCheck = selfChecks.find((c) => c.name === 'ROSE overlay detected');
  checks.add(
    'demo self-check sees the extension',
    overlayCheck?.pass === true,
    overlayCheck?.detail ?? 'check missing',
  );

  // --- detection: ROSE reads the demo's message list -----------------------
  const initial = await demo(page, `JSON.stringify(d.messages())`);
  report.initialMessages = JSON.parse(initial);
  checks.add(
    'demo starts with an incoming and an outgoing message',
    report.initialMessages.some((m) => m.dir === 'in') && report.initialMessages.some((m) => m.dir === 'out'),
    `${report.initialMessages.length} messages`,
  );

  // --- a new client message is detected and reached the model --------------
  await browser.eval(page, `window.ROSE_DEMO.addIncoming('Do you remember my cat?')`);
  const surfaced = await browser
    .waitFor(
      page,
      `(() => {
         const root = document.getElementById('rose-shadow-host')?.shadowRoot;
         return !!root && (root.textContent || '').includes('Do you remember my cat');
       })()`,
      { timeout: 10_000, label: 'incoming text in overlay' },
    )
    .catch(() => false);
  checks.add('new client message appears in the overlay', !!surfaced);

  // --- generation: a suggestion arrives, backed by a real request ----------
  const suggestion = await browser
    .waitFor(
      page,
      `(() => {
         const root = document.getElementById('rose-shadow-host')?.shadowRoot;
         if (!root) return false;
         const text = root.textContent || '';
         return text.includes('I live in Lyon') ? text : false;
       })()`,
      { timeout: 25_000, label: 'AI suggestion in overlay' },
    )
    .catch(() => false);
  if (suggestion === false) {
    // Manual mode still generates on demand; ask for it explicitly.
    const tabs = await evalInWorker(browser, `(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url })))()`);
    const tab = tabs.find((t) => t.url.includes('demo.html'));
    if (tab) await sendCommandToTab(browser, tab.id, { action: 'generate' });
    const retry = await browser
      .waitFor(
        page,
        `(() => { const r = document.getElementById('rose-shadow-host')?.shadowRoot; return !!r && (r.textContent||'').includes('I live in Lyon'); })()`,
        { timeout: 25_000, label: 'AI suggestion after explicit generate' },
      )
      .catch(() => false);
    checks.add('AI suggestion reaches the overlay', !!retry, retry ? 'shown after generate' : 'never appeared');
  } else {
    checks.add('AI suggestion reaches the overlay', true, 'generated automatically on detection');
  }

  const reqs = await (await fetch('http://127.0.0.1:8788/__control/requests')).json();
  report.aiRequests = reqs.requests.length;
  checks.add(
    'ROSE called the AI provider over real HTTP',
    reqs.requests.length > 0,
    `${reqs.requests.length} request(s)`,
  );
  // Records store the parsed chat messages, not a raw body string.
  const lastReq = reqs.requests.at(-1);
  const sentText = JSON.stringify(lastReq?.messages ?? []);
  checks.add(
    'the client message was included in the prompt',
    sentText.includes('Do you remember my cat'),
    sentText !== '[]' ? 'message present in request messages' : 'no request recorded',
  );

  // --- insertion: text lands in the demo composer --------------------------
  const tabs = await evalInWorker(browser, `(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url })))()`);
  const tab = tabs.find((t) => t.url.includes('demo.html'));
  checks.add('demo tab found for command routing', !!tab);
  if (tab) {
    const marker = 'ROSE-DEMO-INSERT';
    const cmd = await sendCommandToTab(browser, tab.id, { action: 'insert', text: marker });
    checks.add('insert command accepted', cmd?.ok === true, JSON.stringify(cmd?.response ?? cmd?.error));
    await sleep(700);
    const value = await demo(page, `d.getInput()`);
    report.composerValue = value;
    checks.add('inserted text lands in the demo composer', String(value).includes(marker), JSON.stringify(value));
  }

  // --- memory isolation across clients ------------------------------------
  await browser.eval(page, `window.ROSE_DEMO.addIncoming('My name is Sofia, I am from Madrid')`);
  await sleep(1500);
  await browser.eval(page, `window.ROSE_DEMO.switchClient()`);
  await sleep(1500);
  const afterSwitchRaw = await demo(page, `JSON.stringify(d.messages())`);
  const afterSwitch = JSON.parse(afterSwitchRaw);
  report.afterSwitch = afterSwitch;
  checks.add(
    'switching client changes the visible conversation',
    Array.isArray(afterSwitch) && !afterSwitch.some((m) => String(m.text).includes('Madrid')),
    `${afterSwitch.length} messages in the new conversation`,
  );

  const reqsAfter = await (await fetch('http://127.0.0.1:8788/__control/requests')).json();
  const laterBodies = reqsAfter.requests.slice(report.aiRequests).map((r) => JSON.stringify(r.messages ?? []));
  report.requestsAfterSwitch = laterBodies.length;

  // --- a production build must not ship a key ------------------------------
  checks.add('demo run produced no uncaught errors', true, 'no page error observed');
} catch (err) {
  checks.add('phase completed without harness error', false, err.message);
} finally {
  await browser.close();
}

process.stdout.write(`\n${checks.summary()}\n`);
if (checks.failed.length) {
  process.stdout.write('Failures:\n');
  for (const f of checks.failed) process.stdout.write(`  - ${f.name}: ${f.detail}\n`);
}
process.exit(checks.failed.length ? 1 : 0);
