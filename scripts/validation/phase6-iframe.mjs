/**
 * Phase 6 — the cross-origin iframe shape, end to end in a real browser.
 *
 * Fixture G reproduces the structure found on CooMeet: a shell page with no chat
 * of its own, and the conversation served from a different origin inside a child
 * frame. The shell is on 127.0.0.1:8788 and the frame on 127.0.0.1:8789, so the
 * browser genuinely treats them as separate origins and the parent cannot reach
 * into the frame — only the service worker can bridge them.
 *
 * What this phase has to prove, and why each check exists:
 *
 *   * the chat is detected inside the child frame at all (the original bug: with
 *     the content script only in the top frame, ROSE saw no composer);
 *   * exactly ONE panel per tab, and it is in the top frame — a panel inside the
 *     iframe would be clipped to the iframe and could not be dragged over the
 *     rest of the window, which is a stated requirement;
 *   * the panel in the top frame shows the *chat frame's* state, which means the
 *     mirror bridge works, not just that two frames both ran;
 *   * the panel never writes into the shell's decoy search field, and insertion
 *     lands in the chat frame's composer.
 *
 * Assertions are made from observable effects — what the DOM contains, where
 * text landed — never from ROSE's internals.
 */

import { Browser, sleep } from '../cdp.mjs';
import {
  Checks,
  configureRose,
  setApiKey,
  waitForOverlay,
  readOverlay,
  clearAllRoseData,
  clickOverlay,
} from './helpers.mjs';

const extensionDir = process.argv[2] ?? '/workspace/project/dist';
const checks = new Checks('PHASE 6 — cross-origin iframe (CooMeet shape)');
const report = {};

const SHELL_URL = 'http://127.0.0.1:8788/g-iframe-shell.html';
const CHAT_FRAME = /127\.0\.0\.1:8789/;

const browser = await Browser.launch({ extensionDir });

