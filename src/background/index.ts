/**
 * ROSE IA background service worker.
 *
 * This is the single writer for settings, client memory and statistics, and the
 * only place that performs outbound network calls (see shared/rpc.ts for why).
 * Content scripts and UI pages talk to it exclusively through typed RPC.
 *
 * MV3 lifecycle note: a service worker is torn down when idle and restarted on
 * the next event. Nothing important may live in module-level mutable state that
 * is not also reconstructible — settings, memory and stats are all re-read from
 * storage on demand, and the runtime pause flag is persisted.
 */

import { MSG } from '@/shared/types';
import type {
  AIProviderConfig,
  Command,
  ConversationRef,
  Envelope,
  GenerationRequest,
  MessageResponse,
  OverlayIntent,
  RoseSettings,
  StatsEvent,
  Suggestion,
} from '@/shared/types';
import { rpc, toMemorySummary } from '@/shared/rpc';
import { configureLogging, getLogEntries, log } from '@/core/logging/logger';
import { ClientMemoryStore } from '@/core/memory/store';
import { ConversationEngine, resolveLanguage } from '@/core/conversation/engine';
import { GenerationService } from '@/core/ai/generation-service';
import { ResponseQualityGuard } from '@/core/safety/quality-guard';
import { CooldownGate, RateLimiter, canUseAI, isAutoSendBlocked } from '@/core/safety/policy';
import { StatsRecorder } from '@/core/stats/recorder';
import { detectLanguage } from '@/core/translation/language';
import { classifyComplexity, shouldCallAI } from '@/core/ai/router';
import { buildSummaryPrompt } from '@/core/ai/prompts';
import { normaliseText } from '@/shared/utils';
import * as storage from '@/storage';
import { NotificationGate } from './notifications';
import { activateSite } from './site-access';
import { FrameArbiter, type ArbiterDecision } from './frame-arbiter';

const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Singletons, lazily constructed so a cold start does not read storage needlessly
// ---------------------------------------------------------------------------

let settingsCache: RoseSettings | null = null;
let memoryStore: ClientMemoryStore | null = null;
let generation: GenerationService | null = null;
let stats: StatsRecorder | null = null;
let notifications: NotificationGate | null = null;

const guard = new ResponseQualityGuard();
let rateLimiter = new RateLimiter(20);
let cooldown = new CooldownGate(4000);

/** Per-conversation follow-up counters (session-scoped, intentionally ephemeral). */
const followUpCounts = new Map<string, number>();
/** Tracks which conversations we have already counted today, to keep stats honest. */
const countedConversations = new Set<string>();

async function getSettings(force = false): Promise<RoseSettings> {
  if (!settingsCache && !force) settingsCache = await storage.loadSettings();
  if (force) settingsCache = await storage.loadSettings();
  const s = settingsCache!;
  configureLogging({ enabled: s.debug.enabled, verbose: s.debug.verbose });
  rateLimiter.setLimit(s.automation.maxAutoMessagesPerHour);
  cooldown.setCooldown(s.automation.replyDelayMs);
  return s;
}

function getMemoryStore(): ClientMemoryStore {
  memoryStore ??= new ClientMemoryStore(() => {
    const s = settingsCache;
    return {
      enabled: s?.memory.enabled ?? true,
      retentionDays: s?.memory.retentionDays ?? 90,
      maxRecentMessages: s?.memory.maxRecentMessages ?? 12,
      autoSummarizeAfter: s?.memory.autoSummarizeAfter ?? 20,
    };
  });
  return memoryStore;
}

async function getProvider(): Promise<AIProviderConfig> {
  const s = await getSettings();
  const provider = s.ai.providers.find((p) => p.id === s.ai.activeProvider);
  if (!provider) throw new Error(`Unknown AI provider: ${s.ai.activeProvider}`);
  return provider;
}

function getGeneration(): GenerationService {
  generation ??= new GenerationService({
    getActiveProvider: getProvider,
    getApiKey: async (providerId) => (await storage.loadSecrets())[providerId] ?? '',
    onUsage: (u) => {
      void getStats().record({
        kind: 'ai-request',
        tokensPrompt: u.promptTokens,
        tokensCompletion: u.completionTokens,
        costUsd: u.costUsd,
        conversationId: u.conversationId,
      });
    },
  });
  return generation;
}

