import type {
  AIProviderConfig,
  GenerationRequest,
  GenerationResult,
  Suggestion,
  SuggestionKind,
} from '@/shared/types';
import { log } from '@/core/logging/logger';
import { extractJson, fingerprint, normaliseText, truncate } from '@/shared/utils';
import { AIClient, AIError } from './client';
import { ResponseCache, cacheKey } from './cache';
import { buildFactExtractionPrompt, buildGenerationPrompt, buildSummaryPrompt, buildTranslationPrompt } from './prompts';
import {
  classifyComplexity,
  estimateCostUsd,
  localReply,
  pickModel,
  tokenBudget,
  type TaskComplexity,
} from './router';
import { detectLanguage } from '@/core/translation/language';

export interface GenerationDeps {
  getActiveProvider: () => Promise<AIProviderConfig>;
  getApiKey: (providerId: string) => Promise<string>;
  /** Records token/cost usage for the dashboard. */
  onUsage?: (u: {
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    kind: string;
    conversationId?: string;
  }) => void;
}

const VALID_KINDS: SuggestionKind[] = ['natural', 'warm', 'engaging'];

/**
 * GenerationService — turns a detected message + memory into reply suggestions.
 *
 * Pipeline: classify → cache lookup → build prompt → call model → parse →
 * validate → (optional) quality retry. Everything expensive is gated by the
 * router so a "hey" does not cost a full GPT-4o call.
 */
export class GenerationService {
  readonly cache = new ResponseCache<Omit<GenerationResult, 'cached'>>(120_000, 200);
  private client: AIClient;

  constructor(private readonly deps: GenerationDeps) {
    this.client = new AIClient(deps.getActiveProvider, deps.getApiKey);
  }

