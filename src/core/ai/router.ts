import type { AIProviderConfig, AISettings, ResponseLength } from '@/shared/types';
import { estimateTokens, fingerprint } from '@/shared/utils';

/**
 * Model router + cost estimator.
 *
 * Cost control is a first-class requirement, so every AI call is classified
 * before it is sent:
 *
 *   - `trivial`  → greetings, emojis, acknowledgements. The fast/cheap model,
 *                  minimal prompt, and often no call at all (see shouldCallAI).
 *   - `simple`   → short factual exchanges. Fast model, compressed memory.
 *   - `complex`  → emotional, multi-part or long messages. Full model, full
 *                  memory, higher token budget.
 *
 * This is deliberately heuristic and local: classifying with an LLM would cost
 * more than it saves.
 */

export type TaskComplexity = 'trivial' | 'simple' | 'complex';

export type TaskKind = 'generation' | 'summary' | 'facts' | 'translation';

const GREETING_RE =
  /^(hi+|hey+|hello+|yo|hiya|sup|howdy|good (morning|evening|afternoon|night)|bonjour|salut|coucou|hola|hallo|ciao|olá|привет|приветик|прив|مرحبا|你好|こんにちは|안녕)[\s!.,?😊🙂👋❤️]*$/i;

const ACK_RE =
  /^(ok+|okay|k+|yes|yep|yeah|no|nope|sure|cool|nice|thanks?|thx|ty|thank you|merci|gracias|danke|grazie|спасибо|😊|😂|👍|❤️|\?+)[\s!.,?]*$/i;

export function classifyComplexity(text: string, historyLength = 0): TaskComplexity {
  const clean = text.trim();
  if (!clean) return 'trivial';

  // Emoji-only or single-token reactions never need the expensive model.
  const stripped = clean.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!.,?]/gu, '');
  if (stripped.length === 0) return 'trivial';
  if (GREETING_RE.test(clean)) return 'trivial';
  if (ACK_RE.test(clean)) return 'trivial';

  const words = clean.split(/\s+/).filter(Boolean).length;
  let score = 0;

  if (words > 12) score += 1;
  if (words > 30) score += 2;
  if (clean.length > 200) score += 1;
  if ((clean.match(/\?/g) ?? []).length > 1) score += 1;

  // Emotional / high-stakes language deserves the better model.
  if (
    /\b(feel|feeling|sorry|sad|love|miss|hurt|worried|afraid|angry|upset|lonely|honestly|seriously|relationship|jealous|trust|why did you|explain|sens|sentiment|triste|amour|peur|почему|чувств)\b/i.test(
      clean,
    )
  ) {
    score += 2;
  }

  // A brand-new conversation has no memory to lean on, so accuracy matters more.
  if (historyLength === 0) score += 1;

  if (score >= 3) return 'complex';
  if (score >= 1) return 'simple';
  return 'simple';
}

/**
 * Decides whether an AI call is justified at all.
 * Returns false for messages that a human would not need help answering, which
 * is the single biggest lever on token spend in practice.
 */
export function shouldCallAI(
  text: string,
  opts: { complexity: TaskComplexity; consecutiveTrivial: number; force?: boolean },
): { call: boolean; reason: string } {
  if (opts.force) return { call: true, reason: 'forced' };
  const clean = text.trim();
  if (!clean) return { call: false, reason: 'empty message' };
  if (fingerprint(clean).length === 0) return { call: false, reason: 'no linguistic content (emoji/reaction only)' };
  if (opts.complexity === 'trivial') {
    return { call: false, reason: 'trivial message — a scripted short reply is sufficient' };
  }
  // A long run of one-word replies means the other side is not engaging; do not
  // burn tokens on it.
  if (opts.consecutiveTrivial >= 4) {
    return { call: false, reason: 'several low-content messages in a row' };
  }
  return { call: true, reason: 'worth generating' };
}