function getStats(): StatsRecorder {
  stats ??= new StatsRecorder();
  return stats;
}

function getNotifications(): NotificationGate {
  notifications ??= new NotificationGate(() => settingsCache!);
  return notifications;
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { chrome?: typeof chrome };

if (g.chrome?.runtime?.onMessage) {
  g.chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const envelope = message as Envelope;
    if (!envelope?.type) return false;

    // The frame id comes from the browser's own sender metadata, never from the
    // page: a page cannot claim to be another frame. `undefined` means the
    // message did not come from a content script.
    const frameId = sender?.frameId;
    const tabId = sender?.tab?.id;
    const fromContentScript = typeof frameId === 'number' && typeof tabId === 'number';

    handle(envelope, fromContentScript ? { tabId: tabId!, frameId } : null)
      .then((res) => sendResponse(res))
      .catch((err) => {
        const text = err instanceof Error ? err.message : String(err);
        log.error('background', `handler failed for ${envelope.type}`, text);
        sendResponse({ ok: false, error: text } satisfies MessageResponse);
      });

    return true; // keep the channel open for the async response
  });
}

/** Where a message came from, as reported by the browser rather than the page. */
interface SenderOrigin {
  tabId: number;
  frameId: number;
}

/**
 * Overlay arbitration. One arbiter for the whole service worker: it is the only
 * place that knows about every frame of every tab, which is exactly what is
 * needed to keep a single overlay per tab.
 */
const arbiter = new FrameArbiter();

/**
 * Latest panel state published by each data-owning frame, keyed `tabId:frameId`.
 *
 * Needed because a frame can publish before the renderer exists (the chat frame
 * often wins the race), and because the renderer asks for a snapshot when it
 * mounts. Without it the panel would stay blank until the next state change.
 */
const mirrorState = new Map<string, Record<string, unknown>>();

/** Sends a command to one specific frame of a tab. */
async function sendToFrame(tabId: number, frameId: number, command: Command): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.COMMAND, payload: command }, { frameId });
  } catch (err) {
    // A frame can disappear between arbitration and delivery; that is normal.
    log.debug('background', `could not reach frame ${tabId}:${frameId}`, err);
  }
}

/** Applies an arbitration decision: the renderer mounts, the previous one does not. */
async function applyDecision(tabId: number, decision: ArbiterDecision): Promise<void> {
  for (const frameId of decision.unmountIn) {
    await sendToFrame(tabId, frameId, { action: 'unmount-overlay' });
  }
  for (const { frameId, mirrorFor } of decision.mountIn) {
    await sendToFrame(tabId, frameId, { action: 'mount-overlay', mirrorFor });
  }
}