  /**
   * Generates suggestions. `force` bypasses the cache (Regenerate button).
   */
  async generate(
    req: GenerationRequest,
    opts: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<GenerationResult> {
    const provider = await this.deps.getActiveProvider();
    const complexity = classifyComplexity(req.incoming, req.history.length);
    const model = pickModel(provider, 'generation', complexity);

    const key = cacheKey({
      conversationId: req.conversation.id,
      incoming: req.incoming,
      style: req.style,
      length: req.length,
      language: req.targetLanguage,
      count: req.count,
    });

    // Trivial messages never reach the provider: a local scripted reply is both
    // faster and free, and it matches what a human would actually send.
    if (complexity === 'trivial' && !opts.force) {
      const lang = req.memory.language ?? detectLanguage(req.incoming).lang;
      const text = localReply(lang, req.incoming);
      const suggestions = this.buildTrivialSuggestions(text, lang);
      log.info('ai', 'trivial message handled locally (0 tokens)', { reason: complexity });
      return {
        suggestions,
        provider: provider.id,
        model: 'local',
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        cached: false,
      };
    }

    const { value, cached } = await this.cache.resolve(
      key,
      () => this.callProvider(req, provider, model, complexity, opts.signal),
      opts.force,
    );

    if (cached) log.info('ai', 'cache hit — 0 tokens spent', { conversationId: req.conversation.id });
    return { ...value, cached };
  }

  private async callProvider(
    req: GenerationRequest,
    provider: AIProviderConfig,
    model: string,
    complexity: TaskComplexity,
    signal?: AbortSignal,
  ): Promise<Omit<GenerationResult, 'cached'>> {
    const prompt = buildGenerationPrompt(req);
    const started = Date.now();
    log.info('ai', 'request started', {
      model,
      complexity,
      conversationId: req.conversation.id,
      approxChars: prompt.approxChars,
    });

    const res = await this.client.complete({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      model,
      maxTokens: tokenBudget('generation', complexity, req.length),
      json: true,
      signal,
    });

    let suggestions = this.parseSuggestions(res.text, req.count);

    // Some models ignore response_format and wrap JSON in prose; retry once
    // without the JSON constraint rather than failing the user's request.
    if (suggestions.length === 0) {
      log.warn('ai', 'unparseable JSON response; retrying in plain-text mode');
      const retry = await this.client.complete({
        messages: [
          { role: 'system', content: `${prompt.system}\n\nReturn the raw JSON object only.` },
          { role: 'user', content: prompt.user },
        ],
        model,
        maxTokens: tokenBudget('generation', complexity, req.length),
        json: false,
        signal,
      });
      suggestions = this.parseSuggestions(retry.text, req.count);
    }

    if (suggestions.length === 0) {
      throw new AIError('The model did not return usable suggestions. Try Regenerate.', 'bad-response');
    }

    const lang = req.targetLanguage === 'auto'
      ? req.memory.language ?? detectLanguage(req.incoming).lang
      : req.targetLanguage;
    suggestions = suggestions.map((s) => ({ ...s, lang }));

    const costUsd = estimateCostUsd(res.model, res.promptTokens, res.completionTokens);
    this.deps.onUsage?.({
      provider: provider.id,
      model: res.model,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      costUsd,
      kind: 'generation',
      conversationId: req.conversation.id,
    });

    log.info('ai', 'response received', {
      model: res.model,
      latencyMs: res.latencyMs,
      suggestions: suggestions.length,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      costUsd,
    });

    return {
      suggestions,
      provider: provider.id,
      model: res.model,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      latencyMs: res.latencyMs,
    };
  }

  /** Tolerant parser: handles strict JSON, fenced JSON, arrays and bare strings. */
  parseSuggestions(raw: string, count: number): Suggestion[] {
    const out: Suggestion[] = [];
    const push = (kind: SuggestionKind, text: string) => {
      const clean = normaliseText(text).replace(/^["']|["']$/g, '');
      if (!clean) return;
      if (out.some((s) => fingerprint(s.text) === fingerprint(clean))) return;
      out.push({ kind, text: clean, lang: 'en' });
    };

    const parsed = extractJson<any>(raw);

    if (Array.isArray(parsed)) {
      parsed.forEach((item, i) => {
        if (typeof item === 'string') push(VALID_KINDS[i % 3]!, item);
        else if (item?.text) push(normaliseKind(item.kind) ?? VALID_KINDS[i % 3]!, String(item.text));
      });
    } else if (parsed && typeof parsed === 'object') {
      const list = parsed.suggestions ?? parsed.replies ?? parsed.responses;
      if (Array.isArray(list)) {
        list.forEach((item: any, i: number) => {
          if (typeof item === 'string') push(VALID_KINDS[i % 3]!, item);
          else if (item?.text) push(normaliseKind(item.kind) ?? VALID_KINDS[i % 3]!, String(item.text));
        });
      } else {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.trim()) push(normaliseKind(k) ?? VALID_KINDS[out.length % 3]!, v);
        }
      }
    }

    // Last resort: numbered or line-separated plain text.
    if (out.length === 0) {
      const lines = raw
        .split('\n')
        .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
        .filter((l) => l.length > 1 && !/^```/.test(l) && !/^[{}[\]]/.test(l));
      lines.slice(0, count).forEach((l, i) => push(VALID_KINDS[i % 3]!, l));
    }

    return out.slice(0, Math.max(1, count));
  }

  /** Trivial replies still get three tonal variants so the UI stays consistent. */
  private buildTrivialSuggestions(base: string, lang: string): Suggestion[] {
    const bare = base.replace(/[\s😊🙂👋]+$/u, '');
    return [
      { kind: 'natural', text: base, lang },
      { kind: 'warm', text: `${bare}! 😊`, lang },
      { kind: 'engaging', text: `${bare}! How's your day going?`, lang },
    ];
  }

  // -------------------------------------------------------------------------
  // Secondary tasks (summary / facts / translation)
  // -------------------------------------------------------------------------

  async summarize(
    summaryPrompt: { system: string; user: string },
    complexity: TaskComplexity = 'simple',
  ): Promise<{ text: string; promptTokens: number; completionTokens: number; model: string } | null> {
    const provider = await this.deps.getActiveProvider();
    const model = pickModel(provider, 'summary', complexity);
    try {
      const res = await this.client.complete({
        messages: [
          { role: 'system', content: summaryPrompt.system },
          { role: 'user', content: summaryPrompt.user },
        ],
        model,
        maxTokens: tokenBudget('summary', complexity, 'medium'),
        temperature: 0.3,
      });
      this.deps.onUsage?.({
        provider: provider.id,
        model: res.model,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        costUsd: estimateCostUsd(res.model, res.promptTokens, res.completionTokens),
        kind: 'summary',
      });
      return {
        text: truncate(normaliseText(res.text), 1200),
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        model: res.model,
      };
    } catch (err) {
      log.warn('ai', 'summarisation failed (non-fatal)', err);
      return null;
    }
  }

  async extractFacts(
    message: string,
    existing: string[],
  ): Promise<Array<{ key: string; value: string; weight: number }>> {
    const provider = await this.deps.getActiveProvider();
    const model = pickModel(provider, 'facts', 'simple');
    const prompt = buildFactExtractionPrompt(message, existing);
    try {
      const res = await this.client.complete({
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        model,
        maxTokens: tokenBudget('facts', 'simple', 'short'),
        temperature: 0.1,
        json: true,
      });
      this.deps.onUsage?.({
        provider: provider.id,
        model: res.model,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        costUsd: estimateCostUsd(res.model, res.promptTokens, res.completionTokens),
        kind: 'facts',
      });
      const parsed = extractJson<any>(res.text);
      const list = Array.isArray(parsed) ? parsed : (parsed?.facts ?? []);
      return (list as any[])
        .filter((f) => f && typeof f.key === 'string' && typeof f.value === 'string')
        .map((f) => ({
          key: String(f.key).slice(0, 60),
          value: String(f.value).slice(0, 300),
          weight: typeof f.weight === 'number' ? Math.max(0, Math.min(1, f.weight)) : 0.5,
        }))
        .slice(0, 8);
    } catch (err) {
      log.warn('ai', 'fact extraction failed (non-fatal)', err);
      return [];
    }
  }

  async translate(text: string, targetLang: string, tone: string): Promise<string | null> {
    const provider = await this.deps.getActiveProvider();
    const model = pickModel(provider, 'translation', 'simple');
    const prompt = buildTranslationPrompt(text, targetLang, tone);
    try {
      const res = await this.client.complete({
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        model,
        maxTokens: tokenBudget('translation', 'simple', 'medium'),
        temperature: 0.2,
      });
      this.deps.onUsage?.({
        provider: provider.id,
        model: res.model,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        costUsd: estimateCostUsd(res.model, res.promptTokens, res.completionTokens),
        kind: 'translation',
      });
      return normaliseText(res.text) || null;
    } catch (err) {
      log.warn('ai', 'translation failed', err);
      return null;
    }
  }

  async testConnection() {
    return this.client.testConnection();
  }
}

function normaliseKind(kind: unknown): SuggestionKind | null {
  if (typeof kind !== 'string') return null;
  const k = kind.toLowerCase().trim();
  if (VALID_KINDS.includes(k as SuggestionKind)) return k as SuggestionKind;
  if (/natur|normal|plain/.test(k)) return 'natural';
  if (/warm|affection|tender|flirt/.test(k)) return 'warm';
  if (/engag|question|hook|play/.test(k)) return 'engaging';
  return null;
}
