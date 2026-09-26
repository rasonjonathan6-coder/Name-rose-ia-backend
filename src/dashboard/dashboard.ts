/**
 * Dashboard — statistics and conversation management.
 *
 * Everything shown here is derived from locally recorded counters and stored
 * memory records. There is no invented revenue data: the dashboard has no
 * earnings module because ROSE cannot legitimately read a platform's payout
 * figures, and showing a fabricated number would be worse than showing none.
 * The AI cost meter is the only monetary figure, and it is computed from real
 * token usage against published list prices.
 */

import type { ClientMemory, ConversationStatus, RoseSettings } from '@/shared/types';
import { MSG } from '@/shared/types';
import { rpc } from '@/shared/rpc';
import * as storage from '@/storage';
import { summarise } from '@/core/stats/recorder';
import { hasKnownPricing } from '@/core/ai/router';
import { flagFor } from '@/core/translation/language';
import { canUseAI } from '@/core/safety/policy';
import {
  applyTheme,
  escapeHtml,
  formatCost,
  formatMs,
  formatNumber,
  h,
  installStyles,
  relativeTime,
  toast,
} from '@/ui/dom';

let settings: RoseSettings;
let activeSection = 'overview';
let memories: ClientMemory[] = [];

async function init(): Promise<void> {
  installStyles();
  settings = await storage.loadSettings();
  applyTheme(settings);
  memories = await storage.listMemories();

  document.querySelectorAll<HTMLElement>('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeSection = btn.dataset.section ?? 'overview';
      document.querySelectorAll('.nav-item').forEach((b) => b.setAttribute('aria-current', String(b === btn)));
      void render();
    });
  });

  await render();
  // Live-ish refresh: the dashboard is usually open beside the chat.
  setInterval(() => {
    if (activeSection === 'overview' || activeSection === 'activity') void refresh();
  }, 15_000);
}

async function refresh(): Promise<void> {
  memories = await storage.listMemories();
  await render();
}