async function handle(env: Envelope, origin: SenderOrigin | null): Promise<MessageResponse<unknown>> {
  const settings = await getSettings();

  switch (env.type) {
    case MSG.PING:
      return { ok: true, data: { ok: true, version: VERSION } };

    case MSG.DETECTION_REPORT: {
      const { report, role, frame } = env.payload as {
        report: { platform: string; confidence: number; hostname: string; resolved?: Record<string, string | null> };
        role?: string;
        frame?: { tabId: number | null; frameId: number; url: string; key: string };
      };
      // Prefer the browser's frame id over the page-reported one.
      const frameId = origin?.frameId ?? frame?.frameId ?? 0;
      const tabId = origin?.tabId ?? frame?.tabId ?? null;
      log.info('background', 'detection reported', {
        platform: report.platform,
        confidence: report.confidence,
        hostname: report.hostname,
        role: role ?? 'unknown',
        frame: tabId === null ? null : `${tabId}:${frameId}`,
      });

      // Only the frame that owns the UI can raise an integration warning; a chat
      // frame reporting generic at low confidence is expected and would otherwise
      // produce duplicate notifications for one tab.
      const ownsUi = !role || role === 'top';
      if (ownsUi && report.platform === 'generic' && report.confidence < 0.5) {
        await getNotifications().notify(
          'integration',
          'Platform not fully recognised',
          `ROSE is running in generic mode on ${report.hostname}. Add a site configuration in Settings if detection misses your chat.`,
        );
      }

      // Arbitrate which frame owns the overlay. The frame id must come from the
      // browser, so a report without sender metadata is not arbitrated.
      let instruction: { render: boolean; mirrorFor: number | null; dataOwner: boolean } = {
        render: false,
        mirrorFor: null,
        dataOwner: false,
      };
      if (origin && (role === 'top' || role === 'chat' || role === 'ignored')) {
        const decision = arbiter.report({
          tabId: origin.tabId,
          frameId: origin.frameId,
          role,
          // A frame has a chat surface when the detector resolved a composer or a
          // message container in it — the same signal the content script used.
          hasChat: !!report.resolved?.input || !!report.resolved?.container,
        });
        await applyDecision(origin.tabId, decision);
        // The push above can arrive before this frame's listener exists (the chat
        // frame normally reports first, so the top frame is elected while it is
        // still loading). Returning the verdict lets each frame act on the
        // decision that applies to it, whatever the ordering.
        instruction = arbiter.instructionFor(origin.tabId, origin.frameId);
      }

      return { ok: true, data: { accepted: true, ...instruction } };
    }

    case MSG.FRAME_GONE: {
      // A frame is being torn down. Drop it from arbitration so a chat frame that
      // navigated away stops owning the overlay and the tab can elect a new owner.
      if (!origin) return { ok: true, data: { accepted: false } };
      const decision = arbiter.forgetFrame(origin.tabId, origin.frameId);
      await applyDecision(origin.tabId, decision);
      // Forget any mirrored state, so a re-created frame does not show stale data.
      mirrorState.delete(`${origin.tabId}:${origin.frameId}`);
      log.debug('background', 'frame gone', { frame: `${origin.tabId}:${origin.frameId}` });
      return { ok: true, data: { accepted: true } };
    }

    case MSG.OVERLAY_SYNC: {
      // A data-owning frame published its panel state. Cache it and forward to
      // the renderer, which is the only frame allowed to draw the panel.
      if (!origin) return { ok: true, data: { delivered: false } };
      const { state, mounted } = env.payload as { state: Record<string, unknown>; mounted: boolean };
      const key = `${origin.tabId}:${origin.frameId}`;
      if (mounted) mirrorState.set(key, state);
      else mirrorState.delete(key);

      const renderer = arbiter.renderer(origin.tabId);
      log.debug('background', 'overlay sync received', {
        from: `${origin.tabId}:${origin.frameId}`,
        renderer,
        mounted,
        bytes: JSON.stringify(state).length,
      });
      // Only forward when the renderer is a different frame: if the top frame is
      // both data owner and renderer it already has the state locally.
      if (renderer === 'none' || renderer === origin.frameId) {
        return { ok: true, data: { delivered: false } };
      }
      await sendToFrame(origin.tabId, renderer, {
        action: 'mirror-state',
        fromFrameId: origin.frameId,
        state,
        mounted,
      } as Command);
      log.debug('background', 'overlay sync forwarded', { to: `${origin.tabId}:${renderer}` });
      return { ok: true, data: { delivered: true } };
    }

    case MSG.OVERLAY_MIRROR_READY: {
      // The renderer just mounted and wants the current snapshot of its source.
      if (!origin) return { ok: true, data: { mirrored: false } };
      const dataOwner = arbiter.dataOwner(origin.tabId);
      if (dataOwner === 'none' || dataOwner === origin.frameId) {
        return { ok: true, data: { mirrored: false } };
      }
      const state = mirrorState.get(`${origin.tabId}:${dataOwner}`);
      if (state) {
        await sendToFrame(origin.tabId, origin.frameId, {
          action: 'mirror-state',
          fromFrameId: dataOwner,
          state,
          mounted: true,
        } as Command);
      }
      // Ask the source to republish, which covers the case where it published
      // before the renderer existed and its message was dropped.
      await sendToFrame(origin.tabId, dataOwner, { action: 'republish-overlay' } as Command);
      return { ok: true, data: { mirrored: true } };
    }

    case MSG.OVERLAY_INTENT: {
      // The renderer forwarded an operator action; deliver it to the data owner.
      if (!origin) return { ok: true, data: { delivered: false } };
      const { intent } = env.payload as { intent: OverlayIntent };
      const dataOwner = arbiter.dataOwner(origin.tabId);
      if (dataOwner === 'none' || dataOwner === origin.frameId) {
        return { ok: true, data: { delivered: false } };
      }
      await sendToFrame(origin.tabId, dataOwner, { action: 'overlay-intent', intent } as Command);
      return { ok: true, data: { delivered: true } };
    }

    case MSG.CONVERSATION_ACTIVATED: {
      const { conversation } = env.payload as { conversation: ConversationRef };
      const memory = await getMemoryStore().getOrCreate(conversation);
      if (!countedConversations.has(conversation.id)) {
        countedConversations.add(conversation.id);
        await getStats().record({ kind: 'conversation', conversationId: conversation.id });
      }
      return { ok: true, data: { memory: toMemorySummary(memory) } };
    }

    case MSG.MESSAGE_DETECTED: {
      const { conversation, text, language } = env.payload as {
        conversation: ConversationRef;
        text: string;
        language: string | null;
      };

      const lang = language ?? detectLanguage(text).lang;
      const store = getMemoryStore();
      const { memory } = await store.recordIncoming(conversation, text, lang);
      await getStats().record({ kind: 'message-received', conversationId: conversation.id });

      const engine = new ConversationEngine(() => ({
        inactivityMinutes: settings.automation.inactivityMinutes,
        maxRecentMessages: settings.memory.maxRecentMessages,
      }));
      const understanding = engine.understand(text, memory, engine.buildHistory(memory, text));

      const complexity = classifyComplexity(text, memory.recentMessages.length);
      const consecutiveTrivial = countTrailingTrivial(memory.recentMessages);
      const verdict = shouldCallAI(text, { complexity, consecutiveTrivial });

      // Memory maintenance is background work: it must never delay a reply.
      if (settings.memory.enabled && memory.metadata.messageCount % 6 === 0) {
        void maintainMemory(conversation, memory);
      }

      return {
        ok: true,
        data: {
          memory: toMemorySummary(memory),
          shouldCallAI: verdict.call,
          reason: verdict.reason,
        },
      };
    }

    case MSG.REQUEST_SUGGESTIONS:
      return requestSuggestions(env, settings);

    case MSG.RECORD_OUTGOING: {
      const { conversation, text, language, sent } = env.payload as {
        conversation: ConversationRef;
        text: string;
        language: string | null;
        sent: boolean;
      };
      const store = getMemoryStore();
      const { memory } = await store.recordOutgoing(conversation, text, language ?? detectLanguage(text).lang);
      if (sent) await getStats().record({ kind: 'response-sent', conversationId: conversation.id });
      return { ok: true, data: { memory: toMemorySummary(memory) } };
    }

    case MSG.REQUEST_TRANSLATION: {
      const { text, targetLanguage, tone } = env.payload as {
        text: string;
        targetLanguage: string;
        tone: string;
      };
      const policy = canUseAI(settings);
      if (!policy.allowed) return { ok: false, error: policy.reason };
      // An empty request never reaches the provider, so blaming the provider
      // configuration would send the operator chasing the wrong problem.
      if (!text.trim()) return { ok: false, error: 'Nothing to translate.' };

      const translated = await getGeneration().translate(text, targetLanguage, tone);
      return translated
        ? { ok: true, data: { text: translated } }
        : { ok: false, error: 'Translation failed. Check the AI provider settings.' };
    }

    case MSG.STATS_EVENT: {
      await getStats().record(env.payload as StatsEvent);
      return { ok: true, data: { ok: true } };
    }

    case MSG.ACTIVATE_SITE: {
      const { host } = (env.payload ?? {}) as { host?: string };
      if (!g.chrome?.permissions || !g.chrome?.scripting) {
        return { ok: false, error: 'This browser does not expose the permissions API.' };
      }
      return activateSite(g.chrome as never, host ?? '');
    }

    default:
      return { ok: false, error: `Unhandled message type: ${env.type}` };
  }
}

