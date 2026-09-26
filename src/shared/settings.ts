import type { RoseSettings } from './types';

/**
 * Default settings.
 *
 * Safety posture is deliberate: automation starts in `manual`, memory is local
 * only, and no API key ships with the extension. The user must supply their own
 * key or point ROSE at their own backend proxy.
 */
export const DEFAULT_SETTINGS: RoseSettings = {
  ai: {
    activeProvider: 'openrouter',
    providers: [
      {
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: 'openai/gpt-4o-mini',
        fastModel: 'meta-llama/llama-3.1-8b-instruct',
        temperature: 0.85,
        maxTokens: 320,
        enabled: true,
        viaProxy: false,
      },
      {
        id: 'openai',
        label: 'OpenAI-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        fastModel: 'gpt-4o-mini',
        temperature: 0.85,
        maxTokens: 320,
        enabled: true,
        viaProxy: false,
      },
      {
        id: 'groq',
        label: 'Groq (fast/cheap)',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: '',
        model: 'llama-3.3-70b-versatile',
        fastModel: 'llama-3.1-8b-instant',
        temperature: 0.85,
        maxTokens: 320,
        enabled: true,
        viaProxy: false,
      },
      {
        id: 'rose-backend',
        label: 'ROSE Backend (secure proxy)',
        baseUrl: 'http://localhost:8787/v1',
        apiKey: '',
        model: 'rose-default',
        fastModel: 'rose-fast',
        temperature: 0.85,
        maxTokens: 320,
        enabled: false,
        viaProxy: true,
      },
      {
        // A real, keyless OpenAI-compatible endpoint. It exists so the full
        // pipeline can be exercised against a genuine model without shipping or
        // handling anyone's credential; keep it disabled by default.
        id: 'pollinations',
        label: 'Pollinations (keyless, for testing)',
        baseUrl: 'https://text.pollinations.ai/openai',
        apiKey: '',
        model: 'openai',
        fastModel: 'openai',
        temperature: 0.85,
        maxTokens: 320,
        enabled: false,
        viaProxy: false,
        requiresKey: false,
      },
    ],
    maxResponseChars: 600,
    allowNSFW: false,
    acknowledgedPolicy: false,
  },
  conversation: {
    style: 'natural',
    customStyle: '',
    length: 'medium',
    suggestionCount: 3,
    targetLanguage: 'auto',
    autoDetectLanguage: true,
  },
  automation: {
    mode: 'manual',
    globalEnabled: false,
    globalPaused: false,
    pausedPlatforms: [],
    pausedConversations: [],
    replyDelayMs: 4000,
    maxAutoMessagesPerHour: 20,
    inactivityMinutes: 10,
    followUpsEnabled: false,
    maxFollowUps: 1,
  },
  memory: {
    enabled: true,
    retentionDays: 90,
    maxRecentMessages: 12,
    autoSummarizeAfter: 20,
  },
  translation: {
    enabled: true,
    autoTranslateIncoming: true,
    myLanguage: 'fr',
    showFlagBadges: true,
  },
  appearance: {
    theme: 'dark',
    opacity: 0.97,
    scale: 1,
    position: null,
    collapsed: false,
    accent: 'violet',
  },
  notifications: {
    enabled: true,
    onNewMessage: false,
    onReplyReady: true,
    onError: true,
    onCreditsLow: true,
    minIntervalMs: 60_000,
  },
  liveCall: {
    enabled: false,
    autoStart: false,
    language: 'en-US',
    showInterim: true,
  },
  debug: {
    enabled: false,
    verbose: false,
    showOverlay: false,
  },
  platforms: [],
};

/** Deep-merges stored settings over the defaults so new keys appear on upgrade. */
export function mergeSettings(stored: unknown): RoseSettings {
  return normalizeSettings(deepMerge(structuredClone(DEFAULT_SETTINGS), stored) as RoseSettings);
}

/**
 * Repairs settings that arrived without every field.
 *
 * Settings can be hand-edited, imported from an older build, or synced from
 * another device, and `deepMerge` only fills gaps for keys it knows about. An
 * imported provider without `temperature` used to crash the Options page on
 * `undefined.toFixed()` and send `temperature: undefined` to the provider, so
 * numeric fields are coerced here rather than trusted downstream.
 */
export function normalizeSettings(settings: RoseSettings): RoseSettings {
  const num = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  settings.ai.providers = (settings.ai.providers ?? []).map((p) => ({
    ...p,
    // Providers are shown by label in every error message and in the Options
    // list. A provider synced from an older build can arrive without one, which
    // surfaced as 'Provider "undefined" is disabled.' Fall back to the id.
    label: typeof p.label === 'string' && p.label.trim() ? p.label : String(p.id ?? 'Provider'),
    temperature: num(p.temperature, 0.85, 0, 2),
    maxTokens: Math.round(num(p.maxTokens, 320, 1, 32_000)),
  }));
  settings.ai.maxResponseChars = Math.round(num(settings.ai.maxResponseChars, 600, 40, 4_000));
  settings.conversation.suggestionCount = Math.round(num(settings.conversation.suggestionCount, 3, 1, 5));
  return settings;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) {
    return (patch === undefined ? base : (patch as T)) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value;
  }
  return out as T;
}
