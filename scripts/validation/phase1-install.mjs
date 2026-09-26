/**
 * Phase 1 — extension installation and surface availability.
 *
 * Verifies the things that can only be checked in a real browser: that the MV3
 * bundle loads, the service worker registers, the manifest declares the expected
 * permissions, chrome.storage works, and the popup/options/sidepanel/dashboard
 * pages actually render without console errors.
 */

import { Browser, sleep } from '../cdp.mjs';
import {
  Checks,
  EXT_ID,
  AI_BASE_URL,
  FIXTURE_ORIGIN,
  fixtureUrl,
  configureRose,
  setApiKey,
  evalInWorker,
  waitForOverlay,
  readOverlay,
  clearAllRoseData,
} from './helpers.mjs';

const extensionDir = process.argv[2] ?? '/workspace/project/dist';
const checks = new Checks('PHASE 1 — install & surfaces');
const results = {};

const browser = await Browser.launch({ extensionDir });

try {
  // --- service worker ------------------------------------------------------
  const sw = await browser.waitForServiceWorker(30_000);
  checks.add('MV3 service worker registered', !!sw, sw.url);
  results.extensionId = sw.url.split('/')[2];

  // --- manifest / permissions ---------------------------------------------
  const manifest = await evalInWorker(browser, `chrome.runtime.getManifest()`);
  checks.add('manifest version 3', manifest.manifest_version === 3, `manifest_version=${manifest.manifest_version}`);
  checks.add('extension name is ROSE IA', /ROSE IA/.test(manifest.name), manifest.name);
  results.permissions = manifest.permissions;

  const expectedPerms = ['storage', 'scripting', 'tabs', 'notifications', 'alarms', 'permissions'];
  const missing = expectedPerms.filter((p) => !manifest.permissions.includes(p));
  checks.add('declares required permissions', missing.length === 0, `missing: ${missing.join(', ') || 'none'}`);
  checks.add(
    'no dangerous permissions (no <all_urls> in host_permissions)',
    !(manifest.host_permissions ?? []).includes('<all_urls>'),
    (manifest.host_permissions ?? []).join(', '),
  );
  checks.add(
    'optional host permissions present (generic adapter path)',
    (manifest.optional_host_permissions ?? []).length > 0,
    (manifest.optional_host_permissions ?? []).join(', '),
  );
  results.csp = manifest.content_security_policy?.extension_pages ?? null;

  // --- storage -------------------------------------------------------------
  const storageRoundTrip = await evalInWorker(
    browser,
    `(async () => {
       await chrome.storage.local.set({ 'rose:validation-probe': { n: 42 } });
       const got = await chrome.storage.local.get(['rose:validation-probe']);
       await chrome.storage.local.remove(['rose:validation-probe']);
       return got['rose:validation-probe']?.n ?? null;
     })()`,
  );
  checks.add('chrome.storage.local round-trips', storageRoundTrip === 42, `read back ${storageRoundTrip}`);

  // --- settings persistence through the real path --------------------------
  await clearAllRoseData();
  const configured = await configureRose(browser, {
    ai: { activeProvider: 'openai', providers: [{ id: 'openai', baseUrl: AI_BASE_URL, apiKey: '', model: 'mock-model' }] },
    automation: { mode: 'manual' },
  });
  checks.add('settings written through chrome.storage', configured?.ok === true, JSON.stringify(configured));

  const reread = await evalInWorker(
    browser,
    `(async () => {
       const got = await chrome.storage.local.get(['rose:settings']);
       const s = got['rose:settings'];
       return { provider: s?.ai?.activeProvider, baseUrl: s?.ai?.providers?.find((p) => p.id === 'openai')?.baseUrl };
     })()`,
  );
  checks.add('settings readable after write', reread.provider === 'openai', JSON.stringify(reread));
  checks.add('custom base URL persisted', reread.baseUrl === AI_BASE_URL, reread.baseUrl);

  // --- API key is stored separately from settings --------------------------
  await setApiKey(browser, 'openai', 'validation-key-not-real');
  const keyIsolation = await evalInWorker(
    browser,
    `(async () => {
       const all = await chrome.storage.local.get(null);
       const settings = all['rose:settings'];
       const secrets = all['rose:secrets'];
       const settingsStr = JSON.stringify(settings);
       return {
         hasSecretsKey: !!secrets,
         secretStored: secrets?.openai === 'validation-key-not-real',
         keyLeakedIntoSettings: settingsStr.includes('validation-key-not-real'),
       };
     })()`,
  );
  checks.add('API key stored in the secrets namespace', keyIsolation.secretStored === true, JSON.stringify(keyIsolation));
  checks.add(
    'API key does NOT leak into the settings object',
    keyIsolation.keyLeakedIntoSettings === false,
    keyIsolation.keyLeakedIntoSettings ? 'KEY PRESENT IN SETTINGS' : 'settings are clean',
  );

  // --- content script injection on a matching origin -----------------------
  const page = await browser.newPage(fixtureUrl('a-textarea.html'));
  // Evaluated in the isolated world: `chrome.runtime` is not exposed to the
  // page's own world, so checking there always reports false.
  const injected = await browser.waitForIsolated(
    page,
    `typeof globalThis.chrome !== 'undefined' && !!chrome.runtime?.id`,
    { timeout: 25_000, label: 'content script on http://127.0.0.1' },
  );
  checks.add('content script injected on matching origin', !!injected, 'chrome.runtime available in page');
  results.contentScriptInjected = !!injected;

  // --- floating UI ---------------------------------------------------------
  await waitForOverlay(browser, page, 25_000);
  const overlay = await browser.eval(page, readOverlay());
  checks.add('floating overlay mounted (shadow DOM)', !!overlay, JSON.stringify(overlay));
  checks.add('overlay uses dark theme', overlay?.theme === 'dark', `theme=${overlay?.theme}`);
  checks.add('overlay has a STOP control', overlay?.stopLabel != null, `label=${overlay?.stopLabel}`);
  results.overlay = overlay;

  // --- extension pages -----------------------------------------------------
  const pagesToCheck = [
    ['popup', `chrome-extension://${results.extensionId}/popup/popup.html`],
    ['options', `chrome-extension://${results.extensionId}/options/options.html`],
    ['sidepanel', `chrome-extension://${results.extensionId}/sidepanel/sidepanel.html`],
    ['dashboard', `chrome-extension://${results.extensionId}/dashboard/dashboard.html`],
  ];

  for (const [label, url] of pagesToCheck) {
    // Attach first, then navigate: an exception thrown during page bootstrap is
    // otherwise invisible because the listener is installed too late.
    const session = await browser.newPage('about:blank');
    const errors = [];
    browser.cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
      if (sessionId !== session.sessionId) return;
      const d = params.exceptionDetails ?? {};
      const detail = d.exception?.description ?? d.exception?.value ?? d.text ?? 'exception';
      errors.push(String(detail).split('\n').slice(0, 3).join(' / '));
    });
    await session.send('Page.navigate', { url });
    await sleep(1800);
    const state = await browser.eval(
      session,
      `({ title: document.title, bodyLen: document.body?.innerText?.trim().length ?? 0, hasRoot: !!document.querySelector('#app, .app, main, body > *') })`,
    );
    const ok = state.bodyLen > 0;
    checks.add(`${label} page renders content`, ok, `title="${state.title}" textLen=${state.bodyLen}`);
    checks.add(`${label} page has no uncaught exceptions`, errors.length === 0, errors.join(' | ') || 'clean');
  }

  results.checks = checks.items;
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
