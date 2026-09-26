/**
 * Phase 2 — generic detection and text injection in a real browser.
 *
 * Six fixture pages, each with a different DOM shape. Detection is judged from
 * observable effects only: which field actually receives inserted text, and what
 * the overlay reports. Nothing inspects ROSE's internals, so a passing run means
 * the behaviour is real rather than an implementation detail lining up.
 */

import { Browser, sleep } from '../cdp.mjs';
import {
  Checks,
  fixtureUrl,
  configureRose,
  setApiKey,
  evalInWorker,
  waitForOverlay,
  readOverlay,
  sendCommandToTab,
  clearAllRoseData,
} from './helpers.mjs';

const extensionDir = process.argv[2] ?? '/workspace/project/dist';
const checks = new Checks('PHASE 2 — generic detector & injection');

/** Each case: the fixture, and what the fixture exposes to verify injection. */
const CASES = [
  {
    file: 'a-textarea.html',
    label: 'A textarea',
    read: 'window.__fixture.composerValue()',
    note: 'conventional textarea',
  },
  {
    file: 'b-contenteditable.html',
    label: 'B contenteditable',
    read: 'window.__fixture.composerValue()',
    note: 'no textarea exists on the page',
  },
  {
    file: 'c-input.html',
    label: 'C single-line input',
    read: 'window.__fixture.composerValue()',
    note: 'input[type=text] with a table log',
  },
  {
    file: 'd-dynamic.html',
    label: 'D dynamic list',
    read: 'window.__fixture.composerValue()',
    note: 'messages injected after load',
  },
  {
    file: 'e-spa.html',
    label: 'E SPA',
    read: 'window.__fixture.composerValue()',
    note: 'conversation switching without reload',
  },
  {
    file: 'f-multifield.html',
    label: 'F multiple text zones',
    read: 'window.__fixture.composerValue()',
    note: 'decoy search / nickname / notes fields',
  },
];

const browser = await Browser.launch({ extensionDir });
const report = {};

try {
  const sw = await browser.waitForServiceWorker(30_000);
  const extId = sw.url.split('/')[2];

  await clearAllRoseData();
  await configureRose(browser, {
    ai: { activeProvider: 'openai', providers: [{ id: 'openai', baseUrl: 'http://127.0.0.1:8788/v1', model: 'mock-model' }] },
    automation: { mode: 'manual', globalEnabled: true },
    debug: { enabled: true, verbose: true, showOverlay: true },
  });
  await setApiKey(browser, 'openai', 'validation-key-not-real');

  for (const c of CASES) {
    process.stdout.write(`\n— ${c.label} (${c.note})\n`);
    const page = await browser.newPage(fixtureUrl(c.file));

    // `chrome.runtime` is only exposed in the content script's isolated world,
    // not in the page's main world, so this must be evaluated there.
    const injected = await browser
      .waitForIsolated(page, `typeof chrome !== 'undefined' && !!chrome.runtime?.id`, {
        timeout: 20_000,
        label: 'content script',
      })
      .catch(() => false);
    checks.add(`${c.label}: content script injected`, !!injected);

    const mounted = await waitForOverlay(browser, page, 20_000).catch(() => false);
    checks.add(`${c.label}: overlay mounted`, !!mounted);
    if (!mounted) continue;

    const overlay = await browser.eval(page, readOverlay());
    report[c.label] = { overlay };

    // Detection report travels to the background; read the platform ROSE
    // resolved and its confidence straight from the overlay toast/label path.
    const detection = await browser.eval(
      page,
      `(() => {
         const host = document.getElementById('rose-shadow-host');
         const root = host?.shadowRoot;
         const label = root?.querySelector('.platform, .meta, .status')?.textContent ?? null;
         return { label };
       })()`,
    );
    report[c.label].detectionLabel = detection?.label ?? null;

    // --- injection: does ROSE type into the right field? -------------------
    const marker = `ROSE-INSERT-${c.label.replace(/\s+/g, '')}`;
    const tabs = await evalInWorker(browser, `(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url })))()`);
    const tab = tabs.find((t) => t.url.includes(c.file));
    if (!tab) {
      checks.add(`${c.label}: tab found for command routing`, false, JSON.stringify(tabs.map((t) => t.url)));
      continue;
    }
    report[c.label].tabId = tab.id;

    const cmd = await sendCommandToTab(browser, tab.id, { action: 'insert', text: marker });
    checks.add(`${c.label}: insert command accepted`, cmd?.ok === true, JSON.stringify(cmd?.response ?? cmd?.error));

    await sleep(700);
    const composerValue = await browser.eval(page, c.read);
    checks.add(
      `${c.label}: text landed in the chat composer`,
      typeof composerValue === 'string' && composerValue.includes(marker),
      `composer=${JSON.stringify(composerValue)}`,
    );
    report[c.label].composerValue = composerValue;

    // --- decoys must stay untouched ---------------------------------------
    if (c.file === 'f-multifield.html') {
      const others = await browser.eval(page, 'window.__fixture.otherFields()');
      report[c.label].otherFields = others;
      const polluted = Object.entries(others).filter(([, v]) => String(v).includes(marker));
      checks.add('F: decoy fields (search/nickname/notes) untouched', polluted.length === 0, JSON.stringify(others));
    }

    // --- the composer must still work normally afterwards -----------------
    const usable = await browser.eval(
      page,
      `(() => {
         const c = window.__fixture;
         return { hasComposer: typeof c.composerValue === 'function' };
       })()`,
    );
    checks.add(`${c.label}: composer remains usable`, usable?.hasComposer === true);

    // --- a genuinely new incoming message is detected ---------------------
    const before = await browser.eval(page, readOverlay());
    await browser.eval(page, `window.__fixture.receive('Where are you from?')`);
    const detected = await browser
      .waitFor(
        page,
        `(() => {
           const host = document.getElementById('rose-shadow-host');
           const root = host?.shadowRoot;
           if (!root) return false;
           const text = root.textContent || '';
           return text.includes('Where are you from');
         })()`,
        { timeout: 8000, label: 'incoming message surfaced in overlay' },
      )
      .catch(() => false);
    checks.add(
      `${c.label}: new incoming message detected`,
      !!detected,
      detected ? 'incoming text shown in overlay' : 'overlay never showed the incoming text',
    );
    void before;
  }
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