async function render(): Promise<void> {
  const main = document.getElementById('main')!;
  main.innerHTML = '';
  const renderers: Record<string, () => Promise<HTMLElement> | HTMLElement> = {
    overview: renderOverview,
    conversations: renderConversations,
    costs: renderCosts,
    activity: renderActivity,
    system: renderSystem,
  };
  main.appendChild(await (renderers[activeSection] ?? renderOverview)());
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

async function renderOverview(): Promise<HTMLElement> {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Overview' }));

  const today = await storage.getStats();
  const week = summarise(await storage.getStatsRange(7));

  wrap.appendChild(
    h('p', { class: 'hint', text: `Today, ${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}.` }),
  );

  // Today's headline numbers.
  const grid = h('div', { class: 'grid three' });
  grid.appendChild(statBox('Conversations today', formatNumber(today.conversations), 'distinct clients seen'));
  grid.appendChild(statBox('Messages received', formatNumber(today.messagesReceived), 'incoming client messages'));
  grid.appendChild(statBox('Replies generated', formatNumber(today.responsesGenerated), 'AI generations requested'));
  grid.appendChild(statBox('Replies sent', formatNumber(today.responsesSent), 'confirmed sends'));
  grid.appendChild(
    statBox(
      'Average response time',
      formatMs(today.responsesGenerated > 0 ? Math.round(today.totalResponseMs / today.responsesGenerated) : 0),
      'generation latency',
    ),
  );
  grid.appendChild(statBox('Tokens today', formatNumber(today.tokensPrompt + today.tokensCompletion), `${formatNumber(today.requests)} AI requests`));
  wrap.appendChild(grid);

  // Conversation status breakdown — computed from stored records.
  const statusCard = h('div', { class: 'card' });
  statusCard.appendChild(h('h2', { text: 'Conversations by status' }));
  const counts = countStatuses(memories, settings.automation.inactivityMinutes);
  const statusGrid = h('div', { class: 'grid' , style: 'grid-template-columns:repeat(auto-fit,minmax(120px,1fr));' });
  for (const [status, n] of Object.entries(counts)) {
    const box = h('div', { class: 'stat' });
    box.appendChild(h('div', { class: 'k', text: status }));
    box.appendChild(h('div', { class: 'v', text: String(n) }));
    statusGrid.appendChild(box);
  }
  statusCard.appendChild(statusGrid);
  wrap.appendChild(statusCard);

  // 7-day summary
  const weekCard = h('div', { class: 'card' });
  weekCard.appendChild(h('h2', { text: 'Last 7 days' }));
  const weekGrid = h('div', { class: 'grid three' });
  weekGrid.appendChild(statBox('Conversations', formatNumber(week.conversations)));
  weekGrid.appendChild(statBox('Messages', formatNumber(week.messagesReceived)));
  weekGrid.appendChild(statBox('Replies sent', formatNumber(week.responsesSent)));
  weekGrid.appendChild(statBox('Tokens', formatNumber(week.tokens)));
  weekGrid.appendChild(statBox('AI requests', formatNumber(week.requests)));
  weekGrid.appendChild(statBox('Estimated cost', formatCost(week.costUsd)));
  weekCard.appendChild(weekGrid);
  wrap.appendChild(weekCard);

  // Active conversations preview
  const active = memories
    .filter((m) => Date.now() - m.lastInteraction < settings.automation.inactivityMinutes * 60_000)
    .sort((a, b) => b.lastInteraction - a.lastInteraction)
    .slice(0, 6);

  const activeCard = h('div', { class: 'card' });
  activeCard.appendChild(h('h2', { text: 'Currently active' }));
  if (active.length === 0) {
    activeCard.appendChild(h('div', { class: 'empty', text: 'No conversations active in the last few minutes.' }));
  } else {
    activeCard.appendChild(buildConversationList(active));
  }
  wrap.appendChild(activeCard);

  return wrap;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

function renderConversations(): HTMLElement {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Conversations' }));
  wrap.appendChild(h('p', { class: 'hint', text: 'Every client ROSE has seen, newest first. Click one to inspect its memory. Records are strictly per-client.' }));

  const filterRow = h('div', { class: 'row wrap', style: 'gap:6px;margin-bottom:12px;' });
  let filter: ConversationStatus | 'all' = 'all';
  const statuses: Array<ConversationStatus | 'all'> = ['all', 'active', 'waiting', 'new', 'inactive'];

  const listWrap = h('div');

  const paint = () => {
    listWrap.innerHTML = '';
    const counts = countStatuses(memories, settings.automation.inactivityMinutes);
    const filtered = filter === 'all' ? memories : memories.filter((m) => deriveStatus(m, settings.automation.inactivityMinutes) === filter);

    if (filtered.length === 0) {
      listWrap.appendChild(h('div', { class: 'empty', text: memories.length === 0 ? 'No client records yet. ROSE creates one the first time it detects a conversation.' : `No conversations with status "${filter}".` }));
      return;
    }
    listWrap.appendChild(buildConversationList(filtered.sort((a, b) => b.lastInteraction - a.lastInteraction)));
  };

  for (const s of statuses) {
    const n = s === 'all' ? memories.length : countStatuses(memories, settings.automation.inactivityMinutes)[s];
    const btn = h('button', {
      class: `btn sm ${s === 'all' ? 'primary' : ''}`,
      text: `${s === 'all' ? 'All' : s} (${n})`,
    });
    btn.addEventListener('click', () => {
      filter = s;
      filterRow.querySelectorAll('button').forEach((b) => b.className = 'btn sm');
      btn.className = 'btn sm primary';
      paint();
    });
    filterRow.appendChild(btn);
  }

  wrap.appendChild(filterRow);
  wrap.appendChild(listWrap);
  paint();
  return wrap;
}

function buildConversationList(items: ClientMemory[]): HTMLElement {
  const list = h('div', { class: 'list' });

  for (const m of items) {
    const status = deriveStatus(m, settings.automation.inactivityMinutes);
    const item = h('div', { class: 'item', style: 'cursor:pointer;' });

    const avatar = h('div', { class: 'avatar' });
    avatar.textContent = (m.displayName || '?').slice(0, 1).toUpperCase();
    item.appendChild(avatar);

    const meta = h('div', { class: 'meta' });
    const nameRow = h('div', { class: 'n' });
    nameRow.appendChild(document.createTextNode(escapeHtml(m.displayName)));
    nameRow.appendChild(h('span', { class: `badge ${status}`, text: status }));
    nameRow.appendChild(h('span', { class: 'badge', text: m.platform }));
    if (m.language) nameRow.appendChild(h('span', { class: 'badge', text: flagFor(m.language) }));
    meta.appendChild(nameRow);

    const last = m.recentMessages[m.recentMessages.length - 1];
    meta.appendChild(
      h('div', { class: 'm', text: last ? `${last.role === 'client' ? '→ ' : '← '}${last.text}` : 'No messages recorded' }),
    );
    meta.appendChild(
      h('div', {
        class: 't',
        text: `${m.metadata.messageCount} messages · ${m.importantFacts.length} facts · ${relativeTime(m.lastInteraction)}`,
      }),
    );
    item.appendChild(meta);

    const del = h('button', { class: 'btn sm danger', text: '✕', title: 'Delete this client record' });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm(`Delete the memory record for ${m.displayName}? This cannot be undone.`)) return;
      await storage.deleteMemory(m.id);
      memories = await storage.listMemories();
      toast('Record deleted.', 'success');
      await render();
    });
    item.appendChild(del);

    item.addEventListener('click', () => showConversationDetail(m));
    list.appendChild(item);
  }

  return list;
}

