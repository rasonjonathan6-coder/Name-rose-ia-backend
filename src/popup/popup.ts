/**
 * Popup — the compact control surface.
 *
 * Shows what ROSE sees on the current tab, lets the operator change mode and
 * hit STOP, and provides quick access to the full surfaces. It deliberately
 * does not duplicate the overlay: the popup is for when the overlay is closed.
 */

import type { AutomationMode, RoseSettings } from '@/shared/types';
import { MSG } from '@/shared/types';
import { rpc } from '@/shared/rpc';
import * as storage from '@/storage';
import { canUseAI } from '@/core/safety/policy';
import { summarise } from '@/core/stats/recorder';
import { STATE_LABELS } from '@/core/automation/state-machine';
import {
  applyTheme,
  formatCost,
  formatNumber,
  getActiveTab,
  h,
  hostOf,
  installStyles,
  isSupportedUrl,
  toast,
} from '@/ui/dom';

let settings: RoseSettings;
let tab: chrome.tabs.Tab | null = null;

async function init(): Promise<void> {
  installStyles();
  settings = await storage.loadSettings();
  applyTheme(settings);
  tab = await getActiveTab();
  await render();
}

async function render(): Promise<void> {
  const root = document.getElementById('root')!;
  root.innerHTML = '';

  const supported = isSupportedUrl(tab?.url);
  const host = hostOf(tab?.url) || 'no page';

  // --- header ---
  const header = h('div', { class: 'row between', style: 'margin-bottom:12px;' });
  header.appendChild(
    h('div', { class: 'row', style: 'gap:9px;' },
      h('span', {
        class: 'mark',
        style:
          'width:30px;height:30px;border-radius:10px;background:linear-gradient(135deg,var(--violet),var(--rose));display:grid;place-items:center;font-weight:800;color:#fff;',
        text: 'R',
      }),
      h('div', {}, h('div', { style: 'font-weight:800;font-size:14px;', text: 'ROSE IA' }), h('div', { style: 'font-size:10px;color:var(--text-faint);', text: host })),
    ),
  );
  const gear = h('button', { class: 'btn sm ghost', text: '⚙', title: 'Settings' });
  gear.addEventListener('click', () => openPage('options/options.html'));
  header.appendChild(gear);
  root.appendChild(header);

  // --- site access ---
  // Checked before the AI policy gate on purpose: granting ROSE access to a host
  // is what makes the extension run there at all, and it has nothing to do with
  // AI configuration. When this lived in the `else if` below, an unacknowledged
  // policy returned early and the Enable button was unreachable — a fresh install
  // could never turn ROSE on for a new platform.
  if (supported && !(await hasHostPermission(host))) {
    // The generic adapter can run anywhere, but the manifest cannot pre-declare
    // every origin. Ask the browser for this one host on demand.
    root.appendChild(
      h('div', { class: 'notice' },
        h('span', { class: 'ico', text: '🔓' }),
        h('span', { text: `ROSE is not enabled on ${host} yet. Grant access once and it will run here from now on.` }),
      ),
    );
    const enable = h('button', { class: 'btn primary', text: `Enable ROSE on ${host}`, style: 'width:100%;margin-bottom:10px;' });
    enable.addEventListener('click', async () => {
      enable.disabled = true;
      const res = await rpc(MSG.ENABLE_SITE, { host });
      if (res.ok) {
        toast(`ROSE enabled on ${host}. Reloading the tab…`, 'success');
        if (tab?.id) void globalThis.chrome?.tabs.reload(tab.id);
      } else {
        enable.disabled = false;
        toast(res.error ?? 'Could not enable ROSE on this site.', 'error');
      }
    });
    root.appendChild(enable);
  }

  // --- policy gate ---
  if (!canUseAI(settings).allowed) {
    const warn = h('div', { class: 'notice warn' });
    warn.appendChild(h('span', { class: 'ico', text: '⚠' }));
    warn.appendChild(h('span', { html: escapeText(canUseAI(settings).reason ?? '') }));
    root.appendChild(warn);
    const fix = h('button', { class: 'btn primary', text: 'Open AI settings', style: 'width:100%;' });
    fix.addEventListener('click', () => openPage('options/options.html'));
    root.appendChild(fix);
    root.appendChild(await buildFooter());
    return;
  }

  // --- page status ---
  if (!supported) {
    root.appendChild(
      h('div', { class: 'notice' },
        h('span', { class: 'ico', text: 'ℹ' }),
        h('span', { text: 'ROSE does not run on this page. Open a supported chat platform, or the local demo, to use the assistant.' }),
      ),
    );
    const demo = h('button', { class: 'btn', text: 'Open the local demo page', style: 'width:100%;margin-bottom:10px;' });
    demo.addEventListener('click', () => {
      const g = globalThis as unknown as { chrome?: typeof chrome };
      const url = g.chrome?.runtime?.getURL?.('demo/demo.html');
      if (url) void g.chrome?.tabs?.create?.({ url });
    });
    root.appendChild(demo);
  }

  // --- mode selector ---
  const modeCard = h('div', { class: 'card' });
  modeCard.appendChild(h('h3', { text: 'Mode', style: 'margin-bottom:8px;' }));
  const modeRow = h('div', { class: 'row', style: 'gap:5px;' });
  for (const m of [
    { id: 'manual' as AutomationMode, label: 'Manual' },
    { id: 'assisted' as AutomationMode, label: 'Assisted' },
    { id: 'auto' as AutomationMode, label: 'Auto' },
  ]) {
    const btn = h('button', {
      class: `btn sm ${settings.automation.mode === m.id ? 'primary' : ''}`,
      text: m.label,
      style: 'flex:1;',
    });
    btn.addEventListener('click', async () => {
      if (m.id === 'auto' && !window.confirm('Enable AUTO mode? ROSE will insert and send replies automatically after the configured delay. The STOP button always takes back control.')) return;
      settings = await storage.patchSettings({ automation: { ...settings.automation, mode: m.id } });
      await sendToTab({ action: 'set-mode', mode: m.id });
      toast(`Mode: ${m.label}`, 'success');
      await render();
    });
    modeRow.appendChild(btn);
  }
  modeCard.appendChild(modeRow);
  modeCard.appendChild(
    h('div', { style: 'font-size:10.5px;color:var(--text-faint);margin-top:7px;', text: STATE_LABELS[settings.automation.globalPaused ? 'paused' : 'idle'] + (settings.automation.globalPaused ? ' — automation halted' : '') }),
  );
  root.appendChild(modeCard);

  // --- master controls ---
  const controlCard = h('div', { class: 'card' });
  const controlRow = h('div', { class: 'row', style: 'gap:6px;' });

  const pauseBtn = h('button', { class: 'btn sm', text: settings.automation.globalPaused ? '▶ Resume' : '⏸ Pause', style: 'flex:1;' });
  pauseBtn.addEventListener('click', async () => {
    settings = await storage.patchSettings({ automation: { ...settings.automation, globalPaused: !settings.automation.globalPaused } });
    toast(settings.automation.globalPaused ? 'ROSE paused.' : 'ROSE resumed.', 'success');
    await render();
  });
  controlRow.appendChild(pauseBtn);

  const stopBtn = h('button', { class: 'btn sm danger', text: '⏹ STOP', style: 'flex:1;' });
  stopBtn.addEventListener('click', async () => {
    await sendToTab({ action: 'stop-all' });
    settings = await storage.patchSettings({ automation: { ...settings.automation, globalPaused: true } });
    toast('STOP engaged.', 'error');
    await render();
  });
  controlRow.appendChild(stopBtn);
  controlCard.appendChild(controlRow);

  const rescanBtn = h('button', { class: 'btn sm', text: '↻ Rescan page', style: 'width:100%;margin-top:6px;' });
  rescanBtn.addEventListener('click', async () => {
    const res = await sendToTab({ action: 'rescan' });
    toast(res ? 'Rescanning…' : 'No ROSE instance on this tab.', res ? 'success' : 'error');
  });
  controlCard.appendChild(rescanBtn);
  root.appendChild(controlCard);

  // --- quick stats ---
  const statsCard = h('div', { class: 'card' });
  statsCard.appendChild(h('h3', { text: 'Today', style: 'margin-bottom:8px;' }));
  const today = await storage.getStats();
  const grid = h('div', { class: 'grid two', style: 'gap:8px;' });
  grid.appendChild(miniStat('Conversations', formatNumber(today.conversations)));
  grid.appendChild(miniStat('Received', formatNumber(today.messagesReceived)));
  grid.appendChild(miniStat('Generated', formatNumber(today.responsesGenerated)));
  grid.appendChild(miniStat('Sent', formatNumber(today.responsesSent)));
  statsCard.appendChild(grid);
  statsCard.appendChild(
    h('div', { style: 'font-size:10.5px;color:var(--text-faint);margin-top:8px;', text: `${formatNumber(today.tokensPrompt + today.tokensCompletion)} tokens · ${formatCost(today.costUsd)} estimated` }),
  );
  root.appendChild(statsCard);

  // --- quick links ---
  const links = h('div', { class: 'row', style: 'gap:6px;margin-top:4px;' });
  const dash = h('button', { class: 'btn sm', text: '📊 Dashboard', style: 'flex:1;' });
  dash.addEventListener('click', () => openPage('dashboard/dashboard.html'));
  links.appendChild(dash);
  const side = h('button', { class: 'btn sm', text: '📌 Side panel', style: 'flex:1;' });
  side.addEventListener('click', async () => {
    const g = globalThis as unknown as { chrome?: typeof chrome };
    try {
      await g.chrome?.sidePanel?.open?.({ windowId: tab?.windowId ?? g.chrome.windows.WINDOW_ID_CURRENT });
      window.close();
    } catch {
      toast('Side panel is not available in this browser.', 'error');
    }
  });
  links.appendChild(side);
  root.appendChild(links);

  root.appendChild(await buildFooter());
}

