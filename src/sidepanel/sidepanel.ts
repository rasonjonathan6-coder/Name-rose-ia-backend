/**
 * Side panel — a persistent view of the active conversation's ROSE context.
 *
 * The side panel survives navigation within a tab, which makes it the right
 * place to watch memory grow and to inspect what ROSE knows, without covering
 * the chat the way a modal overlay would.
 */

import type { ClientMemory, RoseSettings } from '@/shared/types';
import { MSG } from '@/shared/types';
import * as storage from '@/storage';
import { detectLanguage, flagFor } from '@/core/translation/language';
import { applyTheme, h, installStyles, relativeTime, toast } from '@/ui/dom';

let settings: RoseSettings;
let memories: ClientMemory[] = [];
let selected: string | null = null;

async function init(): Promise<void> {
  installStyles();
  settings = await storage.loadSettings();
  applyTheme(settings);
  memories = await storage.listMemories();
  selected = memories.sort((a, b) => b.lastInteraction - a.lastInteraction)[0]?.id ?? null;

  await render();
  setInterval(() => void refresh(), 6000);
}

async function refresh(): Promise<void> {
  memories = await storage.listMemories();
  await render();
}

async function render(): Promise<void> {
  const root = document.getElementById('root')!;
  root.innerHTML = '';

  // Header
  const header = h('div', { class: 'row between', style: 'margin-bottom:11px;' });
  header.appendChild(
    h('div', { class: 'row', style: 'gap:8px;' },
      h('span', {
        style:
          'width:26px;height:26px;border-radius:9px;background:linear-gradient(135deg,var(--violet),var(--rose));display:grid;place-items:center;font-weight:800;color:#fff;font-size:12px;',
        text: 'R',
      }),
      h('div', { style: 'font-weight:800;', text: 'ROSE context' }),
    ),
  );
  const dash = h('button', { class: 'btn sm ghost', text: '📊', title: 'Open dashboard' });
  dash.addEventListener('click', () => {
    const g = globalThis as unknown as { chrome?: typeof chrome };
    const url = g.chrome?.runtime?.getURL?.('dashboard/dashboard.html');
    if (url) void g.chrome?.tabs?.create?.({ url });
  });
  header.appendChild(dash);
  root.appendChild(header);

  if (memories.length === 0) {
    root.appendChild(
      h('div', { class: 'empty' },
        h('div', { style: 'font-size:26px;margin-bottom:8px;', text: '🧠' }),
        h('div', { text: 'No client memory yet.' }),
        h('div', { style: 'font-size:11px;margin-top:6px;', text: 'ROSE creates a record the first time it detects a conversation on a supported page.' }),
      ),
    );
    return;
  }

  // Client picker
  const picker = h('div', { class: 'card', style: 'padding:9px;' });
  const sel = h('select');
  for (const m of [...memories].sort((a, b) => b.lastInteraction - a.lastInteraction)) {
    const opt = h('option', { value: m.id, text: `${m.displayName} — ${m.platform} (${relativeTime(m.lastInteraction)})` });
    if (m.id === selected) opt.setAttribute('selected', '');
    sel.appendChild(opt);
  }
  sel.value = selected ?? '';
  sel.addEventListener('change', () => {
    selected = sel.value;
    void render();
  });
  picker.appendChild(sel);
  root.appendChild(picker);

  const memory = memories.find((m) => m.id === selected);
  if (!memory) return;

  // Summary
  const summaryCard = h('div', { class: 'card' });
  summaryCard.appendChild(h('h3', { text: 'Summary', style: 'margin-bottom:6px;' }));
  summaryCard.appendChild(
    h('div', {
      style: 'font-size:12px;color:var(--text-dim);',
      text: memory.summary || 'No summary yet — ROSE builds one as the conversation grows.',
    }),
  );
  root.appendChild(summaryCard);

  // Facts
  if (memory.importantFacts.length) {
    const factsCard = h('div', { class: 'card' });
    factsCard.appendChild(h('h3', { text: `Known facts (${memory.importantFacts.length})`, style: 'margin-bottom:7px;' }));
    for (const f of [...memory.importantFacts].sort((a, b) => b.weight - a.weight).slice(0, 12)) {
      const row = h('div', { class: 'row between', style: 'padding:4px 0;font-size:11.5px;border-bottom:1px solid var(--outline);' });
      row.appendChild(h('span', { style: 'color:var(--text-dim);flex:0 0 40%;', text: f.key }));
      row.appendChild(h('span', { style: 'flex:1;text-align:right;', text: f.value }));
      factsCard.appendChild(row);
    }
    root.appendChild(factsCard);
  }

  // Topics
  if (memory.topics.length) {
    const topicsCard = h('div', { class: 'card' });
    topicsCard.appendChild(h('h3', { text: 'Topics', style: 'margin-bottom:7px;' }));
    topicsCard.appendChild(
      h('div', { class: 'row wrap', style: 'gap:5px;' }, ...memory.topics.map((t) => h('span', { class: 'badge', text: t }))),
    );
    root.appendChild(topicsCard);
  }

  // Recent messages with detected languages
  const convCard = h('div', { class: 'card' });
  convCard.appendChild(h('h3', { text: 'Recent messages', style: 'margin-bottom:7px;' }));
  for (const msg of memory.recentMessages.slice(-14)) {
    const guess = msg.role === 'client' ? detectLanguage(msg.text) : null;
    const row = h('div', { style: 'padding:5px 0;border-bottom:1px solid var(--outline);' });
    const head = h('div', { class: 'row between', style: 'margin-bottom:2px;' });
    head.appendChild(
      h('span', { class: `badge ${msg.role === 'client' ? 'new' : 'active'}`, text: msg.role === 'client' ? 'Client' : 'Me' }),
    );
    head.appendChild(
      h('span', { class: 'mono', style: 'color:var(--text-faint);font-size:9.5px;', text: guess && guess.confidence > 0.35 ? `${flagFor(guess.lang)} ${guess.lang}` : relativeTime(msg.at) }),
    );
    row.appendChild(head);
    row.appendChild(h('div', { style: 'font-size:11.5px;', text: msg.text }));
    convCard.appendChild(row);
  }
  root.appendChild(convCard);

  // Actions
  const actions = h('div', { class: 'row', style: 'gap:6px;margin-top:8px;' });
  const clearBtn = h('button', { class: 'btn sm danger', text: 'Clear this record', style: 'flex:1;' });
  clearBtn.addEventListener('click', async () => {
    if (!window.confirm(`Delete the memory record for ${memory.displayName}?`)) return;
    await storage.deleteMemory(memory.id);
    memories = await storage.listMemories();
    selected = memories[0]?.id ?? null;
    toast('Record deleted.', 'success');
    await render();
  });
  actions.appendChild(clearBtn);

  const rescan = h('button', { class: 'btn sm', text: '↻', title: 'Refresh' });
  rescan.addEventListener('click', () => void refresh());
  actions.appendChild(rescan);
  root.appendChild(actions);

  root.appendChild(
    h('div', {
      style: 'font-size:10px;color:var(--text-faint);text-align:center;margin-top:12px;line-height:1.6;',
      text: `${memories.length} client record(s) stored locally. Nothing is synced to a server.`,
    }),
  );
}

void init();
