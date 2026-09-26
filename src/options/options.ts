/**
 * ROSE IA options page.
 *
 * Renders every settings section, writes changes through the storage layer, and
 * exposes the provider connection test and the memory inspector. The page is a
 * thin view: all validation and persistence lives in `@/storage` and the policy
 * rules in `@/core/safety/policy`, so the same rules apply everywhere.
 */

import type { RoseSettings, SiteConfigLike } from '@/shared/types';
import type { AIProviderConfig } from '@/shared/types';
import * as storage from '@/storage';
import { MSG } from '@/shared/types';
import { rpc } from '@/shared/rpc';
import { canUseAI } from '@/core/safety/policy';
import { SUPPORTED_LANGUAGES } from '@/core/translation/language';
import { estimateCostUsd, hasKnownPricing } from '@/core/ai/router';
import { summarise } from '@/core/stats/recorder';
import { DEFAULT_SETTINGS } from '@/shared/settings';
import {
  STYLE_OPTIONS,
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
let secrets: storage.SecretMap = {};
let activeSection = 'ai';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  installStyles();
  settings = await storage.loadSettings();
  secrets = await storage.loadSecrets();
  applyTheme(settings);

  document.getElementById('version')!.textContent = `v0.1.0`;
  wireNav();
  await render();

  window
    .matchMedia?.('(prefers-color-scheme: light)')
    .addEventListener?.('change', () => applyTheme(settings));
}

function wireNav(): void {
  document.querySelectorAll<HTMLElement>('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeSection = btn.dataset.section ?? 'ai';
      document.querySelectorAll('.nav-item').forEach((b) => b.setAttribute('aria-current', String(b === btn)));
      void render();
    });
  });
}

async function save(patch: Partial<RoseSettings>, rerender = false): Promise<void> {
  settings = await storage.patchSettings(patch);
  applyTheme(settings);
  if (rerender) await render();
}

