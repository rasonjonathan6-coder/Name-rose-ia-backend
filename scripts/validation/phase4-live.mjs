/**
 * PHASE 4 — real platform validation.
 *
 * Runs ROSE against real, live sites in a real Chromium with the extension
 * loaded, and reports what actually happens per site. It deliberately does not
 * claim more than it observes: a marketing page with no chat UI is reported as
 * "no chat surface", not as a pass.
 *
 * What is genuinely exercised:
 *   - the content script is injected on the live origin (isolated world)
 *   - the floating overlay mounts on the live page
 *   - `PlatformDetector` picks an adapter and that adapter runs its heuristics
 *     against the site's real DOM
 *   - when an input is found, `adapter.insertText` writes into it and the value
 *     is read back — real injection, not a mock
 *
 * What cannot be automated, and is therefore reported rather than faked:
 *   - Chrome's host-permission prompt is a native bubble with no DOM and no
 *     window, so it cannot be clicked by CDP or xdotool. The grant is seeded
 *     into a persistent test profile (`seedHostPermission`), which reproduces
 *     exactly what the prompt would have written.
 *   - CooMeet/Flirtify chat requires an authenticated video session. Their
 *     public pages are marketing pages with no chat DOM.
 *
 *   node scripts/validation/phase4-live.mjs [url ...]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Browser, sleep } from '../cdp.mjs';
import { Checks, configureRose, clearAllRoseData, seedHostPermission, AI_BASE_URL } from './helpers.mjs';

const DEFAULT_SITES = [
  'https://web.libera.chat/',
  'https://flirtify.com/',
  'https://coomeet.com/',
];

const sites = process.argv.slice(2).filter((a) => /^https?:/.test(a));
const targets = sites.length ? sites : DEFAULT_SITES;

const PROFILE = path.join(os.tmpdir(), 'rose-phase4-profile');

/** Reads the adapter's view of the page and, if possible, injects text. */
const PROBE = `(async () => {
  const c = window.ROSE_IA?.controller;
  if (!c) return { controller: false };
  const desc = (n) => n ? n.tagName.toLowerCase()
    + (n.id ? '#' + n.id : '')
    + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')
    : null;
  const out = {
    controller: true,
    platform: c.adapter?.id ?? null,
    platformLabel: c.adapter?.label ?? null,
    container: desc(c.adapter.getMessageContainer(document)),
    input: desc(c.adapter.getInput(document)),
    sendButton: desc(c.adapter.getSendButton(document)),
    messageCount: 0,
    injection: null,
  };
  try { out.messageCount = c.adapter.getMessages(document).length; } catch { out.messageCount = -1; }

  const input = c.adapter.getInput(document);
  if (input) {
    const probe = 'ROSE-PHASE4-INJECTION-PROBE';
    let inserted = false;
    try { inserted = c.adapter.insertText(input, probe); } catch (e) { inserted = String(e && e.message || e); }
    await new Promise((r) => setTimeout(r, 150));
    const value = input.isContentEditable ? input.innerText : input.value;
    out.injection = { inserted, valueMatched: typeof value === 'string' && value.includes(probe) };
    // Leave the page as we found it.
    if (input.isContentEditable) input.innerText = '';
    else { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  return out;
})()`;

const checks = new Checks('PHASE 4 — live platforms');
const report = { sites: [], extensionId: null, profile: PROFILE };

