/**
 * Shared helpers for the browser validation phases.
 *
 * Everything here talks to the *real* extension through the *real* browser APIs:
 * `chrome.storage` in the service-worker context, `chrome.runtime.sendMessage`
 * from content scripts, and DOM assertions in the page. Nothing is stubbed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../cdp.mjs';

export { sleep };

/** Fixed extension id so storage written in one phase is readable in the next. */
export const EXT_ID = process.env.ROSE_EXT_ID ?? 'mhkfljdcmandohmddjfolcdpbhbdimjf';

export const FIXTURE_ORIGIN = 'http://127.0.0.1:8788';
export const AI_BASE_URL = `${FIXTURE_ORIGIN}/v1`;

export function fixtureUrl(name) {
  return `${FIXTURE_ORIGIN}/${name}`;
}

/** Reads the mock provider's recorded requests. */
export async function aiRequests() {
  const res = await fetch(`${FIXTURE_ORIGIN}/__control/requests`);
  const { requests } = await res.json();
  return requests;
}

export async function resetAi() {
  await fetch(`${FIXTURE_ORIGIN}/__control/reset`);
}

export async function setAiBehaviour(params) {
  const qs = new URLSearchParams(params).toString();
  await fetch(`${FIXTURE_ORIGIN}/__control/behaviour?${qs}`);
}

/**
 * Evaluates an expression inside the extension's service worker.
 * This is how settings are written: through the same storage module ROSE uses.
 */
export async function evalInWorker(browser, expression) {
  const sw = await browser.waitForServiceWorker();
  const session = await browser.attach(sw);
  const value = await browser.eval(session, expression);
  return value;
}

/**
 * Configures ROSE to talk to the local mock provider.
 *
 * Writes through the real `chrome.storage.local` in the extension context, which
 * is also what triggers ROSE's own `storage.onChanged` cache refresh — so this
 * exercises the genuine settings path rather than a test back door.
 */
export async function configureRose(browser, overrides = {}) {
  const payload = JSON.stringify(overrides);
  return evalInWorker(
    browser,
    `(async () => {
       const KEY = 'rose:settings';
       const got = await chrome.storage.local.get([KEY]);
       const current = got[KEY] ?? {};
       const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
       const merge = (base, patch) => {
         if (!isObj(patch) || !isObj(base)) return patch === undefined ? base : patch;
         const out = { ...base };
         for (const [k, v] of Object.entries(patch)) {
           if (v === undefined) continue;
           out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
         }
         return out;
       };
       const next = merge(current, ${payload});
       await chrome.storage.local.set({ [KEY]: next });
       await new Promise((r) => setTimeout(r, 250));
       return { ok: true, ai: next.ai?.activeProvider, mode: next.automation?.mode };
     })()`,
  );
}

/** Stores an API key the way the Options page does (separate secrets namespace). */
export async function setApiKey(browser, providerId, key) {
  return evalInWorker(
    browser,
    `(async () => {
       const KEY = 'rose:secrets';
       const got = await chrome.storage.local.get([KEY]);
       const all = got[KEY] ?? {};
       all[${JSON.stringify(providerId)}] = ${JSON.stringify(key)};
       await chrome.storage.local.set({ [KEY]: all });
       await new Promise((r) => setTimeout(r, 200));
       return { ok: true };
     })()`,
  );
}

/** Waits until ROSE's overlay has mounted on the page. */
export async function waitForOverlay(browser, session, timeout = 25_000) {
  return browser.waitFor(session, `!!document.getElementById('rose-shadow-host')`, {
    timeout,
    label: "ROSE overlay (#rose-shadow-host)",
  });
}

/** Reads the overlay's rendered state out of its open shadow root. */
export function readOverlay() {
  return `(() => {
    const host = document.getElementById('rose-shadow-host');
    if (!host || !host.shadowRoot) return null;
    const root = host.shadowRoot;
    const text = (sel) => root.querySelector(sel)?.textContent?.trim() ?? null;
    const suggestions = Array.from(root.querySelectorAll('.suggestion')).map((b) => ({
      text: b.textContent.trim(),
      blocked: b.classList.contains('blocked'),
    }));
    const stopBtn = root.querySelector('.stop-btn');
    return {
      theme: host.dataset.theme ?? null,
      accent: host.dataset.accent ?? null,
      launcherState: root.querySelector('.launcher')?.dataset.state ?? null,
      statePill: root.querySelector('.pill')?.dataset.state ?? null,
      stopVisible: !!stopBtn && !stopBtn.closest('.stopbar')?.classList.contains('hidden'),
      stopLabel: stopBtn?.textContent?.trim() ?? null,
      stopDisabled: stopBtn?.disabled ?? null,
      statusNote: text('.status-note'),
      errorText: text('.card .incoming.empty'),
      suggestionCount: suggestions.length,
      suggestions,
      hasGenerateButton: !!Array.from(root.querySelectorAll('button')).find((b) => /Generate|Regenerate/.test(b.textContent)),
    };
  })()`;
}

