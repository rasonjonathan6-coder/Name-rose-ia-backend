import type { AIProviderConfig } from '@/shared/types';
import { log } from '@/core/logging/logger';
import { estimateTokens, extractJson, sleep } from '@/shared/utils';

/**
 * HTTP client for OpenAI-compatible chat-completion endpoints.
 *
 * Works with OpenAI, OpenRouter, Groq, Google's OpenAI-compat endpoint, and a
 * self-hosted ROSE backend that proxies the same shape.
 *
 * Security notes:
 *  - The API key never leaves this module except as an Authorization header.
 *  - Keys are read from the dedicated secrets namespace, not from settings.
 *  - No key is ever logged; the logger redacts `key|token|secret` fields.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider to constrain output to JSON. */
  json?: boolean;
  /** Abort after this many ms (default 30s). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Extra top-level fields merged into the request body. Used to pass routing
   * hints (`rose_task`, `rose_complex`) to the ROSE backend so it can pick a
   * model role without parsing the prompt. Ignored by a provider that does not
   * know the field.
   */
  extra?: Record<string, unknown>;
  /**
   * Leave `model` out of the request body entirely. Used with the ROSE backend,
   * which selects the model from its own role configuration — sending the
   * extension's placeholder would override that selection.
   */
  omitModel?: boolean;
}

export interface CompletionResponse {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  finishReason: string | null;
}

export class AIError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'no-key'
      | 'unauthorized'
      | 'rate-limited'
      | 'credits'
      | 'timeout'
      | 'network'
      | 'bad-response'
      | 'aborted'
      | 'server',
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AIError';
  }
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class AIClient {
  constructor(
    private readonly getConfig: () => Promise<AIProviderConfig>,
    private readonly getApiKey: (providerId: string) => Promise<string>,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const config = await this.getConfig();
    const apiKey = await this.getApiKey(config.id);

    // A proxy backend holds the key server-side, so a missing local key is
    // fine. Neither is a key required for an endpoint that has none (a local
    // model, or a keyless test endpoint) — asking for a credential there would
    // block a provider that works perfectly well without one.
    if (!apiKey && !config.viaProxy && config.requiresKey !== false) {
      throw new AIError(
        `No API key configured for provider "${config.label}". Open ROSE settings → AI to add one.`,
        'no-key',
      );
    }

    const started = Date.now();
    const maxAttempts = 3;
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.requestOnce(config, apiKey, req);
        return { ...res, latencyMs: Date.now() - started };
      } catch (err) {
        lastErr = err;
        const isAbort = err instanceof AIError && err.code === 'aborted';
        if (isAbort || !(err instanceof AIError) || !err.retryable || attempt === maxAttempts) break;
        // Exponential backoff with jitter — respects provider rate limits.
        const backoff = Math.min(8000, 400 * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
        log.warn('ai', `retry ${attempt}/${maxAttempts - 1} after ${Math.round(backoff)}ms (${err.code})`);
        await sleep(backoff);
      }
    }
    throw lastErr instanceof Error ? lastErr : new AIError('AI request failed', 'network');
  }

  private async requestOnce(
    config: AIProviderConfig,
    apiKey: string,
    req: CompletionRequest,
  ): Promise<Omit<CompletionResponse, 'latencyMs'>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 30_000);
    const onOuterAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onOuterAbort, { once: true });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (config.id === 'openrouter') {
      // OpenRouter attributes usage to the calling app via these headers.
      headers['HTTP-Referer'] = 'https://github.com/rose-ia';
      headers['X-Title'] = 'ROSE IA';
    }

    const body: Record<string, unknown> = {
      messages: req.messages,
      temperature: req.temperature ?? config.temperature,
      max_tokens: req.maxTokens ?? config.maxTokens,
    };
    if (!req.omitModel) body.model = req.model ?? config.model;
    if (req.json) body.response_format = { type: 'json_object' };
    if (req.extra) Object.assign(body, req.extra);

    let res: Response;
    try {
      res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      req.signal?.removeEventListener('abort', onOuterAbort);
      if ((err as Error)?.name === 'AbortError') {
        throw new AIError(
          req.signal?.aborted ? 'Request cancelled' : 'AI request timed out',
          req.signal?.aborted ? 'aborted' : 'timeout',
          undefined,
          !req.signal?.aborted,
        );
      }
      throw new AIError(`Network error contacting ${config.label}`, 'network', undefined, true);
    }
    clearTimeout(timeout);
    req.signal?.removeEventListener('abort', onOuterAbort);

    if (!res.ok) {
      const detail = await readErrorBody(res);
      const retryable = RETRY_STATUSES.has(res.status);
      if (res.status === 401 || res.status === 403) {
        throw new AIError(`Invalid or unauthorised API key for ${config.label}. ${detail}`, 'unauthorized', res.status);
      }
      if (res.status === 402) {
        throw new AIError(`Insufficient credits on ${config.label}. ${detail}`, 'credits', res.status);
      }
      if (res.status === 429) {
        throw new AIError(`Rate limited by ${config.label}. ${detail}`, 'rate-limited', res.status, true);
      }
      if (res.status >= 500) {
        throw new AIError(`${config.label} server error (${res.status}). ${detail}`, 'server', res.status, true);
      }
      throw new AIError(`${config.label} error ${res.status}. ${detail}`, 'bad-response', res.status);
    }

    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new AIError('Malformed JSON from provider', 'bad-response');
    }

    const choice = json?.choices?.[0];
    const text: string =
      choice?.message?.content ??
      choice?.text ??
      (typeof json?.content === 'string' ? json.content : '');
    if (typeof text !== 'string') {
      throw new AIError('Provider returned no text content', 'bad-response');
    }
    // An empty completion is not a valid reply: it happens when a provider
    // filters the content, truncates before any token, or returns a malformed
    // shape. Treating it as success would surface as an unexplained empty
    // suggestion list, so it is reported as a bad response instead.
    if (text.trim().length === 0) {
      const reason = choice?.finish_reason ? ` (finish reason: ${choice.finish_reason})` : '';
      throw new AIError(`Provider returned an empty completion${reason}`, 'bad-response');
    }

    const usage = json?.usage ?? {};
    return {
      text: text.trim(),
      model: json?.model ?? body.model,
      promptTokens: usage.prompt_tokens ?? estimateTokens(req.messages.map((m) => m.content).join(' ')),
      completionTokens: usage.completion_tokens ?? estimateTokens(text),
      finishReason: choice?.finish_reason ?? null,
    };
  }

  /** Cheap connectivity + credential check used by the Settings page. */
  async testConnection(): Promise<{ ok: boolean; model?: string; error?: string; latencyMs: number }> {
    const started = Date.now();
    try {
      const res = await this.complete({
        messages: [
          { role: 'system', content: 'Reply with the single word: ok' },
          { role: 'user', content: 'ping' },
        ],
        maxTokens: 8,
        temperature: 0,
        timeoutMs: 15_000,
      });
      return { ok: true, model: res.model, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const raw = await res.text();
    if (!raw) return '';
    const parsed = extractJson<{ error?: { message?: string } | string }>(raw);
    const msg =
      typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? raw.slice(0, 300);
    return String(msg).slice(0, 300);
  } catch {
    return '';
  }
}
