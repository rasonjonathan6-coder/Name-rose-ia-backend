/**
 * Live-site probe — what does ROSE actually resolve on a real page?
 *
 * Read-only reconnaissance: loads a real URL in a real browser with the built
 * extension, activates the site through ROSE's own runtime host-permission path
 * (the same one the popup's "activate this site" button uses), then reports what
 * the generic adapter resolved — container, input, send button, and the messages
 * it detected with author/direction/timestamp separated.
 *
 * It never inserts or sends anything. Use it to decide whether a platform is
 * worth writing an adapter for, and to capture the DOM shapes for one.
 *
 *   node scripts/validation/probe-live-site.mjs https://example.com/chat
 *   node scripts/validation/probe-live-site.mjs <url> --wait 12000 --shot out.png
 */

import fs from 'node:fs';
import { Browser, sleep } from '../cdp.mjs';
import { configureRose, setApiKey, evalInWorker, clearAllRoseData } from './helpers.mjs';

const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/validation/probe-live-site.mjs <url> [--wait ms] [--shot file.png]');
  process.exit(2);
}
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const waitMs = Number(argOf('--wait', 12_000));
const shotPath = argOf('--shot', null);

const host = new URL(url).hostname;
const extensionDir = argOf('--dist', '/workspace/project/dist');

const browser = await Browser.launch({ extensionDir });
const out = { url, host, steps: [] };
const step = (name, value) => {
  out.steps.push({ name, value });
  console.log(`\n### ${name}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
};
/**
 * A probe that aborts on the first hiccup tells you nothing about the rest of
 * the page. Each step is guarded so one failure still leaves a usable report.
 */
const guard = async (name, fn) => {
  try {
    return await fn();
  } catch (err) {
    step(name, { error: err.message });
    return undefined;
  }
};

try {
  const sw = await browser.waitForServiceWorker(30_000);
  out.extensionId = sw.url.split('/')[2];
  step('service worker', { registered: true, extensionId: out.extensionId });

  await clearAllRoseData();
  await configureRose(browser, {
    ai: { activeProvider: 'openai', providers: [{ id: 'openai', baseUrl: 'http://127.0.0.1:8788/v1', model: 'mock-model' }] },
    automation: { mode: 'manual', globalEnabled: true },
    debug: { enabled: true, verbose: true, showOverlay: true },
  });
  await setApiKey(browser, 'openai', 'probe-key-not-real');

  const page = await browser.newPage(url);
  await sleep(1500);
  out.finalUrl = await guard('eval location.href', () => browser.eval(page, 'location.href'));
  out.title = await guard('eval document.title', () => browser.eval(page, 'document.title'));
  step('page', { finalUrl: out.finalUrl, title: out.title });

  // Activate the site exactly as the popup does: request the runtime host
  // permission, register a dynamic content script, inject into the open tab.
  const activation = await guard('runtime site activation', () =>
    evalInWorker(
    browser,
    `(async () => {
       const origin = 'https://${host}/*';
       try {
         const granted = await chrome.permissions.request({ origins: [origin] });
         if (!granted) return { ok: false, error: 'permission denied by the user/browser' };
       } catch (e) {
         return { ok: false, error: 'permission request threw: ' + String(e && e.message || e) };
       }
       const tabs = await chrome.tabs.query({});
       const tab = tabs.find((t) => (t.url || '').includes(${JSON.stringify(host)}));
       if (!tab) return { ok: false, error: 'no tab for host', tabs: tabs.map((t) => t.url) };
       try {
         await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
       } catch (e) {
         return { ok: false, error: 'inject failed: ' + String(e && e.message || e), tabId: tab.id };
       }
       return { ok: true, tabId: tab.id, origin };
     })()`,
    ),
  );
  step('runtime site activation', activation);

  const injected = await browser
    .waitForIsolated(page, `typeof chrome !== 'undefined' && !!chrome.runtime?.id`, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  step('content script present', injected);

  await sleep(waitMs);

  if (injected) {
    const overlay = await browser
      .waitFor(page, `!!document.getElementById('rose-shadow-host')`, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    step('overlay mounted', overlay);

    const resolved = await browser
      .evalIsolated(
        page,
        `(() => {
           const c = window.ROSE_IA?.controller;
           if (!c) return { error: 'ROSE_IA.controller missing' };
           const desc = (n) => n ? n.tagName.toLowerCase()
             + (n.id ? '#' + n.id : '')
             + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).slice(0,3).join('.') : '') : null;
           const el = c.adapter.getMessageContainer(document);
           const input = c.adapter.getInput(document);
           const send = c.adapter.getSendButton(document);
           let messages = [];
           try { messages = c.adapter.getMessages(document); } catch (e) { messages = [{ error: String(e.message) }]; }
           return {
             platform: c.adapter?.id ?? null,
             platformLabel: c.adapter?.label ?? null,
             container: desc(el),
             input: desc(input),
             inputTag: input ? input.tagName.toLowerCase() : null,
             inputContentEditable: input ? input.isContentEditable : null,
             sendButton: desc(send),
             messageCount: messages.length,
             messages: messages.slice(-12).map((m) => ({
               text: m.text,
               author: m.author ?? null,
               direction: m.direction ?? null,
               timestamp: m.timestamp ?? null,
             })),
           };
         })()`,
      )
      .catch((e) => ({ error: e.message }));
    step('adapter resolution', resolved);

    // What the page actually offers, so an adapter can be written against it.
    const dom = await browser.eval(
      page,
      `(() => {
         const vis = (n) => {
           const s = getComputedStyle(n);
           const r = n.getBoundingClientRect();
           return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
         };
         const desc = (n) => n.tagName.toLowerCase()
           + (n.id ? '#' + n.id : '')
           + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).slice(0,3).join('.') : '');
         const textareas = Array.from(document.querySelectorAll('textarea')).filter(vis);
         const editables = Array.from(document.querySelectorAll('[contenteditable="true"],[contenteditable=""]')).filter(vis);
         const inputs = Array.from(document.querySelectorAll('input')).filter(vis);
         const roles = Array.from(document.querySelectorAll('[role]')).filter(vis)
           .map((n) => n.getAttribute('role')).filter((r) => /log|list|textbox|feed|main/i.test(r));
         return {
           textareas: textareas.map((n) => ({ el: desc(n), placeholder: n.placeholder, aria: n.getAttribute('aria-label') })),
           contentEditables: editables.map((n) => ({ el: desc(n), aria: n.getAttribute('aria-label') })),
           inputs: inputs.slice(0, 12).map((n) => ({ el: desc(n), type: n.type, placeholder: n.placeholder, aria: n.getAttribute('aria-label') })),
           ariaRoles: roles,
           frames: Array.from(document.querySelectorAll('iframe')).length,
           bodyTextSample: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
         };
       })()`,
    );
    step('page DOM inventory', dom);
  }

  if (shotPath) {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath, Buffer.from(data, 'base64'));
    step('screenshot', shotPath);
  }
} catch (err) {
  step('harness error', err.message + '\n' + (err.stack ?? ''));
} finally {
  await browser.close();
}