/** Clicks a control inside the overlay shadow root by its visible label. */
export function clickOverlay(labelPattern) {
  return `(() => {
    const host = document.getElementById('rose-shadow-host');
    if (!host?.shadowRoot) return { ok: false, error: 'no overlay' };
    const re = new RegExp(${JSON.stringify(labelPattern)}, 'i');
    const btn = Array.from(host.shadowRoot.querySelectorAll('button'))
      .find((b) => re.test(b.textContent.trim()) && !b.disabled);
    if (!btn) return { ok: false, error: 'button not found: ' + ${JSON.stringify(labelPattern)} };
    btn.click();
    return { ok: true, clicked: btn.textContent.trim() };
  })()`;
}

/** Clicks the overlay's STOP button. */
export function clickStop() {
  return `(() => {
    const host = document.getElementById('rose-shadow-host');
    const btn = host?.shadowRoot?.querySelector('.stop-btn');
    if (!btn) return { ok: false, error: 'no stop button' };
    if (btn.disabled) return { ok: false, error: 'stop button disabled (already stopped)' };
    btn.click();
    return { ok: true };
  })()`;
}

/** Sets the automation mode through the overlay's mode buttons. */
export function clickMode(mode) {
  return `(() => {
    const host = document.getElementById('rose-shadow-host');
    const btn = host?.shadowRoot?.querySelector('button[data-mode="${mode}"]');
    if (!btn) return { ok: false, error: 'no mode button ' + ${JSON.stringify(mode)} };
    btn.click();
    return { ok: true, mode: btn.dataset.mode };
  })()`;
}

/**
 * Sends a message from the extension service worker to the content script in a
 * tab — the same path the popup uses. This is a real extension message, not a
 * simulated DOM event.
 */
export function sendCommandToTab(browser, tabId, command) {
  return evalInWorker(
    browser,
    `(async () => {
       const tabId = ${tabId};
       try {
         const res = await chrome.tabs.sendMessage(tabId, {
           type: 'rose/command',
           payload: ${JSON.stringify(command)},
         });
         return { ok: true, response: res };
       } catch (e) {
         return { ok: false, error: String(e && e.message || e) };
       }
     })()`,
  );
}

/** Reads persisted memory for one client straight out of chrome.storage. */
export function readMemory(clientId) {
  return `(async () => {
    const key = 'rose:memory:' + ${JSON.stringify(clientId)};
    const got = await chrome.storage.local.get([key]);
    return got[key] ?? null;
  })()`;
}

/** Lists every memory record ROSE has stored. */
export function readAllMemories() {
  return `(async () => {
    const all = await chrome.storage.local.get(null);
    const out = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('rose:memory:') && k !== 'rose:memory:__index__') out[k.replace('rose:memory:', '')] = v;
    }
    return out;
  })()`;
}

/** Clears ROSE's stored data so phases do not leak into each other. */
export function clearAllRoseData() {
  return `(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('rose:'));
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  })()`;
}

/** The tab id of a page session, needed for chrome.tabs.sendMessage. */
export async function tabIdOf(browser, session) {
  const info = await browser.cdp.send('Target.getTargetInfo', { targetId: session.targetInfo.targetId });
  const targetId = info.targetInfo.targetId;
  const id = await evalInWorker(
    browser,
    `(async () => {
       const tabs = await chrome.tabs.query({});
       return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title }));
     })()`,
  );
  void targetId;
  return id;
}

/**
 * Grants a host permission by writing it into a *persistent* test profile.
 *
 * Chrome's host-permission prompt is a native bubble that cannot be answered
 * from automation, so an end-to-end run on an arbitrary live site cannot click
 * through it. This seeds exactly what the prompt would have produced
 * (`explicit_host` in the extension's granted permissions) so the rest of the
 * flow — ROSE's own `enableSite` registration and injection — runs untouched.
 *
 * Requires `Browser.launch({ userDataDir })`, which closes gracefully so Chrome
 * flushes Preferences.
 */
export function seedHostPermission(profileDir, extensionId, origins) {
  const prefPath = path.join(profileDir, 'Default', 'Preferences');
  const raw = fs.readFileSync(prefPath, 'utf8');
  const prefs = JSON.parse(raw);
  const entry = prefs.extensions?.settings?.[extensionId];
  if (!entry) throw new Error(`extension ${extensionId} not present in ${prefPath}`);
  for (const key of ['granted_permissions', 'active_permissions']) {
    const perms = (entry[key] ??= {});
    const list = (perms.explicit_host ??= []);
    for (const origin of origins) if (!list.includes(origin)) list.push(origin);
  }
  fs.writeFileSync(prefPath, JSON.stringify(prefs));
  return origins;
}

/** Minimal assertion collector producing the phase report. */
export class Checks {
  constructor(phase) {
    this.phase = phase;
    this.items = [];
  }

  add(name, pass, detail = '') {
    this.items.push({ name, pass: !!pass, detail: String(detail) });
    const mark = pass ? 'PASS' : 'FAIL';
    process.stdout.write(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}\n`);
    return !!pass;
  }

  eq(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    return this.add(name, pass, pass ? `${JSON.stringify(actual)}` : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  get passed() {
    return this.items.filter((i) => i.pass).length;
  }

  get failed() {
    return this.items.filter((i) => !i.pass);
  }

  summary() {
    return `${this.phase}: ${this.passed}/${this.items.length} checks passed`;
  }
}