async function requestSuggestions(
  env: Envelope,
  settings: RoseSettings,
): Promise<MessageResponse<unknown>> {
  const req = env.payload as {
    conversation: ConversationRef;
    incoming: string;
    style: GenerationRequest['style'];
    customStyle: string;
    length: GenerationRequest['length'];
    targetLanguage: string;
    count: number;
    force?: boolean;
  };

  const policy = canUseAI(settings);
  if (!policy.allowed) {
    await getNotifications().notify('integration', 'AI unavailable', policy.reason ?? 'Check your settings.');
    return { ok: false, error: policy.reason };
  }

  const store = getMemoryStore();
  const memory = await store.getOrCreate(req.conversation);
  const engine = new ConversationEngine(() => ({
    inactivityMinutes: settings.automation.inactivityMinutes,
    maxRecentMessages: settings.memory.maxRecentMessages,
  }));

  const language = resolveLanguage(req.incoming, memory, req.targetLanguage);
  const history = engine.buildHistory(memory, req.incoming);

  const started = Date.now();
  const result = await getGeneration().generate(
    {
      conversation: req.conversation,
      memory: { ...memory, language },
      incoming: req.incoming,
      history,
      style: req.style,
      customStyle: req.customStyle,
      length: req.length,
      count: Math.max(1, Math.min(4, req.count)),
      targetLanguage: language,
    },
    { force: req.force },
  );

  // Quality-guard every suggestion so the UI can flag problems before sending.
  const recentReplies = memory.recentMessages
    .filter((m) => m.role === 'assistant')
    .slice(-6)
    .map((m) => m.text);

  const suggestions: Suggestion[] = [];
  for (const s of result.suggestions) {
    const report = guard.check(s, memory, {
      expectedLanguage: language,
      maxChars: settings.ai.maxResponseChars,
      recentReplies,
      incoming: req.incoming,
      incomingLanguage: language,
    });
    if (report.ok) suggestions.push(s);
    else {
      log.warn('quality', `suggestion blocked (${report.issues.map((i) => i.code).join(', ')})`);
    }
  }

  if (suggestions.length === 0 && result.suggestions.length > 0) {
    return {
      ok: false,
      error: 'Every generated suggestion failed the quality check. Try Regenerate or adjust the style.',
    };
  }

  await getStats().record({
    kind: 'response-generated',
    conversationId: req.conversation.id,
    responseMs: Date.now() - started,
  });

  if (settings.notifications.onReplyReady && settings.automation.mode !== 'auto') {
    await getNotifications().notify('reply-ready', 'Reply ready', `${suggestions.length} suggestion(s) for ${req.conversation.displayName}.`, {
      silent: true,
    });
  }

  return {
    ok: true,
    data: {
      suggestions,
      result: {
        provider: result.provider,
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        latencyMs: result.latencyMs,
        cached: result.cached,
      },
      memory: toMemorySummary(memory),
    },
  };
}