/** Opens the ROSE context for a conversation in a modal. */
function showConversationDetail(m: ClientMemory): void {
  const overlay = h('div', {
    style:
      'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);display:grid;place-items:center;z-index:100;padding:24px;',
  });
  const panel = h('div', {
    style:
      'background:var(--bg-2);border:1px solid var(--outline);border-radius:16px;max-width:620px;width:100%;max-height:84vh;overflow-y:auto;padding:20px;box-shadow:var(--shadow);',
  });

  const head = h('div', { class: 'row between', style: 'margin-bottom:14px;' });
  head.appendChild(
    h('div', {},
      h('h2', { text: m.displayName }),
      h('div', { style: 'font-size:11px;color:var(--text-dim);', text: `${m.platform} · ${m.clientId}${m.language ? ` · ${flagFor(m.language)} ${m.language}` : ''}` }),
    ),
  );
  const close = h('button', { class: 'btn sm ghost', text: '✕' });
  close.addEventListener('click', () => overlay.remove());
  head.appendChild(close);
  panel.appendChild(head);

  panel.appendChild(
    h('div', { class: 'grid three', style: 'margin-bottom:14px;' },
      statBox('Messages', String(m.metadata.messageCount)),
      statBox('Facts', String(m.importantFacts.length)),
      statBox('Summaries', String(m.metadata.tokensSaved)),
    ),
  );

  if (m.summary) {
    panel.appendChild(h('h3', { text: 'Summary', style: 'margin-bottom:6px;' }));
    panel.appendChild(h('div', { class: 'card', style: 'font-size:12px;', text: m.summary }));
  }

  if (m.importantFacts.length) {
    panel.appendChild(h('h3', { text: 'Known facts', style: 'margin:14px 0 6px;' }));
    const table = h('table');
    for (const f of [...m.importantFacts].sort((a, b) => b.weight - a.weight)) {
      table.appendChild(
        h('tr', {}, h('td', { class: 'mono', text: f.key }), h('td', { text: f.value }), h('td', { class: 'mono', text: f.weight.toFixed(2) })),
      );
    }
    panel.appendChild(table);
  }

  if (m.topics.length) {
    panel.appendChild(h('h3', { text: 'Topics', style: 'margin:14px 0 6px;' }));
    panel.appendChild(h('div', { class: 'row wrap', style: 'gap:5px;' }, ...m.topics.map((t) => h('span', { class: 'badge', text: t }))));
  }

  panel.appendChild(h('h3', { text: 'Recent messages', style: 'margin:14px 0 6px;' }));
  const conv = h('div', { class: 'list' });
  for (const msg of m.recentMessages.slice(-20)) {
    conv.appendChild(
      h('div', { class: 'item', style: 'padding:7px 10px;' },
        h('span', { class: `badge ${msg.role === 'client' ? 'new' : 'active'}`, text: msg.role === 'client' ? 'Client' : 'Me' }),
        h('span', { style: 'flex:1;font-size:12px;', text: msg.text }),
        h('span', { class: 'mono', style: 'color:var(--text-faint);', text: relativeTime(msg.at) }),
      ),
    );
  }
  panel.appendChild(conv);

  const actions = h('div', { class: 'row', style: 'gap:6px;margin-top:16px;' });
  const clearCache = h('button', { class: 'btn sm', text: 'Clear cached replies' });
  clearCache.addEventListener('click', () => toast('Cache entries for this conversation will expire within 2 minutes.', 'info'));
  actions.appendChild(clearCache);

  const del = h('button', { class: 'btn sm danger', text: 'Delete record' });
  del.addEventListener('click', async () => {
    if (!window.confirm(`Delete the memory record for ${m.displayName}?`)) return;
    await storage.deleteMemory(m.id);
    memories = await storage.listMemories();
    overlay.remove();
    toast('Record deleted.', 'success');
    await render();
  });
  actions.appendChild(del);
  panel.appendChild(actions);

  overlay.appendChild(panel);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

async function renderCosts(): Promise<HTMLElement> {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'AI costs' }));
  wrap.appendChild(
    h('p', { class: 'hint', text: 'Computed from the token counts your provider reports, against published list prices. When a model\'s price is unknown, the cost stays at zero rather than being guessed.' }),
  );

  const stats = await storage.getStatsRange(30);
  const agg = summarise(stats);
  const provider = settings.ai.providers.find((p) => p.id === settings.ai.activeProvider);

  const grid = h('div', { class: 'grid three' });
  grid.appendChild(statBox('Estimated cost (30d)', formatCost(agg.costUsd), provider && hasKnownPricing(provider.model) ? 'from published list prices' : 'pricing unknown — not estimated'));
  grid.appendChild(statBox('AI requests', formatNumber(agg.requests)));
  grid.appendChild(statBox('Total tokens', formatNumber(agg.tokens)));
  wrap.appendChild(grid);

  // Optimisation levers, with the real effect of each.
  const levers = h('div', { class: 'card' });
  levers.appendChild(h('h2', { text: 'How ROSE keeps costs down' }));
  const rows: Array<[string, string]> = [
    ['Local trivial-message handling', 'Greetings, emojis and one-word replies are answered from a local template — zero tokens. This is usually the largest saving.'],
    ['Model routing', `Simple messages use the fast model (${provider?.fastModel ?? 'n/a'}); only complex ones use ${provider?.model ?? 'the main model'}.`],
    ['Response cache', 'Regenerating the same message for the same client within 2 minutes returns the cached reply with no request.'],
    ['In-flight coalescing', 'Concurrent triggers for the same message share a single API call instead of firing duplicates.'],
    ['Bounded context window', `${settings.memory.maxRecentMessages} verbatim messages, everything older compressed into a summary.`],
    ['Rolling summaries', `A cheap model compresses history every ${settings.memory.autoSummarizeAfter} messages, so prompt size stops growing.`],
    ['Low-content dampener', 'After four consecutive one-word messages, ROSE stops generating for that conversation.'],
  ];
  const table = h('table');
  for (const [k, v] of rows) table.appendChild(h('tr', {}, h('td', { style: 'font-weight:700;white-space:nowrap;', text: k }), h('td', { style: 'color:var(--text-dim);', text: v })));
  levers.appendChild(table);
  wrap.appendChild(levers);

  // Per-day table
  const daily = h('div', { class: 'card' });
  daily.appendChild(h('h2', { text: 'Daily breakdown' }));
  if (stats.length === 0) {
    daily.appendChild(h('div', { class: 'empty', text: 'No usage recorded yet.' }));
  } else {
    const t = h('table');
    t.appendChild(h('thead', {}, h('tr', {}, h('th', { text: 'Date' }), h('th', { text: 'Requests' }), h('th', { text: 'Tokens' }), h('th', { text: 'Cost' }))));
    const tb = h('tbody');
    for (const d of [...stats].reverse()) {
      tb.appendChild(
        h('tr', {},
          h('td', { text: d.date }),
          h('td', { text: formatNumber(d.requests) }),
          h('td', { text: formatNumber(d.tokensPrompt + d.tokensCompletion) }),
          h('td', { text: formatCost(d.costUsd) }),
        ),
      );
    }
    t.appendChild(tb);
    daily.appendChild(t);
  }
  wrap.appendChild(daily);

  return wrap;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