async function render(): Promise<void> {
  const main = document.getElementById('main')!;
  main.innerHTML = '';
  const renderers: Record<string, () => Promise<HTMLElement> | HTMLElement> = {
    ai: renderAI,
    conversation: renderConversation,
    automation: renderAutomation,
    memory: renderMemory,
    translation: renderTranslation,
    live: renderLive,
    appearance: renderAppearance,
    notifications: renderNotifications,
    platforms: renderPlatforms,
    data: renderData,
    debug: renderDebug,
  };
  const el = await (renderers[activeSection] ?? renderAI)();
  main.appendChild(el);
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

function renderAI(): HTMLElement {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'AI provider' }));
  wrap.appendChild(
    h('p', { class: 'hint', text: 'ROSE calls an OpenAI-compatible endpoint directly from your browser. Keys are stored locally in this extension only.' }),
  );

  // Policy acknowledgement gate — nothing works until this is accepted.
  const policy = canUseAI(settings);
  const notice = h('div', { class: `notice ${settings.ai.acknowledgedPolicy ? 'success' : 'warn'}` });
  notice.appendChild(h('span', { class: 'ico', text: settings.ai.acknowledgedPolicy ? '✓' : '⚠' }));
  notice.appendChild(
    h('span', {
      html: settings.ai.acknowledgedPolicy
        ? 'Usage policy acknowledged. AI features are available.'
        : 'AI features are disabled until you acknowledge the usage policy below.',
    }),
  );
  wrap.appendChild(notice);

  const provider = settings.ai.providers.find((p) => p.id === settings.ai.activeProvider)!;

  // --- provider selection ---
  const providerCard = h('div', { class: 'card' });
  providerCard.appendChild(h('h2', { text: 'Provider' }));
  providerCard.appendChild(h('p', { class: 'hint', text: 'Any OpenAI-compatible API works: OpenRouter, OpenAI, Groq, or your own ROSE backend proxy.' }));

  providerCard.appendChild(
    field('Active provider', select(
      settings.ai.providers.map((p) => ({ value: p.id, label: `${p.label}${p.viaProxy ? ' (proxy)' : ''}` })),
      settings.ai.activeProvider,
      (v) => void save({ ai: { ...settings.ai, activeProvider: v } }, true),
    )),
  );

  const keyNotRequired = provider.viaProxy || provider.requiresKey === false;
  providerCard.appendChild(
    field(
      'API key',
      h('input', {
        type: 'password',
        value: secrets[provider.id] ?? '',
        placeholder: keyNotRequired ? 'Not required for this provider' : 'Paste your key (stored locally)',
        oninput: debounceInput(async (v: string) => {
          await storage.saveSecret(provider.id, v.trim());
          secrets = await storage.loadSecrets();
        }),
      }),
      keyNotRequired
        ? provider.viaProxy
          ? 'The proxy backend keeps the key server-side; leave this empty.'
          : 'This provider needs no key. Leave this empty.'
        : 'Stored in chrome.storage.local under a separate namespace from your settings. Never sent anywhere except the provider you choose.',
    ),
  );

  const modelInput = h('input', {
    type: 'text',
    value: provider.model,
    placeholder: 'e.g. openai/gpt-4o-mini',
    oninput: debounceInput(async (v: string) => updateProvider(provider.id, { model: v.trim() })),
  });
  providerCard.appendChild(field('Model (complex replies)', modelInput));

  providerCard.appendChild(
    field(
      'Fast model (greetings, summaries, translation)',
      h('input', {
        type: 'text',
        value: provider.fastModel,
        placeholder: 'e.g. meta-llama/llama-3.1-8b-instruct',
        oninput: debounceInput(async (v: string) => updateProvider(provider.id, { fastModel: v.trim() })),
      }),
      'Cheap model used for the high-volume, low-difficulty tasks. This is the main lever on your AI spend.',
    ),
  );

  providerCard.appendChild(
    field(
      'Base URL',
      h('input', {
        type: 'text',
        value: provider.baseUrl,
        oninput: debounceInput(async (v: string) => updateProvider(provider.id, { baseUrl: v.trim() })),
      }),
    ),
  );

  const tempRow = h('div', { class: 'row' });
  // Defensive: settings are normalised on load, but a provider object edited in
  // place elsewhere must not be able to take down the whole page.
  const temperature = Number.isFinite(provider.temperature) ? provider.temperature : 0.85;
  const tempVal = h('span', { class: 'mono', text: temperature.toFixed(2) });
  tempRow.appendChild(
    h('input', {
      type: 'range',
      min: '0',
      max: '1.5',
      step: '0.05',
      value: String(temperature),
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        tempVal.textContent = v.toFixed(2);
      },
      onchange: (e: Event) => void updateProvider(provider.id, { temperature: Number((e.target as HTMLInputElement).value) }),
    }),
  );
  tempRow.appendChild(tempVal);
  providerCard.appendChild(field('Temperature', tempRow, 'Higher is more varied, lower is more predictable.'));

  providerCard.appendChild(
    field(
      'Max response characters',
      h('input', {
        type: 'number',
        min: '80',
        max: '2000',
        value: String(settings.ai.maxResponseChars),
        onchange: (e: Event) => void save({ ai: { ...settings.ai, maxResponseChars: Number((e.target as HTMLInputElement).value) } }),
      }),
      'Replies longer than this are flagged by the quality guard.',
    ),
  );

  const testRow = h('div', { class: 'row' });
  const testBtn = h('button', { class: 'btn primary', text: 'Test connection' });
  const testOut = h('span', { class: 'mono', text: '' });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testOut.textContent = 'Testing…';
    const res = await rpc(MSG.PING, undefined);
    if (!res.ok) {
      testOut.textContent = res.error ?? 'Background service unavailable.';
      testBtn.disabled = false;
      return;
    }
    const result = await testProviderConnection();
    testOut.textContent = result.ok
      ? `✓ ${result.model} responded in ${formatMs(result.latencyMs)}`
      : `✕ ${result.error}`;
    testBtn.disabled = false;
  });
  testRow.appendChild(testBtn);
  testRow.appendChild(testOut);
  providerCard.appendChild(testRow);

  wrap.appendChild(providerCard);

  // --- policy acknowledgement ---
  const policyCard = h('div', { class: 'card' });
  policyCard.appendChild(h('h2', { text: 'Usage policy' }));
  policyCard.appendChild(
    h('p', {
      class: 'hint',
      html:
        'ROSE assists a human operator. It will not produce sexual content involving minors, non-consensual scenarios, ' +
        'or content that violates your AI provider\'s usage policy. It will not help with scams, fraud, extortion or ' +
        'moving anyone off-platform deceptively. Auto-send is blocked for messages that request money or payment details. ' +
        'You remain responsible for complying with each platform\'s terms of service.',
    }),
  );

  const ack = h('label', { class: 'switch' });
  ack.appendChild(
    h('input', {
      type: 'checkbox',
      checked: settings.ai.acknowledgedPolicy,
      onchange: (e: Event) => void save({ ai: { ...settings.ai, acknowledgedPolicy: (e.target as HTMLInputElement).checked } }, true),
    }),
  );
  ack.appendChild(
    h('span', { class: 'txt' }, 'I understand and accept the usage policy', h('small', { text: 'Required before ROSE will make any AI request.' })),
  );
  policyCard.appendChild(ack);

  const nsfw = h('label', { class: 'switch' });
  nsfw.appendChild(
    h('input', {
      type: 'checkbox',
      checked: settings.ai.allowNSFW,
      onchange: (e: Event) => void save({ ai: { ...settings.ai, allowNSFW: (e.target as HTMLInputElement).checked } }),
    }),
  );
  nsfw.appendChild(
    h('span', { class: 'txt' }, 'Allow suggestive (but never explicit) flirty tone', h('small', { text: 'Only affects the Flirty style. Explicit content is never generated.' })),
  );
  policyCard.appendChild(nsfw);
  wrap.appendChild(policyCard);

  if (!policy.allowed && settings.ai.acknowledgedPolicy) {
    wrap.appendChild(h('div', { class: 'notice error', text: policy.reason ?? 'Provider configuration incomplete.' }));
  }

  return wrap;
}

async function updateProvider(id: string, patch: Partial<AIProviderConfig>): Promise<void> {
  const providers = settings.ai.providers.map((p) => (p.id === id ? { ...p, ...patch } : p));
  await save({ ai: { ...settings.ai, providers } });
}