/** Counts trailing one-word/low-content messages to damp token spend. */
function countTrailingTrivial(messages: Array<{ role: string; text: string }>): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'client') break;
    if (classifyComplexity(m.text) !== 'trivial') break;
    n++;
  }
  return n;
}

/**
 * Rolls the conversation summary forward and refreshes extracted facts.
 * Runs in the background and swallows its own failures: a broken summary must
 * never break reply generation.
 */
async function maintainMemory(conversation: ConversationRef, memory: Awaited<ReturnType<ClientMemoryStore['getOrCreate']>>): Promise<void> {
  try {
    const store = getMemoryStore();
    const svc = getGeneration();

    const newMessages = memory.recentMessages.map(
      (m) => `${m.role === 'client' ? 'CLIENT' : 'ME'}: ${normaliseText(m.text)}`,
    );

    if (newMessages.length) {
      const summary = await svc.summarize(buildSummaryPrompt(memory, newMessages));
      if (summary?.text) await store.applySummary(memory, summary.text);
    }

    const clientTexts = memory.recentMessages.filter((m) => m.role === 'client').map((m) => m.text);
    if (clientTexts.length) {
      const facts = await svc.extractFacts(clientTexts.join('\n'), memory.importantFacts.map((f) => f.key));
      if (facts.length) {
        const refreshed = (await store.refresh(memory.id)) ?? memory;
        await store.mergeFacts(refreshed, facts);
      }
    }
    log.debug('memory', 'maintenance complete', { id: memory.id });
  } catch (err) {
    log.warn('memory', 'background maintenance failed (non-fatal)', err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (g.chrome?.runtime?.onInstalled) {
  g.chrome.runtime.onInstalled.addListener(async (details) => {
    await getSettings(true);
    log.info('background', `installed/updated (${details.reason})`, { version: VERSION });
    if (details.reason === 'install') {
      // Open Settings on first install so the policy gate and API key are seen.
      g.chrome?.tabs?.create({ url: g.chrome.runtime.getURL('options/options.html') });
    }
  });
}

if (g.chrome?.runtime?.onStartup) {
  g.chrome.runtime.onStartup.addListener(async () => {
    await getSettings(true);
    log.info('background', 'browser started; settings reloaded');
  });
}

// Settings can change from any surface; keep the cache coherent.
if (g.chrome?.storage?.onChanged) {
  g.chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes['rose:settings']) return;
    await getSettings(true);
    log.info('background', 'settings changed; caches refreshed');
  });
}

