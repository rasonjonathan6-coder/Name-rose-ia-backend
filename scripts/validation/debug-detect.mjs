/**
 * Diagnoses what ROSE detects on a fixture, by observing the overlay and the
 * DOM effects. Used while investigating per-fixture detection failures.
 *
 * Usage: node scripts/validation/debug-detect.mjs <fixture.html>
 */

import { Browser, sleep } from '../cdp.mjs';
import { fixtureUrl, configureRose, setApiKey, evalInWorker, waitForOverlay, readOverlay, clearAllRoseData } from './helpers.mjs';

const file = process.argv[2] ?? 'c-input.html';
const browser = await Browser.launch({ extensionDir: '/workspace/project/dist' });

try {
  await browser.waitForServiceWorker(30_000);
  await clearAllRoseData();
  await configureRose(browser, {
    ai: { activeProvider: 'openai', providers: [{ id: 'openai', baseUrl: 'http://127.0.0.1:8788/v1', model: 'mock-model' }] },
    automation: { mode: 'manual', globalEnabled: true },
    debug: { enabled: true, verbose: true, showOverlay: true },
  });
  await setApiKey(browser, 'openai', 'validation-key-not-real');

  const page = await browser.newPage(fixtureUrl(file));
  await sleep(3000);
  await waitForOverlay(browser, page, 20_000);

  console.log('=== overlay state ===');
  console.log(JSON.stringify(await browser.eval(page, readOverlay()), null, 2));

  console.log('\n=== candidate inputs (generic scoring, observed from the page) ===');
  const candidates = await browser.eval(
    page,
    `(() => {
       const out = [];
       const push = (el) => {
         if (!el) return;
         const r = el.getBoundingClientRect();
         out.push({
           tag: el.tagName,
           type: el.getAttribute('type'),
           id: el.id || null,
           placeholder: el.getAttribute('placeholder'),
           ariaLabel: el.getAttribute('aria-label'),
           role: el.getAttribute('role'),
           contenteditable: el.getAttribute('contenteditable'),
           rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
           visible: !!(r.width && r.height),
         });
       };
       document.querySelectorAll('textarea').forEach(push);
       document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])').forEach(push);
       document.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach(push);
       document.querySelectorAll('[role="textbox"]').forEach(push);
       return out;
     })()`,
  );
  console.log(JSON.stringify(candidates, null, 2));

  console.log('\n=== DOM after 3s (what a MutationObserver would have seen) ===');
  const logHtml = await browser.eval(page, `document.getElementById('log')?.outerHTML?.slice(0, 600) ?? 'no #log'`);
  console.log(logHtml);

  console.log('\n=== fixture messages ===');
  console.log('incoming:', JSON.stringify(await browser.eval(page, 'window.__fixture.incoming()')));

  console.log('\n=== overlay text ===');
  const text = await browser.eval(
    page,
    `document.getElementById('rose-shadow-host')?.shadowRoot?.textContent?.replace(/\\s+/g,' ').slice(0, 500) ?? null`,
  );
  console.log(text);

  console.log('\n=== ROSE logs (from the content script isolated world) ===');
  const logs = await browser
    .evalIsolated(
      page,
      `(() => {
         if (!window.ROSE_IA) return { error: 'ROSE_IA not exposed' };
         return {
           version: window.ROSE_IA.version,
           logs: window.ROSE_IA.logs().map((l) => [l.scope, l.message].join(' | ')),
         };
       })()`,
    )
    .catch((e) => ({ evalError: e.message }));
  console.log(JSON.stringify(logs, null, 2));

  console.log('\n=== ROSE controller view ===');
  const controller = await browser
    .evalIsolated(
      page,
      `(() => {
         const c = window.ROSE_IA?.controller;
         if (!c) return { error: 'no controller' };
         const adapter = c.adapter ?? null;
         const input = adapter?.getInput?.(document) ?? null;
         const messages = adapter?.getMessages?.(document) ?? [];
         return {
           platform: c.report?.platform ?? null,
           confidence: c.report?.confidence ?? null,
           adapterLabel: adapter?.label ?? null,
           conversation: c.conversation ?? null,
           input: input ? {
             tag: input.tagName,
             id: input.id || null,
             placeholder: input.getAttribute('placeholder'),
           } : null,
           messageCount: messages.length,
           messages: messages.slice(0, 5),
         };
       })()`,
    )
    .catch((e) => ({ evalError: e.message }));
  console.log(JSON.stringify(controller, null, 2));
} finally {
  await browser.close();
}