try {
  fs.rmSync(PROFILE, { recursive: true, force: true });

  // First launch exists only to let Chrome create the profile and record the
  // extension id; `close()` shuts down gracefully so Preferences are flushed.
  {
    const b = await Browser.launch({ extensionDir: '/workspace/project/dist', userDataDir: PROFILE });
    const sw = await b.waitForServiceWorker(30_000);
    report.extensionId = sw.url.split('/')[2];
    await b.close();
  }

  const origins = targets.map((u) => `https://${new URL(u).hostname}/*`);
  seedHostPermission(PROFILE, report.extensionId, origins);
  checks.add(
    'seeded host permissions in persistent profile',
    true,
    `${origins.length} origin(s): ${origins.join(', ')}`,
  );

  for (const url of targets) {
    const host = new URL(url).hostname;
    const site = { url, host };
    process.stdout.write(`\n--- ${host} ---\n`);

    const browser = await Browser.launch({ extensionDir: '/workspace/project/dist', userDataDir: PROFILE });
    try {
      await browser.waitForServiceWorker(30_000);

      // Re-seed in case Chrome rewrote Preferences on the previous shutdown.
      seedHostPermission(PROFILE, report.extensionId, origins);

      await clearAllRoseData();
      await configureRose(browser, {
        ai: {
          acknowledgedPolicy: true,
          activeProvider: 'openai',
          providers: [{ id: 'openai', label: 'OpenAI', baseUrl: AI_BASE_URL, model: 'mock-model', enabled: true }],
        },
        automation: { mode: 'manual', globalEnabled: true },
        debug: { enabled: true, verbose: true, showOverlay: true },
      });

      const page = await browser.newPage(url);
      await sleep(5000);
      const base = host.replace(/^www\./, '');
      const readLocation = (s) =>
        browser.eval(s, `({ href: location.href, title: document.title })`).catch(() => ({}));
      const landed = (l) => !!l?.href && /^https?:/.test(l.href) && l.href.includes(base);

      let loc = await readLocation(page);
      // Some sites (CooMeet) end up with the real document in a different target
      // than the one `createTarget` handed back — a bot check or an internal
      // redirect replaces the tab. Re-attach to whichever live page target now
      // holds the site rather than evaluating against a dead about:blank.
      let active = page;
      if (!landed(loc)) {
        for (let i = 0; i < 10 && !landed(loc); i++) {
          const target = (await browser.targets()).find(
            (t) => t.type === 'page' && t.url.includes(base) && t.url !== 'about:blank',
          );
          if (target) {
            active = await browser.attach(target);
            await sleep(1500);
            loc = await readLocation(active);
            if (landed(loc)) {
              site.reattachedTo = target.url;
              break;
            }
          }
          await sleep(1500);
          loc = await readLocation(page);
        }
      }

      // A single reload settles sites that stay on about:blank on first hit.
      if (!landed(loc)) {
        await active.send('Page.reload', {}).catch(() => {});
        await sleep(6000);
        loc = await readLocation(active);
      }

      site.finalUrl = loc?.href ?? null;
      site.title = loc?.title ?? null;
      site.reachable = landed(loc);
      checks.add(`${host}: page loaded`, site.reachable, `${site.finalUrl} — "${site.title}"`);

      // Drive ROSE's own activation path the way the popup does. The RPC has to
      // come from an *extension page*: sending it from the page itself needs a
      // content script, which is exactly what activation is meant to create.
      // Seeding the permission reproduces what Chrome's native prompt would have
      // granted, so `activateSite` does its real post-grant work — register the
      // dynamic content script, then inject into the tab.
      const extPage = await browser.newPage('about:blank');
      await extPage.send('Page.navigate', { url: `chrome-extension://${report.extensionId}/options/options.html` });
      await sleep(2000);

      const staticMatches = await browser.eval(
        extPage,
        `(chrome.runtime.getManifest().content_scripts ?? []).flatMap((cs) => cs.matches ?? [])`,
      );
      site.staticCoverage = staticMatches.includes(`https://${host}/*`) || staticMatches.includes('https://*/*');
      const alreadyInjected = await browser
        .evalIsolated(active, `typeof chrome !== 'undefined' && !!chrome.runtime?.id`)
        .catch(() => false);

      site.activation = site.staticCoverage || alreadyInjected
        ? { skipped: site.staticCoverage ? 'covered by the manifest' : 'already injected' }
        : await browser.eval(
            extPage,
            `(async () => {
               try {
                 return await chrome.runtime.sendMessage({
                   type: 'rose/site/activate',
                   payload: { host: ${JSON.stringify(host)} },
                   requestId: 'phase4-' + Date.now(),
                 });
               } catch (e) { return { error: String(e && e.message || e) }; }
             })()`,
          ).catch((e) => ({ error: e.message }));
      process.stdout.write(`      activation: ${JSON.stringify(site.activation)}\n`);

      if (site.activation?.ok) {
        site.registeredScripts = await browser.eval(
          extPage,
          `(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({ id: s.id, matches: s.matches })))()`,
        );
        checks.add(
          `${host}: dynamic content script registered`,
          site.registeredScripts.some((s) => s.matches?.includes(`https://${host}/*`)),
          JSON.stringify(site.registeredScripts),
        );
        // A newly registered script only runs on the next document.
        await active.send('Page.reload', {}).catch(() => {});
        await sleep(6000);
      }

      const granted = await browser
        .waitForIsolated(active, `typeof chrome !== 'undefined' && !!chrome.runtime?.id`, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      site.contentScript = !!granted;
      checks.add(`${host}: content script injected`, site.contentScript, granted ? 'chrome.runtime present' : 'not present');

      if (site.contentScript) {
        site.overlay = await browser
          .waitFor(active, `!!document.getElementById('rose-shadow-host')`, { timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        checks.add(`${host}: floating overlay mounted`, site.overlay, site.overlay ? 'shadow host present' : 'missing');

        const probe = await browser.evalIsolated(active, PROBE).catch((e) => ({ error: e.message }));
        site.probe = probe;
        checks.add(
          `${host}: PlatformDetector resolved an adapter`,
          !!probe?.platform,
          `platform=${probe?.platform} (${probe?.platformLabel})`,
        );
        process.stdout.write(`      container=${probe?.container} input=${probe?.input} send=${probe?.sendButton} messages=${probe?.messageCount}\n`);

        // Injection is only meaningful where the site actually has an input.
        if (probe?.input) {
          site.injection = probe.injection;
          checks.add(
            `${host}: text injection into real input`,
            probe.injection?.valueMatched === true,
            JSON.stringify(probe.injection),
          );
        } else {
          // Not a failure: a page with no chat UI has no reply field to inject
          // into. ROSE must simply not claim to have found a conversation.
          checks.add(
            `${host}: no composer — ROSE reports no conversation`,
            probe?.messageCount === 0 && !probe?.container,
            `container=${probe?.container} messages=${probe?.messageCount}`,
          );
        }
      }
    } catch (err) {
      site.error = err.message;
      checks.add(`${host}: harness completed`, false, err.message);
    } finally {
      await browser.close();
    }
    report.sites.push(site);
  }

  checks.add('phase completed without harness error', true, '');
} catch (err) {
  checks.add('phase completed without harness error', false, err.message);
}

report.checks = checks.items;
report.summary = checks.summary();
fs.writeFileSync('/tmp/rose-phase4.json', JSON.stringify(report, null, 2));

process.stdout.write(`\n${checks.summary()}\n`);
for (const f of checks.failed) process.stdout.write(`  FAILED: ${f.name} — ${f.detail}\n`);
process.stdout.write(`full report: /tmp/rose-phase4.json\n`);

if (checks.failed.length) process.exitCode = 1;