try {
  await browser.waitForServiceWorker(30_000);
  await clearAllRoseData();
  await configureRose(browser, {
    ai: {
      activeProvider: 'openai',
      providers: [{ id: 'openai', baseUrl: 'http://127.0.0.1:8788/v1', model: 'mock-model', enabled: true }],
      acknowledgedPolicy: true,
    },
    // Generate is blocked while the machine is stopped, and the master switch
    // defaults to off. Turning it on here is what makes the panel's Generate
    // control a fair test of the mirror bridge rather than of the safety gate.
    automation: { mode: 'manual', globalEnabled: true, globalPaused: false },
    debug: { enabled: true, verbose: true, showOverlay: true },
  });
  await setApiKey(browser, 'openai', 'validation-key-not-real');
  await fetch('http://127.0.0.1:8788/__control/reset');

  const page = await browser.newPage(SHELL_URL);
  await browser.waitForLoad(page);

  // The frame needs a moment to load and for its content script to run.
  const frameReady = await browser
    .waitFor(page, `!!document.getElementById('chat-frame')`, { timeout: 15_000, label: 'chat iframe' })
    .catch(() => false);
  checks.add('the shell embeds a chat iframe', !!frameReady);

  // --- detection inside the child frame ------------------------------------
  // The chat frame exposes its own harness; reaching it needs a frame context
  // because the parent cannot touch it.
  let chatSeen = false;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !chatSeen) {
    const ctx = page.frameContext(CHAT_FRAME);
    if (ctx !== undefined) {
      const ok = await browser
        .eval(page, `!!(window.__fixture && window.__fixture.incoming().length)`, { contextId: ctx })
        .catch(() => false);
      if (ok) chatSeen = true;
    }
    if (!chatSeen) await sleep(300);
  }
  checks.add('the chat frame is a distinct origin and exposes its conversation', chatSeen, chatSeen ? 'reached via CDP frame context' : 'frame context never became reachable');

  // --- exactly one panel, in the top frame ---------------------------------
  const mounted = await waitForOverlay(browser, page, 25_000).catch(() => false);
  checks.add('the panel mounts in the top frame', !!mounted);

  const shellPanels = await browser.eval(page, `document.querySelectorAll('#rose-shadow-host').length`);
  report.shellPanels = shellPanels;
  checks.add('exactly one panel in the top frame', shellPanels === 1, `${shellPanels} host(s)`);

  // A panel inside the iframe is the failure this design exists to prevent: it
  // would be clipped to the iframe's box.
  let panelsInFrame = 0;
  const frameCtx = page.frameContext(CHAT_FRAME);
  if (frameCtx !== undefined) {
    panelsInFrame = await browser
      .eval(page, `document.querySelectorAll('#rose-shadow-host').length`, { contextId: frameCtx })
      .catch(() => -1);
  }
  report.panelsInFrame = panelsInFrame;
  checks.add('no panel is mounted inside the iframe (it would be clipped)', panelsInFrame === 0, `${panelsInFrame} host(s) in the frame`);

  // --- the mirror carries the chat frame's state ---------------------------
  // The top frame has no chat, so anything it displays about a conversation can
  // only have come across the mirror bridge. The fixture names the partner
  // "Anna" in the *chat frame*, so a top-frame panel showing "Anna" proves the
  // identity travelled; "Unknown"/"Connecting…" means it did not.
  //
  // The panel mounts before the first snapshot arrives, so this waits rather
  // than reading once: a single read races the bridge and fails spuriously.
  const named = await browser
    .waitFor(page, `(${readOverlay()})?.conversationName === 'Anna'`, {
      timeout: 20_000,
      label: 'mirrored conversation name',
    })
    .catch(() => false);
  const overlay = await browser.eval(page, readOverlay()).catch(() => null);
  report.overlay = overlay;
  checks.add(
    'the top-frame panel is populated from the chat frame',
    !!named && overlay?.conversationName === 'Anna',
    `conversationName=${overlay?.conversationName ?? 'n/a'} (header="${overlay?.headerSub ?? 'n/a'}")`,
  );

  // --- a new message in the chat frame reaches the top-frame panel ---------
  // This is the end-to-end path the operator depends on: a client writes in the
  // embedded chat, and the floating panel on the shell page shows it.
  if (frameCtx !== undefined) {
    await browser
      .eval(page, `window.__fixture.receive('Where are you from?')`, { contextId: frameCtx })
      .catch(() => null);
  }
  const seenInPanel = await browser
    .waitFor(
      page,
      `(() => {
         const root = document.getElementById('rose-shadow-host')?.shadowRoot;
         return !!root && (root.textContent || '').includes('Where are you from');
       })()`,
      { timeout: 20_000, label: 'incoming message mirrored into the top-frame panel' },
    )
    .catch(() => false);
  checks.add(
    'a new chat-frame message is mirrored into the top-frame panel',
    !!seenInPanel,
    seenInPanel ? 'incoming text shown in the shell panel' : 'panel never showed the incoming text',
  );

  // --- the shell's decoy field is never touched ----------------------------
  const decoyBefore = await browser.eval(page, `document.getElementById('shell-search').value`);

  // --- operator action in the top-frame panel reaches the chat frame -------
  // Clicking Generate in the top frame can only work if the intent is forwarded
  // to the frame that owns the chat and has the AI plumbing.
  const clicked = await browser.eval(page, clickOverlay('Generate|Regenerate')).catch(() => null);
  report.clicked = clicked;
  checks.add('the top-frame panel has a working Generate control', clicked?.ok === true, clicked?.error ?? clicked?.clicked ?? '');

  // Wait for suggestions to appear in the mirrored panel.
  let suggestions = [];
  const sDeadline = Date.now() + 30_000;
  while (Date.now() < sDeadline && suggestions.length === 0) {
    const o = await browser.eval(page, readOverlay()).catch(() => null);
    suggestions = o?.suggestions ?? [];
    if (suggestions.length === 0) await sleep(400);
  }
  report.suggestions = suggestions;
  checks.add(
    'generation triggered from the top frame produces suggestions',
    suggestions.length > 0,
    suggestions.length ? `${suggestions.length} suggestion(s)` : 'none appeared',
  );

  const decoyAfter = await browser.eval(page, `document.getElementById('shell-search').value`);
  report.decoy = { before: decoyBefore, after: decoyAfter };
  checks.add('the shell decoy field is never written to', decoyBefore === decoyAfter && !decoyAfter, `"${decoyAfter}"`);

  // --- insertion lands in the chat frame's composer ------------------------
  // Selecting a suggestion then Inserting must write into the frame's composer,
  // not into the shell.
  //
  // Wait for the panel to leave the busy state first: every action button is
  // disabled while a generation is in flight, so clicking Insert right after
  // Regenerate would hit a disabled control and prove nothing.
  const idle = await browser
    .waitFor(page, `(${readOverlay()})?.statePill === 'ready'`, {
      timeout: 30_000,
      label: 'panel ready for an action',
    })
    .catch(() => false);
  checks.add('the panel leaves the busy state once replies are ready', !!idle, idle ? 'state=ready' : 'still busy');

  const chatCtxNow = page.frameContext(CHAT_FRAME);
  if (chatCtxNow !== undefined && suggestions.length > 0) {
    const inserted = await browser.eval(page, clickOverlay('Insert')).catch(() => null);
    report.insertClick = inserted;
    let composer = '';
    const cDeadline = Date.now() + 15_000;
    while (Date.now() < cDeadline && !composer) {
      composer = await browser
        .eval(page, `window.__fixture.composerValue()`, { contextId: chatCtxNow })
        .catch(() => '');
      if (!composer) await sleep(300);
    }
    report.composerAfterInsert = composer;
    checks.add(
      'insertion from the top-frame panel lands in the chat frame composer',
      !!composer && composer.length > 0,
      composer ? `"${composer.slice(0, 60)}"` : `composer still empty (click=${JSON.stringify(inserted)})`,
    );
  } else {
    checks.add('insertion from the top-frame panel lands in the chat frame composer', false, 'frame context unavailable');
  }

  // --- teardown: the panel follows the chat frame out ----------------------
  // Removing the frame must not leave a panel showing a conversation that no
  // longer exists.
  await browser.eval(page, `document.getElementById('chat-frame').remove()`);
  let gone = false;
  const gDeadline = Date.now() + 15_000;
  while (Date.now() < gDeadline && !gone) {
    const n = await browser.eval(page, `document.querySelectorAll('#rose-shadow-host').length`).catch(() => -1);
    if (n === 0) gone = true;
    else await sleep(300);
  }
  checks.add('the panel is removed when the chat frame disappears', gone, gone ? 'panel unmounted' : 'panel still present');
} catch (err) {
  checks.add('phase completed without harness error', false, err.message);
} finally {
  await browser.close();
}

process.stdout.write(`\n${checks.summary()}\n`);
for (const f of checks.failed) process.stdout.write(`  FAILED: ${f.name} — ${f.detail}\n`);
process.stdout.write(`\nfull report: /tmp/rose-phase6.json\n`);
import fs from 'node:fs';
fs.writeFileSync('/tmp/rose-phase6.json', JSON.stringify(report, null, 2));
process.exit(checks.failed.length ? 1 : 0);