async function buildFooter(): Promise<HTMLElement> {
  const stats = await storage.getStatsRange(7);
  const agg = summarise(stats);
  const footer = h('div', { style: 'font-size:10px;color:var(--text-faint);text-align:center;margin-top:10px;line-height:1.7;' });
  footer.appendChild(h('div', { text: `7-day: ${formatNumber(agg.responsesGenerated)} replies · ${formatNumber(agg.tokens)} tokens · ${formatCost(agg.costUsd)}` }));
  footer.appendChild(
    h('div', { text: 'ROSE assists a human operator and never bypasses platform rules.' }),
  );
  return footer;
}

function miniStat(k: string, v: string): HTMLElement {
  const box = h('div', { style: 'background:var(--surface-2);border-radius:9px;padding:7px 9px;' });
  box.appendChild(h('div', { style: 'font-size:9.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim);font-weight:700;', text: k }));
  box.appendChild(h('div', { style: 'font-size:17px;font-weight:800;font-variant-numeric:tabular-nums;', text: v }));
  return box;
}

/**
 * True when ROSE already holds host permission for this hostname, either from
 * the static manifest list or a previous runtime grant.
 */
async function hasHostPermission(host: string): Promise<boolean> {
  const g = globalThis as unknown as { chrome?: typeof chrome };
  if (!host || !g.chrome?.permissions?.contains) return true; // cannot tell → do not nag
  try {
    return await g.chrome.permissions.contains({
      origins: [`https://${host}/*`, `http://${host}/*`],
    });
  } catch {
    return true;
  }
}

/** Sends a command to the content script on the active tab. */
async function sendToTab(payload: unknown): Promise<boolean> {
  const g = globalThis as unknown as { chrome?: typeof chrome };
  if (!tab?.id) return false;
  try {
    await g.chrome!.tabs.sendMessage(tab.id, { type: MSG.COMMAND, payload });
    return true;
  } catch {
    return false;
  }
}

function openPage(path: string): void {
  const g = globalThis as unknown as { chrome?: typeof chrome };
  const url = g.chrome?.runtime?.getURL?.(path);
  if (url) void g.chrome?.tabs?.create?.({ url });
  window.close();
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

void init();
