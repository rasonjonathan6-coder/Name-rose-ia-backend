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
  ConversationRef,
  Envelope,
  GenerationRequest,
  MessageResponse,
  RoseSettings,
  StatsEvent,
  Suggestion,
} from '@/shared/types';
import { rpc, toMemorySummary } from '@/shared/rpc';
import { configureLogging, log } from '@/core/logging/logger';
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
import { enableSite } from './site-access';

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
  g.chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const envelope = message as Envelope;
    if (!envelope?.type) return false;

    handle(envelope)
      .then((res) => sendResponse(res))
      .catch((err) => {
        const text = err instanceof Error ? err.message : String(err);
        log.error('background', `handler failed for ${envelope.type}`, text);
        sendResponse({ ok: false, error: text } satisfies MessageResponse);
      });

    return true; // keep the channel open for the async response
  });
}

async function handle(env: Envelope): Promise<MessageResponse<unknown>> {
  const settings = await getSettings();

  switch (env.type) {
    case MSG.PING:
      return { ok: true, data: { ok: true, version: VERSION } };

    case MSG.DETECTION_REPORT: {
      const { report } = env.payload as { report: { platform: string; confidence: number; hostname: string } };
      log.info('background', 'detection reported', {
        platform: report.platform,
        confidence: report.confidence,
        hostname: report.hostname,
      });
      if (report.platform === 'generic' && report.confidence < 0.5) {
        await getNotifications().notify(
          'integration',
          'Platform not fully recognised',
          `ROSE is running in generic mode on ${report.hostname}. Add a site configuration in Settings if detection misses your chat.`,
        );
      }
      return { ok: true, data: { accepted: true } };
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

    case MSG.ENABLE_SITE: {
      const { host } = (env.payload ?? {}) as { host?: string };
      if (!g.chrome?.permissions || !g.chrome?.scripting) {
        return { ok: false, error: 'This browser does not expose the permissions API.' };
      }
      return enableSite(g.chrome as never, host ?? '');
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