/** Delegates the actual API probe to the background worker (CORS + key access). */
async function testProviderConnection(): Promise<{ ok: boolean; model?: string; error?: string; latencyMs: number }> {
  // The options page cannot read secrets into the content-script world safely,
  // and fetch from here would bypass the service worker's retry logic, so we ask
  // the worker to run the probe by triggering a zero-cost generation request.
  const started = Date.now();
  const res = await rpc(MSG.REQUEST_TRANSLATION, { text: 'ok', targetLanguage: 'en', tone: 'neutral' });
  const latencyMs = Date.now() - started;
  if (res.ok) return { ok: true, model: settings.ai.providers.find((p) => p.id === settings.ai.activeProvider)?.model, latencyMs };
  return { ok: false, error: res.error, latencyMs };
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function renderConversation(): HTMLElement {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Conversation' }));
  wrap.appendChild(h('p', { class: 'hint', text: 'How ROSE writes replies by default.' }));

  const card = h('div', { class: 'card' });

  card.appendChild(
    field(
      'Style',
      select(
        STYLE_OPTIONS.map((s) => ({ value: s.value, label: s.label })),
        settings.conversation.style,
        (v) => void save({ conversation: { ...settings.conversation, style: v as RoseSettings['conversation']['style'] } }, true),
      ),
    ),
  );

  if (settings.conversation.style === 'custom') {
    card.appendChild(
      field(
        'Custom style instructions',
        h('textarea', {
          value: settings.conversation.customStyle,
          placeholder: 'Describe exactly how ROSE should write…',
          oninput: debounceInput(async (v: string) => save({ conversation: { ...settings.conversation, customStyle: v } })),
        }),
      ),
    );
  }

  card.appendChild(
    field(
      'Response length',
      select(
        [
          { value: 'short', label: 'Short (~15 words)' },
          { value: 'medium', label: 'Medium (~35 words)' },
          { value: 'long', label: 'Long (~70 words)' },
        ],
        settings.conversation.length,
        (v) => void save({ conversation: { ...settings.conversation, length: v as RoseSettings['conversation']['length'] } }),
      ),
    ),
  );

  card.appendChild(
    field(
      'Suggestions per generation',
      select(
        [1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} suggestion${n > 1 ? 's' : ''}` })),
        String(settings.conversation.suggestionCount),
        (v) => void save({ conversation: { ...settings.conversation, suggestionCount: Number(v) } }),
      ),
    ),
  );

  card.appendChild(
    field(
      'Reply language',
      select(
        [{ value: 'auto', label: 'Auto — mirror the client\'s language' }, ...SUPPORTED_LANGUAGES.map((l) => ({ value: l.code, label: `${l.flag} ${l.label}` }))],
        settings.conversation.targetLanguage,
        (v) => void save({ conversation: { ...settings.conversation, targetLanguage: v } }),
      ),
      'Auto is recommended: ROSE replies in whatever language the client writes in.',
    ),
  );

  wrap.appendChild(card);
  return wrap;
}

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

function renderAutomation(): HTMLElement {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Automation' }));
  wrap.appendChild(
    h('p', { class: 'hint', text: 'Control how much ROSE is allowed to do on its own. The STOP button in the overlay always takes back control immediately.' }),
  );

  const a = settings.automation;

  const modeCard = h('div', { class: 'card' });
  modeCard.appendChild(h('h2', { text: 'Default mode' }));
  const modes: Array<{ id: RoseSettings['automation']['mode']; label: string; desc: string }> = [
    { id: 'manual', label: 'Manual', desc: 'ROSE generates suggestions only. You copy or type them yourself. Nothing is ever inserted or sent.' },
    { id: 'assisted', label: 'Assisted', desc: 'ROSE writes the reply into the message field. You review and press send.' },
    { id: 'auto', label: 'Auto', desc: 'ROSE inserts and sends after the configured delay, subject to the limits below. Requires explicit confirmation each session.' },
  ];
  for (const m of modes) {
    const opt = h('label', { class: 'switch' });
    opt.appendChild(
      h('input', {
        type: 'radio',
        name: 'mode',
        checked: a.mode === m.id,
        onchange: () => void save({ automation: { ...a, mode: m.id } }, true),
      }),
    );
    opt.appendChild(h('span', { class: 'txt' }, m.label, h('small', { text: m.desc })));
    modeCard.appendChild(opt);
  }
  wrap.appendChild(modeCard);

  const gateCard = h('div', { class: 'card' });
  gateCard.appendChild(h('h2', { text: 'Safety gates' }));

  gateCard.appendChild(
    switchRow('Automation enabled', 'Master switch. When off, ROSE is generate-only regardless of the mode above.', a.globalEnabled, (v) =>
      save({ automation: { ...a, globalEnabled: v } }),
    ),
  );
  gateCard.appendChild(
    switchRow('Paused', 'Temporarily halts all automatic action without losing your settings.', a.globalPaused, (v) =>
      save({ automation: { ...a, globalPaused: v } }),
    ),
  );
  gateCard.appendChild(
    switchRow('Enable follow-up nudges', 'Suggests a re-opening line when a conversation goes quiet. Never sends by itself unless Auto is on.', a.followUpsEnabled, (v) =>
      save({ automation: { ...a, followUpsEnabled: v } }),
    ),
  );

  gateCard.appendChild(
    field(
      'Reply delay (ms)',
      h('input', {
        type: 'number',
        min: '0',
        max: '120000',
        step: '500',
        value: String(a.replyDelayMs),
        onchange: (e: Event) => void save({ automation: { ...a, replyDelayMs: Math.max(0, Number((e.target as HTMLInputElement).value)) } }),
      }),
      'How long ROSE waits between inserting a reply and sending it in Auto mode. This is your window to intervene.',
    ),
  );
  gateCard.appendChild(
    field(
      'Max automatic replies per hour (per conversation)',
      h('input', {
        type: 'number',
        min: '0',
        max: '200',
        value: String(a.maxAutoMessagesPerHour),
        onchange: (e: Event) => void save({ automation: { ...a, maxAutoMessagesPerHour: Math.max(0, Number((e.target as HTMLInputElement).value)) } }),
      }),
      'Hard ceiling enforced by the state machine. Reaching it drops ROSE back to awaiting your confirmation.',
    ),
  );
  gateCard.appendChild(
    field(
      'Inactivity threshold (minutes)',
      h('input', {
        type: 'number',
        min: '1',
        max: '240',
        value: String(a.inactivityMinutes),
        onchange: (e: Event) => void save({ automation: { ...a, inactivityMinutes: Math.max(1, Number((e.target as HTMLInputElement).value)) } }),
      }),
      'A conversation with no messages for this long is marked inactive.',
    ),
  );
  wrap.appendChild(gateCard);
  return wrap;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

async function renderMemory(): Promise<HTMLElement> {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Memory' }));
  wrap.appendChild(
    h('p', { class: 'hint', text: 'ROSE keeps a separate record per client, stored locally. Two clients are never merged, even if they share a display name.' }),
  );

  const m = settings.memory;
  const card = h('div', { class: 'card' });

  card.appendChild(
    switchRow('Enable client memory', 'When off, ROSE keeps no history at all — replies will have no recollection of previous messages.', m.enabled, (v) =>
      save({ memory: { ...m, enabled: v } }, true),
    ),
  );
  card.appendChild(
    field(
      'Retention (days)',
      h('input', {
        type: 'number',
        min: '1',
        max: '3650',
        value: String(m.retentionDays),
        onchange: (e: Event) => void save({ memory: { ...m, retentionDays: Math.max(1, Number((e.target as HTMLInputElement).value)) } }),
      }),
      'Records untouched for longer than this are pruned during housekeeping.',
    ),
  );
  card.appendChild(
    field(
      'Recent messages kept verbatim',
      h('input', {
        type: 'number',
        min: '2',
        max: '60',
        value: String(m.maxRecentMessages),
        onchange: (e: Event) => void save({ memory: { ...m, maxRecentMessages: Math.max(2, Number((e.target as HTMLInputElement).value)) } }),
      }),
      'The raw window sent to the model. Everything older is compressed into the summary.',
    ),
  );
  card.appendChild(
    field(
      'Summarise after N messages',
      h('input', {
        type: 'number',
        min: '4',
        max: '200',
        value: String(m.autoSummarizeAfter),
        onchange: (e: Event) => void save({ memory: { ...m, autoSummarizeAfter: Math.max(4, Number((e.target as HTMLInputElement).value)) } }),
      }),
      'Lower values cut token costs but lose fine detail.',
    ),
  );
  wrap.appendChild(card);

  // --- stored records ---
  const listCard = h('div', { class: 'card' });
  const memories = await storage.listMemories();
  listCard.appendChild(h('h2', { text: `Stored clients (${memories.length})` }));

  if (memories.length === 0) {
    listCard.appendChild(h('div', { class: 'empty', text: 'No client records yet. ROSE creates one the first time it sees a conversation.' }));
  } else {
    const list = h('div', { class: 'list' });
    for (const mem of memories.sort((a2, b2) => b2.lastInteraction - a2.lastInteraction).slice(0, 50)) {
      const item = h('div', { class: 'item' });
      item.appendChild(h('div', { class: 'avatar', text: (mem.displayName || '?').slice(0, 1).toUpperCase() }));
      const meta = h('div', { class: 'meta' });
      meta.appendChild(
        h('div', { class: 'n' }, escapeHtml(mem.displayName), h('span', { class: 'badge', text: mem.platform })),
      );
      meta.appendChild(
        h('div', {
          class: 'm',
          text: `${mem.metadata.messageCount} messages · ${mem.importantFacts.length} facts · ${mem.topics.slice(0, 4).join(', ') || 'no topics yet'}`,
        }),
      );
      meta.appendChild(h('div', { class: 't', text: `Last seen ${relativeTime(mem.lastInteraction)}` }));
      item.appendChild(meta);

      const del = h('button', { class: 'btn sm danger', text: 'Clear' });
      del.addEventListener('click', async () => {
        await storage.deleteMemory(mem.id);
        toast(`Cleared memory for ${mem.displayName}.`, 'success');
        await render();
      });
      item.appendChild(del);
      list.appendChild(item);
    }
    listCard.appendChild(list);
  }
  wrap.appendChild(listCard);

  const dangerCard = h('div', { class: 'card' });
  dangerCard.appendChild(h('h2', { text: 'Erase everything' }));
  dangerCard.appendChild(h('p', { class: 'hint', text: 'Deletes every stored client record immediately. This cannot be undone.' }));
  const clearBtn = h('button', { class: 'btn danger', text: 'Clear all memory' });
  clearBtn.addEventListener('click', async () => {
    if (!window.confirm('Delete every stored client record? This cannot be undone.')) return;
    await storage.clearAllMemory();
    toast('All client memory deleted.', 'success');
    await render();
  });
  dangerCard.appendChild(clearBtn);
  wrap.appendChild(dangerCard);

  return wrap;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function renderTranslation(): HTMLElement {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Translation' }));
  wrap.appendChild(h('p', { class: 'hint', text: 'ROSE detects the client\'s language automatically and can show you a translation of what they wrote.' }));

  const t = settings.translation;
  const card = h('div', { class: 'card' });

  card.appendChild(
    switchRow('Enable translation', 'Adds Translate and auto-translate features.', t.enabled, (v) => save({ translation: { ...t, enabled: v } }, true)),
  );
  card.appendChild(
    switchRow('Auto-translate incoming messages', 'Shows a translation under the client\'s message when it is not in your language.', t.autoTranslateIncoming, (v) =>
      save({ translation: { ...t, autoTranslateIncoming: v } }),
    ),
  );
  card.appendChild(
    switchRow('Show language flags', 'Displays a flag badge next to detected languages.', t.showFlagBadges, (v) =>
      save({ translation: { ...t, showFlagBadges: v } }),
    ),
  );
  card.appendChild(
    field(
      'My language',
      select(
        SUPPORTED_LANGUAGES.map((l) => ({ value: l.code, label: `${l.flag} ${l.label}` })),
        t.myLanguage,
        (v) => void save({ translation: { ...t, myLanguage: v } }),
      ),
      'What ROSE translates client messages into, and the target of the Translate button.',
    ),
  );
  wrap.appendChild(card);

  const langs = h('div', { class: 'card' });
  langs.appendChild(h('h2', { text: 'Supported languages' }));
  langs.appendChild(h('p', { class: 'hint', text: `${SUPPORTED_LANGUAGES.length} languages are recognised by the offline detector. The AI provider handles the actual translation, so any language it supports also works.` }));
  const grid = h('div', { class: 'grid three' });
  for (const l of SUPPORTED_LANGUAGES) {
    grid.appendChild(h('div', { class: 'mono', text: `${l.flag} ${l.code} — ${l.label}` }));
  }
  langs.appendChild(grid);
  wrap.appendChild(langs);

  return wrap;
}

// ---------------------------------------------------------------------------
// Live calls
// ---------------------------------------------------------------------------

function renderLive(): HTMLElement {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Live call assistant' }));
  wrap.appendChild(
    h('div', {
      class: 'notice warn',
      html:
        '<span class="ico">⚠</span><span><b>Honest limitations.</b> Live assist uses the browser\'s own Web Speech API. It captures your <b>microphone</b>, ' +
        'not the remote caller\'s audio stream — ROSE cannot access a platform\'s WebRTC audio without its cooperation. ' +
        'It therefore works best with speakers on, or on a headset where the mic picks up the other person. ' +
        'Chrome and Edge only, and it requires an internet connection because the speech service is remote.</span>',
    }),
  );

  const l = settings.liveCall;
  const card = h('div', { class: 'card' });
  card.appendChild(
    switchRow('Enable live assist', 'Adds the 🎧 button to the floating overlay.', l.enabled, (v) => save({ liveCall: { ...l, enabled: v } }, true)),
  );
  card.appendChild(
    switchRow('Show interim results', 'Displays words as they are recognised, rather than only complete sentences.', l.showInterim, (v) =>
      save({ liveCall: { ...l, showInterim: v } }),
    ),
  );
  card.appendChild(
    field(
      'Recognition language',
      select(
        SUPPORTED_LANGUAGES.map((x) => ({ value: x.code, label: `${x.flag} ${x.label}` })),
        l.language.split('-')[0],
        (v) => void save({ liveCall: { ...l, language: `${v}-${v.toUpperCase()}` } }),
      ),
      'Accent matters more than dialect — pick the closest match to how the other person speaks.',
    ),
  );
  wrap.appendChild(card);

  const avail = h('div', { class: 'card' });
  avail.appendChild(h('h2', { text: 'Browser support' }));
  const supported =
    typeof window !== 'undefined' &&
    !!((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);
  avail.appendChild(
    h('div', { class: `notice ${supported ? 'success' : 'error'}` }, h('span', { class: 'ico', text: supported ? '✓' : '✕' }),
      h('span', { text: supported ? 'The Web Speech API is available in this browser.' : 'This browser does not expose the Web Speech API. Live assist will be unavailable; chat features are unaffected.' }),
    ),
  );
  wrap.appendChild(avail);
  return wrap;
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

function renderAppearance(): HTMLElement {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Appearance' }));
  wrap.appendChild(h('p', { class: 'hint', text: 'The floating overlay. You can also drag it anywhere and resize it from the bottom-right corner.' }));

  const a = settings.appearance;
  const card = h('div', { class: 'card' });

  card.appendChild(
    field(
      'Theme',
      select(
        [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'system', label: 'Match system' },
        ],
        a.theme,
        (v) => void save({ appearance: { ...a, theme: v as RoseSettings['appearance']['theme'] } }, true),
      ),
    ),
  );
  card.appendChild(
    field(
      'Accent',
      select(
        [
          { value: 'violet', label: 'Violet' },
          { value: 'rose', label: 'Rose' },
          { value: 'cyan', label: 'Cyan' },
        ],
        a.accent,
        (v) => void save({ appearance: { ...a, accent: v as RoseSettings['appearance']['accent'] } }, true),
      ),
    ),
  );

  const opVal = h('span', { class: 'mono', text: `${Math.round(a.opacity * 100)}%` });
  const opRow = h('div', { class: 'row' });
  opRow.appendChild(
    h('input', {
      type: 'range',
      min: '0.5',
      max: '1',
      step: '0.01',
      value: String(a.opacity),
      oninput: (e: Event) => {
        opVal.textContent = `${Math.round(Number((e.target as HTMLInputElement).value) * 100)}%`;
      },
      onchange: (e: Event) => void save({ appearance: { ...a, opacity: Number((e.target as HTMLInputElement).value) } }),
    }),
  );
  opRow.appendChild(opVal);
  card.appendChild(field('Overlay opacity', opRow));

  card.appendChild(
    switchRow('Start collapsed', 'Shows only the small ROSE pill until you click it.', a.collapsed, (v) => save({ appearance: { ...a, collapsed: v } })),
  );

  const resetBtn = h('button', { class: 'btn', text: 'Reset overlay position' });
  resetBtn.addEventListener('click', async () => {
    await save({ appearance: { ...a, position: null } });
    toast('Overlay position reset. Reload the page to see it.', 'success');
  });
  card.appendChild(resetBtn);

  wrap.appendChild(card);
  return wrap;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function renderNotifications(): HTMLElement {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Notifications' }));
  wrap.appendChild(h('p', { class: 'hint', text: 'Notifications are rate-limited so ROSE cannot spam you. Errors always come through.' }));

  const n = settings.notifications;
  const card = h('div', { class: 'card' });
  card.appendChild(switchRow('Enable notifications', 'Master switch for all ROSE notifications.', n.enabled, (v) => save({ notifications: { ...n, enabled: v } }, true)));
  card.appendChild(switchRow('New message received', 'Notifies when a client writes while the tab is in the background.', n.onNewMessage, (v) => save({ notifications: { ...n, onNewMessage: v } })));
  card.appendChild(switchRow('Reply ready', 'Notifies when suggestions have finished generating.', n.onReplyReady, (v) => save({ notifications: { ...n, onReplyReady: v } })));
  card.appendChild(switchRow('Errors', 'Always recommended. Cannot be rate-limited away.', n.onError, (v) => save({ notifications: { ...n, onError: v } })));
  card.appendChild(switchRow('Low AI credits', 'Notifies when the provider reports insufficient credit.', n.onCreditsLow, (v) => save({ notifications: { ...n, onCreditsLow: v } })));
  card.appendChild(
    field(
      'Minimum interval between notifications (ms)',
      h('input', {
        type: 'number',
        min: '5000',
        max: '600000',
        step: '5000',
        value: String(n.minIntervalMs),
        onchange: (e: Event) => void save({ notifications: { ...n, minIntervalMs: Math.max(5000, Number((e.target as HTMLInputElement).value)) } }),
      }),
    ),
  );
  wrap.appendChild(card);
  return wrap;
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

function renderPlatforms(): HTMLElement {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Platforms' }));
  wrap.appendChild(
    h('p', {
      class: 'hint',
      text: 'ROSE ships with adapters for CooMeet and Flirtify, and a generic heuristic engine that works on unfamiliar chat UIs. If detection misses your site, add a site configuration here — it takes priority over the built-in heuristics.',
    }),
  );

  const builtins = h('div', { class: 'card' });
  builtins.appendChild(h('h2', { text: 'Built-in adapters' }));
  const table = h('table');
  table.appendChild(
    h('thead', {}, h('tr', {}, h('th', { text: 'Platform' }), h('th', { text: 'Hosts' }), h('th', { text: 'Status' }))),
  );
  const tbody = h('tbody');
  const rows = [
    { name: 'CooMeet', hosts: 'coomeet.com', status: 'Built in' },
    { name: 'Flirtify', hosts: 'flirtify.com', status: 'Built in' },
    { name: 'Generic engine', hosts: 'any chat site', status: 'Fallback' },
    { name: 'Local demo', hosts: 'localhost', status: 'Test harness' },
  ];
  for (const r of rows) {
    tbody.appendChild(h('tr', {}, h('td', { text: r.name }), h('td', { class: 'mono', text: r.hosts }), h('td', {}, h('span', { class: 'badge active', text: r.status }))));
  }
  table.appendChild(tbody);
  builtins.appendChild(table);
  wrap.appendChild(builtins);

  const custom = h('div', { class: 'card' });
  custom.appendChild(h('h2', { text: 'Custom site configurations' }));
  custom.appendChild(
    h('p', {
      class: 'hint',
      html: 'One JSON object per site. Every field except <code>hosts</code> is optional — anything you omit falls back to the heuristics. ' +
        'CSS selectors are tried first and a stale selector never breaks detection.',
    }),
  );

  const ta = h('textarea', {
    value: settings.platforms ? JSON.stringify(settings.platforms, null, 2) : '',
    placeholder: JSON.stringify(
      {
        hosts: ['example-chat.com', '*.example-chat.com'],
        messageContainer: ['[class*="messages"]'],
        incomingMessage: ['[class*="incoming"]'],
        outgoingMessage: ['[class*="outgoing"]'],
        input: ['textarea[placeholder*="message"]'],
        sendButton: ['button[type="submit"]'],
        sendWithEnter: true,
      },
      null,
      2,
    ),
    style: 'min-height:200px;font-family:ui-monospace,monospace;font-size:11px;',
  });
  custom.appendChild(field('Site configurations (JSON array)', ta));

  const saveBtn = h('button', { class: 'btn primary', text: 'Validate and save' });
  const out = h('div', { class: 'mono', style: 'margin-top:8px;' });
  saveBtn.addEventListener('click', async () => {
    const raw = ta.value.trim();
    if (!raw) {
      await save({ platforms: [] });
      out.textContent = '✓ Custom configurations cleared.';
      toast('Custom configurations cleared.', 'success');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      out.textContent = `✕ Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const errors = validateConfigs(list);
    if (errors.length) {
      out.textContent = `✕ ${errors.join(' · ')}`;
      return;
    }
    await save({ platforms: list as SiteConfigLike[] });
    out.textContent = `✓ Saved ${list.length} configuration(s). Reload your chat tab to apply.`;
    toast('Site configurations saved.', 'success');
  });
  custom.appendChild(saveBtn);
  custom.appendChild(out);
  wrap.appendChild(custom);

  return wrap;
}

/** Validates user-supplied site configs before they are persisted. */
function validateConfigs(list: unknown[]): string[] {
  const errors: string[] = [];
  const selectorKeys = ['messageContainer', 'incomingMessage', 'outgoingMessage', 'input', 'sendButton', 'conversationRoot', 'author'];

  list.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`entry ${i} is not an object`);
      return;
    }
    const cfg = entry as Record<string, unknown>;
    if (!Array.isArray(cfg.hosts) || cfg.hosts.length === 0 || !cfg.hosts.every((x) => typeof x === 'string')) {
      errors.push(`entry ${i} needs a non-empty "hosts" array of strings`);
    }
    for (const key of selectorKeys) {
      const v = cfg[key];
      if (v === undefined) continue;
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
        errors.push(`entry ${i}: "${key}" must be an array of CSS selector strings`);
        continue;
      }
      // Reject selectors the browser cannot parse, at save time rather than at
      // runtime where it would silently disable detection.
      for (const sel of v as string[]) {
        try {
          document.querySelector(sel);
        } catch {
          errors.push(`entry ${i}: "${sel}" is not a valid CSS selector`);
        }
      }
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Data & privacy
// ---------------------------------------------------------------------------

async function renderData(): Promise<HTMLElement> {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Data & privacy' }));
  wrap.appendChild(h('p', { class: 'hint', text: 'What ROSE stores, where it goes, and how to get rid of it.' }));

  const info = h('div', { class: 'card' });
  info.appendChild(h('h2', { text: 'What ROSE stores' }));
  info.appendChild(
    h('ul', { style: 'padding-left:18px;font-size:12px;color:var(--text-dim);line-height:1.9;' },
      h('li', { text: 'Your settings, in chrome.storage.local.' }),
      h('li', { text: 'Your API key, in a separate storage namespace so a settings export never contains it.' }),
      h('li', { text: 'One memory record per client: recent messages, a summary, extracted facts and topics.' }),
      h('li', { text: 'Daily counters: messages received, replies generated, tokens used and estimated cost.' }),
    ),
  );
  info.appendChild(
    h('div', { class: 'notice' },
      h('span', { class: 'ico', text: 'ℹ' }),
      h('span', {
        text: 'Nothing is sent to ROSE servers — there are none. Messages leave your machine only in the prompt sent to the AI provider you configured, and only when you generate a reply.',
      }),
    ),
  );
  wrap.appendChild(info);

  const costs = h('div', { class: 'card' });
  costs.appendChild(h('h2', { text: 'AI cost meter' }));
  const stats = await storage.getStatsRange(30);
  const agg = summarise(stats);
  const grid = h('div', { class: 'grid three' });
  grid.appendChild(statBox('Requests (30d)', formatNumber(agg.requests)));
  grid.appendChild(statBox('Tokens (30d)', formatNumber(agg.tokens)));
  grid.appendChild(statBox('Estimated cost', formatCost(agg.costUsd), hasKnownPricing(settings.ai.providers.find((p) => p.id === settings.ai.activeProvider)?.model ?? '') ? 'Based on published list prices' : 'Pricing unknown for this model — cost not estimated'));
  costs.appendChild(grid);
  wrap.appendChild(costs);

  const actions = h('div', { class: 'card' });
  actions.appendChild(h('h2', { text: 'Export and erase' }));

  const exportBtn = h('button', { class: 'btn', text: 'Export settings (no API keys)' });
  exportBtn.addEventListener('click', async () => {
    const safe = { ...settings, ai: { ...settings.ai, providers: settings.ai.providers.map((p) => ({ ...p, apiKey: '' })) } };
    download(`rose-settings-${Date.now()}.json`, JSON.stringify(safe, null, 2));
    toast('Settings exported. API keys were excluded.', 'success');
  });
  actions.appendChild(exportBtn);

  const importInput = h('input', { type: 'file', accept: 'application/json', style: 'display:none' });
  const importBtn = h('button', { class: 'btn', text: 'Import settings' });
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<RoseSettings>;
      const merged = { ...DEFAULT_SETTINGS, ...parsed } as RoseSettings;
      await storage.saveSettings(merged);
      settings = await storage.loadSettings();
      applyTheme(settings);
      toast('Settings imported.', 'success');
      await render();
    } catch (err) {
      toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  });
  actions.appendChild(importBtn);
  actions.appendChild(importInput);

  const resetBtn = h('button', { class: 'btn danger', text: 'Reset all settings' });
  resetBtn.addEventListener('click', async () => {
    if (!window.confirm('Reset every setting to its default? Your client memory will be kept.')) return;
    settings = await storage.resetSettings();
    applyTheme(settings);
    toast('Settings reset to defaults.', 'success');
    await render();
  });
  actions.appendChild(resetBtn);
  wrap.appendChild(actions);

  return wrap;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

