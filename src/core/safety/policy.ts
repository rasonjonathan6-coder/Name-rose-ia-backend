import type { RoseSettings } from '@/shared/types';
import { chooseProvider } from '@/core/ai/router';

/**
 * Policy + rate-limit layer.
 *
 * Two responsibilities:
 *  1. Consent gate — AI features stay inert until the user explicitly
 *     acknowledges the usage policy. This prevents the extension from making
 *     outbound API calls (and spending money) before the user has opted in.
 *  2. Rate limiting — bounds automation so ROSE can never become a spam tool,
 *     which is both a platform-rules requirement and an abuse safeguard.
 */

export interface PolicyCheck {
  allowed: boolean;
  reason?: string;
}

/** Features that require an acknowledged policy before they will run. */
export function canUseAI(settings: RoseSettings): PolicyCheck {
  if (!settings.ai.acknowledgedPolicy) {
    return {
      allowed: false,
      reason: 'AI features are disabled until you acknowledge the usage policy in Settings → AI.',
    };
  }
  const provider = chooseProvider(settings.ai);
  if (!provider) {
    const configured = settings.ai.providers.find((p) => p.id === settings.ai.activeProvider);
    if (configured) {
      // `label` is optional, so fall back to the id rather than leaking
      // `undefined` into an error the operator has to read.
      return { allowed: false, reason: `Provider "${configured.label ?? configured.id}" is disabled.` };
    }
    return {
      allowed: false,
      reason: `Active AI provider "${settings.ai.activeProvider}" is not configured.`,
    };
  }
  return { allowed: true };
}

export function canUseAutomation(settings: RoseSettings): PolicyCheck {
  const ai = canUseAI(settings);
  if (!ai.allowed) return ai;
  if (!settings.automation.globalEnabled) {
    return { allowed: false, reason: 'Automation is switched off.' };
  }
  if (settings.automation.globalPaused) {
    return { allowed: false, reason: 'ROSE is paused.' };
  }
  return { allowed: true };
}

/**
 * Rolling-window rate limiter, per key.
 * Used to cap auto-sent replies per conversation per hour.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  private limit: number;

  constructor(limit: number, private readonly windowMs = 3_600_000) {
    this.limit = limit;
  }

  /** Returns true when the action is allowed, and records it. */
  tryConsume(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  remaining(key: string, now = Date.now()): number {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    return Math.max(0, this.limit - list.length);
  }

  reset(key?: string): void {
    if (key) this.hits.delete(key);
    else this.hits.clear();
  }

  /** Retunes the limit when settings change at runtime. */
  setLimit(limit: number): void {
    this.limit = Math.max(0, limit);
  }
}

/**
 * Enforces a minimum gap between automated sends so bursts cannot happen even
 * when several messages arrive at once.
 */
export class CooldownGate {
  private last = new Map<string, number>();

  private cooldownMs: number;

  constructor(cooldownMs: number) {
    this.cooldownMs = cooldownMs;
  }

  /**
   * A key that has never been marked is always ready. Checking `now - prev >=
   * cooldownMs` against a sentinel of 0 would wrongly block any key before the
   * first mark whenever the clock is smaller than the cooldown (and would break
   * entirely for injected/faked clocks), so presence is tracked explicitly.
   */
  ready(key: string, now = Date.now()): boolean {
    const prev = this.last.get(key);
    if (prev === undefined) return true;
    return now - prev >= this.cooldownMs;
  }

  mark(key: string, now = Date.now()): void {
    this.last.set(key, now);
  }

  msUntilReady(key: string, now = Date.now()): number {
    const prev = this.last.get(key);
    if (prev === undefined) return 0;
    return Math.max(0, this.cooldownMs - (now - prev));
  }

  reset(): void {
    this.last.clear();
  }

  setCooldown(ms: number): void {
    this.cooldownMs = Math.max(0, ms);
  }
}

/**
 * Detects content that must never be auto-sent, regardless of mode.
 * This is a hard block applied in addition to the quality guard.
 */
export function isAutoSendBlocked(text: string): PolicyCheck {
  const checks: Array<[RegExp, string]> = [
    [
      /\b(?:send (?:me )?(?:money|crypto|btc|bitcoin|gift ?card|wire transfer)|western union|bank account|credit card number|my wallet)\b/i,
      'message asks for money or payment details — blocked from automatic sending',
    ],
    [/\b(?:underage|minor|child|loli|preteen)\b/i, 'message references a minor — blocked'],
    [/\b(?:rape|non-?consensual|incest|bestiality)\b/i, 'message references prohibited content — blocked'],
    [/\b(?:whatsapp|telegram|snap(?:chat)?|kik|skype)\b\s*[:\-]?\s*[\w@+]{4,}/i, 'message shares an off-platform contact — blocked'],
  ];
  for (const [re, reason] of checks) {
    if (re.test(text)) return { allowed: false, reason };
  }
  return { allowed: true };
}

/**
 * Redacts secrets and PII before anything is written to persistent logs or
 * exported for diagnostics.
 */
export function sanitiseForExport(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\b(sk|sk-or|gsk|xai|AIza)[-_A-Za-z0-9]{16,}\b/g, '***REDACTED_KEY***')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '***@***')
      .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, '***PHONE***');
  }
  if (Array.isArray(value)) return value.map(sanitiseForExport);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/apiKey|token|secret|password|authorization/i.test(k)) out[k] = '***';
      else out[k] = sanitiseForExport(v);
    }
    return out;
  }
  return value;
}