if (g.chrome?.alarms?.create) {
  // Daily housekeeping: prune stale memories and flush stats.
  g.chrome.alarms.create('rose-housekeeping', { periodInMinutes: 60 * 6 });
  g.chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'rose-housekeeping') return;
    try {
      await getSettings(true);
      const removed = await storage.pruneMemory(settingsCache!.memory.retentionDays);
      await getStats().flush();
      log.info('background', 'housekeeping complete', { prunedMemories: removed });
    } catch (err) {
      log.warn('background', 'housekeeping failed', err);
    }
  });
}

if (g.chrome?.commands?.onCommand) {
  g.chrome.commands.onCommand.addListener(async (command) => {
    const [tab] = (await g.chrome!.tabs.query({ active: true, currentWindow: true })) ?? [];
    if (!tab?.id) return;
    const map: Record<string, unknown> = {
      'toggle-overlay': { action: 'toggle-overlay' },
      'stop-all': { action: 'stop-all' },
      rescan: { action: 'rescan' },
    };
    if (map[command]) {
      try {
        await g.chrome!.tabs.sendMessage(tab.id, { type: MSG.COMMAND, payload: map[command] });
      } catch {
        // The tab has no content script (unsupported site) — nothing to do.
      }
    }
  });
}

// React to commands issued by the popup/side panel through broadcast.
if (g.chrome?.runtime?.onMessage) {
  g.chrome.runtime.onMessage.addListener((message: unknown) => {
    const env = message as Envelope;
    if (env?.type === MSG.COMMAND) {
      // Re-broadcast to the active tab's content script.
      void (async () => {
        const [tab] = (await g.chrome!.tabs.query({ active: true, currentWindow: true })) ?? [];
        if (tab?.id) {
          try {
            await g.chrome!.tabs.sendMessage(tab.id, env);
          } catch {
            /* no content script in this tab */
          }
        }
      })();
    }
    return false;
  });
}

log.info('background', `ROSE IA service worker ready (v${VERSION})`);

/**
 * Diagnostic handle for the validation harness.
 *
 * Lives only in the service worker — the page cannot reach it — and exposes the
 * arbitration state, which is otherwise unobservable from outside: a mirror that
 * never receives a snapshot looks identical to one that received the wrong
 * snapshot, and both look like "the panel is blank".
 */
Object.defineProperty(globalThis, '__ROSE_BG', {
  value: {
    version: VERSION,
    frames: (tabId: number) => arbiter.frames(tabId),
    dataOwner: (tabId: number) => arbiter.dataOwner(tabId),
    renderer: (tabId: number) => arbiter.renderer(tabId),
    mirrorKeys: () => [...mirrorState.keys()],
    mirrorState: (key: string) => mirrorState.get(key) ?? null,
    logs: () => getLogEntries().map((e) => `${e.scope}: ${e.message}`),
  },
  configurable: true,
});
