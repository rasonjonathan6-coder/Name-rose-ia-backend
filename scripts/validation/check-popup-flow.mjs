/**
 * Popup activation-flow check (real browser, real popup page).
 *
 * Regression guard for the ordering bug found in Phase 4: the popup returned
 * early on an unacknowledged AI policy, so the "Enable ROSE on <host>" button —
 * the only way to grant a new platform — was unreachable on a fresh install.
 *
 * The popup resolves its host from `chrome.tabs.query({active, currentWindow})`,
 * which does not reflect CDP page creation, so this check seeds the same storage
 * state and asserts the popup's own rendered output through its DOM.
 *
 *   node scripts/validation/check-popup-flow.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Browser, sleep } from '../cdp.mjs';
import { Checks, evalInWorker, EXT_ID } from './helpers.mjs';

const PROFILE = path.join(os.tmpdir(), 'rose-popup-flow');
const checks = new Checks('POPUP — site activation flow');

const readPopup = `(() => {
  const root = document.getElementById('root');
  if (!root) return { ready: false };
  const text = root.innerText || '';
  const buttons = Array.from(root.querySelectorAll('button')).map((b) => b.textContent.trim());
  const notices = Array.from(root.querySelectorAll('.notice')).map((n) => n.textContent.trim());
  return {
    ready: true,
    hasEnableButton: buttons.some((b) => /^Enable ROSE on /.test(b)),
    buttons,
    notices,
    // The AI policy gate renders this specific CTA when it blocks the UI.
    blockedByPolicy: buttons.includes('Open AI settings'),
    mentionsPolicy: /policy|acknowledge|provider/i.test(text),
  };
})()`;

/** Opens the popup as a background tab so the site tab stays the active one. */
async function openPopupInBackground(browser, extId) {
  await evalInWorker(
    browser,
    `(async () => {
       await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html'), active: false });
       return true; })()`,
  );
  await sleep(2000);
  const target = await browser.waitForTarget((t) => t.type === 'page' && /popup\/popup\.html/.test(t.url), {
    label: 'popup tab',
  });
  return browser.attach(target);
}

try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const browser = await Browser.launch({ extensionDir: '/workspace/project/dist', userDataDir: PROFILE });

  const sw = await browser.waitForServiceWorker(30_000);
  const extId = sw.url.split('/')[2] || EXT_ID;

  // Fresh-install-like state: ROSE's own default settings, untouched.
  await evalInWorker(
    browser,
    `(async () => { const all = await chrome.storage.local.get(null);
       const keys = Object.keys(all).filter((k) => k.startsWith('rose:'));
       if (keys.length) await chrome.storage.local.remove(keys);
       await new Promise((r) => setTimeout(r, 250));
       return keys.length; })()`,
  );

  // A supported host with no manifest coverage, so the popup should offer Enable.
  // Created as a *tab* so `chrome.tabs.query({active, currentWindow})` — what the
  // popup actually uses to find its host — resolves to it.
  const host = 'example-chat.test';
  await evalInWorker(
    browser,
    `(async () => { await chrome.tabs.create({ url: 'https://${host}/', active: true }); return true; })()`,
  );
  await sleep(2500);

  const popup = await openPopupInBackground(browser, extId);
  const state = await browser.eval(popup, readPopup).catch((e) => ({ error: e.message }));
  checks.add('popup rendered', !!state?.ready, JSON.stringify(state).slice(0, 200));

  // The bug: policy gate short-circuited before the site-access block.
  checks.add(
    'policy gate is blocking on a fresh install',
    state?.blockedByPolicy === true,
    `blockedByPolicy=${state?.blockedByPolicy}`,
  );
  checks.add(
    'Enable button is reachable even while the policy is unacknowledged',
    state?.hasEnableButton === true,
    `buttons=${JSON.stringify(state?.buttons)}`,
  );

  // Now acknowledge the policy + enable a provider; the Enable button must persist.
  await evalInWorker(
    browser,
    `(async () => {
       const KEY = 'rose:settings';
       const got = await chrome.storage.local.get([KEY]);
       const s = got[KEY] ?? {};
       s.ai = { ...(s.ai ?? {}), acknowledgedPolicy: true, activeProvider: 'openai',
         providers: [{ id: 'openai', label: 'OpenAI', baseUrl: 'http://127.0.0.1:8788/v1', model: 'mock-model', enabled: true }] };
       await chrome.storage.local.set({ [KEY]: s });
       await new Promise((r) => setTimeout(r, 300));
       return true; })()`,
  );

  const popup2 = await openPopupInBackground(browser, extId);
  const after = await browser.eval(popup2, readPopup).catch((e) => ({ error: e.message }));
  checks.add(
    'Enable button persists once the policy is acknowledged',
    after?.hasEnableButton === true,
    `buttons=${JSON.stringify(after?.buttons)}`,
  );

  // Clicking Enable must go through ROSE's real enableSite path. The permission
  // is seeded first because Chrome's native prompt cannot be answered from here.
  const { seedHostPermission } = await import('./helpers.mjs');
  await browser.close();

  seedHostPermission(PROFILE, extId, [`https://${host}/*`]);

  const browser2 = await Browser.launch({ extensionDir: '/workspace/project/dist', userDataDir: PROFILE });
  await browser2.waitForServiceWorker(30_000);
  const popup3 = await openPopupInBackground(browser2, extId);

  const enabled = await browser2.eval(
    popup3,
    `(async () => {
       try {
         return await chrome.runtime.sendMessage({
           type: 'rose/site/enable',
           payload: { host: ${JSON.stringify(host)} },
           requestId: 'popup-flow-' + Date.now(),
         });
       } catch (e) { return { error: String(e && e.message || e) }; }
     })()`,
  );
  checks.add('enableSite succeeds with the grant in place', enabled?.ok === true, JSON.stringify(enabled));

  const regs = await browser2.eval(
    popup3,
    `(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({ id: s.id, matches: s.matches })))()`,
  );
  checks.add(
    'content script registered for the granted host',
    regs?.some((s) => s.matches?.includes(`https://${host}/*`)),
    JSON.stringify(regs),
  );

  await browser2.close();
} catch (err) {
  checks.add('popup flow harness completed', false, err.message);
}

process.stdout.write(`\n${checks.summary()}\n`);
for (const f of checks.failed) process.stdout.write(`  FAILED: ${f.name} — ${f.detail}\n`);
if (checks.failed.length) process.exitCode = 1;