/** Local fallbacks so trivial messages still get a natural reply. */
const TRIVIAL_REPLIES: Record<string, string[]> = {
  en: ['Hey! 😊', 'Hi there!', 'Hello! How are you?', 'Hey, good to hear from you!'],
  fr: ['Coucou ! 😊', 'Salut !', 'Bonjour ! Comment vas-tu ?', 'Hey, content de te lire !'],
  es: ['¡Hola! 😊', '¡Hey!', '¡Hola! ¿Cómo estás?'],
  de: ['Hallo! 😊', 'Hey!', 'Hallo! Wie geht es dir?'],
  it: ['Ciao! 😊', 'Ehi!', 'Ciao! Come stai?'],
  pt: ['Olá! 😊', 'Oi!', 'Olá! Como você está?'],
  ru: ['Привет! 😊', 'Привет!', 'Привет! Как дела?'],
  nl: ['Hoi! 😊', 'Hey!', 'Hallo! Hoe gaat het?'],
  pl: ['Cześć! 😊', 'Hej!', 'Cześć! Jak się masz?'],
  tr: ['Merhaba! 😊', 'Selam!', 'Merhaba! Nasılsın?'],
};

export function localReply(lang: string, seed: string): string {
  const pool = TRIVIAL_REPLIES[lang] ?? TRIVIAL_REPLIES.en!;
  // Deterministic pick keeps behaviour reproducible in tests.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return pool[h % pool.length]!;
}

/** Token budget per task, scaled by the requested reply length. */
export function tokenBudget(kind: TaskKind, complexity: TaskComplexity, length: ResponseLength): number {
  if (kind === 'summary') return 260;
  if (kind === 'facts') return 200;
  if (kind === 'translation') return 320;
  const base = complexity === 'complex' ? 480 : 260;
  const scale = length === 'short' ? 0.55 : length === 'long' ? 1.4 : 1;
  return Math.round(base * scale);
}

/** Chooses which configured model to use for a task. */
export function pickModel(config: AIProviderConfig, kind: TaskKind, complexity: TaskComplexity): string {
  if (kind === 'summary' || kind === 'facts') return config.fastModel || config.model;
  if (complexity === 'trivial' || complexity === 'simple') return config.fastModel || config.model;
  return config.model;
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** USD per 1M tokens: [prompt, completion]. Indicative list prices. */
const PRICING: Array<{ match: RegExp; prompt: number; completion: number }> = [
  { match: /gpt-4o-mini/i, prompt: 0.15, completion: 0.6 },
  { match: /gpt-4o(?!-mini)/i, prompt: 2.5, completion: 10 },
  { match: /gpt-4\.1-mini/i, prompt: 0.4, completion: 1.6 },
  { match: /gpt-3\.5/i, prompt: 0.5, completion: 1.5 },
  { match: /llama-3\.1-8b|llama-3\.3-70b/i, prompt: 0.59, completion: 0.79 },
  { match: /llama-3\.1-8b-instant/i, prompt: 0.05, completion: 0.08 },
  { match: /llama-3\.3-70b-versatile/i, prompt: 0.59, completion: 0.79 },
  { match: /mixtral|mistral/i, prompt: 0.24, completion: 0.24 },
  { match: /claude-3-5-haiku/i, prompt: 0.8, completion: 4 },
  { match: /claude-3-5-sonnet/i, prompt: 3, completion: 15 },
  { match: /gemini-1\.5-flash/i, prompt: 0.075, completion: 0.3 },
  { match: /gemini-1\.5-pro/i, prompt: 1.25, completion: 5 },
  { match: /gemini-2/i, prompt: 0.1, completion: 0.4 },
];

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const entry = PRICING.find((p) => p.match.test(model));
  if (!entry) return 0; // unknown model → do not invent a number
  const cost = (promptTokens / 1_000_000) * entry.prompt + (completionTokens / 1_000_000) * entry.completion;
  return Math.round(cost * 1e6) / 1e6;
}

export function hasKnownPricing(model: string): boolean {
  return PRICING.some((p) => p.match.test(model));
}

/** Local estimate of a prompt's size, used before sending to gate spend. */
export function estimatePromptTokens(system: string, user: string): number {
  return estimateTokens(system) + estimateTokens(user);
}

/**
 * Resolves the provider to use, or null when none is usable.
 *
 * Returning null rather than a partially-configured provider keeps the failure
 * at the boundary: callers surface a clear reason instead of attempting a
 * request that cannot succeed.
 */
export function chooseProvider(ai: AISettings): AIProviderConfig | null {
  const provider = ai.providers.find((p: AIProviderConfig) => p.id === ai.activeProvider);
  if (!provider || !provider.enabled) return null;
  return provider;
}