async function renderDebug(): Promise<HTMLElement> {
  const wrap = h('div');
  wrap.appendChild(h('h1', { text: 'Diagnostics' }));
  wrap.appendChild(h('p', { class: 'hint', text: 'Developer logging. Message content is redacted unless verbose mode is on.' }));

  const d = settings.debug;
  const card = h('div', { class: 'card' });
  card.appendChild(switchRow('Enable logging', 'Prints [ROSE] entries to the page console.', d.enabled, (v) => save({ debug: { ...d, enabled: v } }, true)));
  card.appendChild(
    switchRow('Verbose (include message text)', 'Off by default. When on, log entries contain the actual message text — useful for debugging, but do not share those logs.', d.verbose, (v) =>
      save({ debug: { ...d, verbose: v } }),
    ),
  );
  card.appendChild(
    switchRow('Show diagnostics panel in the overlay', 'Adds a live log panel inside the floating assistant.', d.showOverlay, (v) => save({ debug: { ...d, showOverlay: v } }, true)),
  );
  wrap.appendChild(card);

  const health = h('div', { class: 'card' });
  health.appendChild(h('h2', { text: 'Environment' }));
  const ping = await rpc(MSG.PING, undefined);
  const rows: Array<[string, string]> = [
    ['Background service', ping.ok ? `✓ running (v${(ping.data as { version?: string })?.version ?? '?'})` : `✕ ${ping.error}`],
    ['Manifest version', 'V3'],
    ['Storage backend', typeof (globalThis as unknown as { chrome?: typeof chrome }).chrome?.storage?.local === 'object' ? 'chrome.storage.local' : 'localStorage (fallback)'],
    ['Policy acknowledged', settings.ai.acknowledgedPolicy ? '✓ yes' : '✕ no — AI is disabled'],
    ['Active provider', settings.ai.activeProvider],
    ['Memory records', String((await storage.listMemories()).length)],
  ];
  const table = h('table');
  for (const [k, v] of rows) {
    table.appendChild(h('tr', {}, h('td', { text: k }), h('td', { class: 'mono', text: v })));
  }
  health.appendChild(table);
  wrap.appendChild(health);

  const tools = h('div', { class: 'card' });
  tools.appendChild(h('h2', { text: 'Maintenance' }));
  const pruneBtn = h('button', { class: 'btn', text: 'Prune stale memory now' });
  pruneBtn.addEventListener('click', async () => {
    const n = await storage.pruneMemory(settings.memory.retentionDays);
    toast(`Pruned ${n} stale record(s).`, 'success');
  });
  tools.appendChild(pruneBtn);

  const clearSecretsBtn = h('button', { class: 'btn danger', text: 'Delete stored API keys' });
  clearSecretsBtn.addEventListener('click', async () => {
    if (!window.confirm('Delete every stored API key from this browser?')) return;
    await storage.clearSecrets();
    secrets = await storage.loadSecrets();
    toast('API keys deleted.', 'success');
    await render();
  });
  tools.appendChild(clearSecretsBtn);
  wrap.appendChild(tools);

  return wrap;
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

function field(label: string, control: HTMLElement, desc?: string): HTMLElement {
  const wrap = h('label', { class: 'field' });
  wrap.appendChild(h('span', { class: 'lbl', text: label }));
  wrap.appendChild(control);
  if (desc) wrap.appendChild(h('span', { class: 'desc', text: desc }));
  return wrap;
}

function select(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (v: string) => void,
): HTMLSelectElement {
  const el = h('select');
  for (const o of options) {
    const opt = h('option', { value: o.value, text: o.label });
    if (o.value === value) opt.setAttribute('selected', '');
    el.appendChild(opt);
  }
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function switchRow(
  label: string,
  description: string,
  checked: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const wrap = h('label', { class: 'switch' });
  wrap.appendChild(h('input', { type: 'checkbox', checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }));
  wrap.appendChild(h('span', { class: 'txt' }, label, h('small', { text: description })));
  return wrap;
}

function statBox(k: string, v: string, sub?: string): HTMLElement {
  const box = h('div', { class: 'stat accent' });
  box.appendChild(h('div', { class: 'k', text: k }));
  box.appendChild(h('div', { class: 'v', text: v }));
  if (sub) box.appendChild(h('div', { class: 'sub', text: sub }));
  return box;
}

function debounceInput(fn: (v: string) => void | Promise<void>, ms = 400): (e: Event) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (e: Event) => {
    const value = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void fn(value), ms);
  };
}

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

void init();