async function renderActivity(): Promise<HTMLElement> {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Activity' }));
  wrap.appendChild(h('p', { class: 'hint', text: 'Replies generated per day over the last two weeks.' }));

  const stats = await storage.getStatsRange(14);
  const byDate = new Map(stats.map((s) => [s.date, s]));

  // Fill gaps so the chart shows real calendar days, not just days with data.
  const days: Array<{ date: string; generated: number; received: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const s = byDate.get(key);
    days.push({ date: key, generated: s?.responsesGenerated ?? 0, received: s?.messagesReceived ?? 0 });
  }

  const max = Math.max(1, ...days.map((d) => d.generated));

  const card = h('div', { class: 'card' });
  card.appendChild(h('h2', { text: 'Replies generated' }));
  const chart = h('div', { class: 'chart' });
  for (const d of days) {
    const bar = h('div', { class: 'bar', style: `height:${Math.max(3, (d.generated / max) * 100)}%;` });
    bar.appendChild(h('span', { class: 'tip', text: `${d.date}: ${d.generated} replies, ${d.received} received` }));
    chart.appendChild(bar);
  }
  card.appendChild(chart);
  const labels = h('div', { class: 'chart-labels' });
  for (const d of days) labels.appendChild(h('span', { text: d.date.slice(5) }));
  card.appendChild(labels);
  wrap.appendChild(card);

  const total = days.reduce((a, d) => a + d.generated, 0);
  const best = days.reduce((a, d) => (d.generated > a.generated ? d : a), days[0]!);
  const grid = h('div', { class: 'grid three' });
  grid.appendChild(statBox('Total (14d)', formatNumber(total)));
  grid.appendChild(statBox('Best day', formatNumber(best.generated), best.date));
  grid.appendChild(statBox('Daily average', formatNumber(Math.round(total / 14))));
  wrap.appendChild(grid);

  return wrap;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

async function renderSystem(): Promise<HTMLElement> {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'System' }));
  wrap.appendChild(h('p', { class: 'hint', text: 'Health of the extension and the modules ROSE depends on.' }));

  const ping = await rpc(MSG.PING, undefined);
  const policy = canUseAI(settings);
  const provider = settings.ai.providers.find((p) => p.id === settings.ai.activeProvider);

  const rows: Array<[string, string, 'ok' | 'bad' | 'warn']> = [
    ['Background service worker', ping.ok ? `running (v${(ping.data as { version?: string })?.version ?? '?'})` : ping.error ?? 'unreachable', ping.ok ? 'ok' : 'bad'],
    ['Manifest', 'V3 — Chrome 110+ / Edge 110+', 'ok'],
    ['AI policy', settings.ai.acknowledgedPolicy ? 'acknowledged' : 'not acknowledged — AI disabled', settings.ai.acknowledgedPolicy ? 'ok' : 'bad'],
    ['Active provider', provider ? `${provider.label} (${provider.model})` : 'none', provider ? 'ok' : 'bad'],
    ['Automation mode', settings.automation.mode, settings.automation.mode === 'auto' ? 'warn' : 'ok'],
    ['Automation enabled', settings.automation.globalEnabled ? 'yes' : 'no', settings.automation.globalEnabled ? 'warn' : 'ok'],
    ['Globally paused', settings.automation.globalPaused ? 'yes' : 'no', 'ok'],
    ['Client memory', settings.memory.enabled ? `${memories.length} records` : 'disabled', 'ok'],
    ['Translation', settings.translation.enabled ? `enabled, target ${settings.translation.myLanguage}` : 'disabled', 'ok'],
    ['Live call assist', settings.liveCall.enabled ? 'enabled' : 'disabled', 'ok'],
    ['Custom site configs', settings.platforms?.length ? `${settings.platforms.length} configured` : 'none', 'ok'],
  ];

  const card = h('div', { class: 'card' });
  const table = h('table');
  for (const [k, v, level] of rows) {
    table.appendChild(
      h('tr', {}, h('td', { style: 'font-weight:700;', text: k }), h('td', { class: 'mono', text: v }), h('td', {}, h('span', { class: `badge ${level === 'ok' ? 'active' : level === 'warn' ? 'waiting' : 'error'}`, text: level }))),
    );
  }
  card.appendChild(table);
  wrap.appendChild(card);

  if (!policy.allowed) {
    const warn = h('div', { class: 'notice warn' });
    warn.appendChild(h('span', { class: 'ico', text: '⚠' }));
    warn.appendChild(h('span', { text: policy.reason ?? 'AI is not available.' }));
    wrap.appendChild(warn);
  }

  const honesty = h('div', { class: 'card' });
  honesty.appendChild(h('h2', { text: 'What ROSE does not do' }));
  honesty.appendChild(
    h('ul', { style: 'padding-left:18px;font-size:12px;color:var(--text-dim);line-height:1.9;' },
      h('li', { text: 'No earnings or revenue figures. ROSE cannot legitimately read a platform\'s payout data, so it shows none rather than inventing one.' }),
      h('li', { text: 'No remote audio capture. Live assist uses your microphone through the browser\'s Web Speech API; it never taps the WebRTC stream.' }),
      h('li', { text: 'No password access, no credential scraping, no bypassing platform protections.' }),
      h('li', { text: 'No cloud sync. All data stays in this browser profile.' }),
    ),
  );
  wrap.appendChild(honesty);

  return wrap;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveStatus(m: ClientMemory, inactivityMinutes: number): ConversationStatus {
  const silenceMinutes = (Date.now() - m.lastInteraction) / 60_000;
  if (m.metadata.messageCount === 0) return 'new';
  if (silenceMinutes >= inactivityMinutes) return 'inactive';
  const last = m.recentMessages[m.recentMessages.length - 1];
  if (last?.role === 'client') return 'waiting';
  return 'active';
}

function countStatuses(list: ClientMemory[], inactivityMinutes: number): Record<ConversationStatus, number> {
  const counts: Record<ConversationStatus, number> = { active: 0, waiting: 0, new: 0, inactive: 0 };
  for (const m of list) counts[deriveStatus(m, inactivityMinutes)]++;
  return counts;
}

function statBox(k: string, v: string, sub?: string): HTMLElement {
  const box = h('div', { class: 'stat accent' });
  box.appendChild(h('div', { class: 'k', text: k }));
  box.appendChild(h('div', { class: 'v', text: v }));
  if (sub) box.appendChild(h('div', { class: 'sub', text: sub }));
  return box;
}

void init();
