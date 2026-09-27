import type { ClientMemory, QualityIssue, QualityReport, Suggestion } from '@/shared/types';
import { detectLanguage } from '@/core/translation/language';
import { fingerprint, similarity } from '@/shared/utils';

/**
 * ResponseQualityGuard — last line of defence before a suggestion is shown or
 * sent. It is intentionally deterministic (no model call) so it costs nothing
 * and cannot itself hallucinate.
 *
 * Checks, in order of severity:
 *   block: banned content, empty output
 *   warn:  duplicate of a recent reply, wrong language, ignored question
 *   info:  excessive length, likely contradiction with a known fact
 *
 * The guard never silently rewrites text; it reports issues and lets the caller
 * decide (regenerate, show a warning, or block sending).
 */

export interface GuardOptions {
  /** Language the reply is expected to be in ('auto' = mirror the client). */
  expectedLanguage: string;
  maxChars: number;
  /** Recent assistant replies to compare against for repetition. */
  recentReplies: string[];
  /** The message being answered — used for the ignored-question check. */
  incoming: string;
  incomingLanguage?: string;
}

const BANNED_PATTERNS: Array<{ re: RegExp; detail: string }> = [
  { re: /\b(?:underage|minor|child|loli|preteen|under\s*1[0-8])\b/i, detail: 'references a minor' },
  { re: /\b(?:rape|non-?consensual|forced sex)\b/i, detail: 'references non-consensual content' },
  { re: /\b(?:incest|bestiality)\b/i, detail: 'references prohibited content' },
  { re: /\b(?:as an ai|as a language model|i am an ai)\b/i, detail: 'breaks character by revealing it is an AI' },
  {
    re: /\b(?:send (?:me )?(?:money|crypto|btc|gift ?card|wire)|western union|bank details|my wallet address)\b/i,
    detail: 'requests money or payment details (scam pattern)',
  },
  { re: /<\s*script|javascript:/i, detail: 'contains executable markup' },
];

const QUESTION_STARTERS =
  /\b(who|what|when|where|why|which|how|do you|did you|are you|can you|will you|would you|have you|is it|qui|que|quoi|quand|où|pourquoi|comment|est-ce|tu es|vos|kto|chto|gde|kak|pochemu)\b/i;

export class ResponseQualityGuard {
  check(suggestion: Suggestion | string, memory: ClientMemory, opts: GuardOptions): QualityReport {
    const text = typeof suggestion === 'string' ? suggestion : suggestion.text;
    const issues: QualityIssue[] = [];
    const clean = text.trim();

    // --- block-level -------------------------------------------------------
    if (!clean) {
      return { ok: false, issues: [{ code: 'empty', severity: 'block', detail: 'empty suggestion' }], score: 0 };
    }

    for (const { re, detail } of BANNED_PATTERNS) {
      if (re.test(clean)) {
        issues.push({ code: 'banned-content', severity: 'block', detail });
      }
    }

    // --- warn-level --------------------------------------------------------
    const fp = fingerprint(clean);

    if (fp.length > 0) {
      const dupe = opts.recentReplies.find((prev) => {
        const prevFp = fingerprint(prev);
        if (!prevFp) return false;
        // 0.78 sits in the measured gap between a reworded/extended repeat
        // (>=0.83) and unrelated replies (<=0.53), so it catches the former
        // without merging genuinely different messages.
        return prevFp === fp || similarity(prev, clean) > 0.78;
      });
      if (dupe) {
        issues.push({
          code: 'duplicate',
          severity: 'warn',
          detail: `too similar to a recent reply: "${dupe.slice(0, 60)}"`,
        });
      }
    }

    // Repetition goes beyond whole-message similarity: a reply can be worded
    // differently yet still reuse the same opening, ask the same question, or
    // repeat the same emoji. Each is a distinct tell that the operator is
    // looking at a template rather than a person.
    if (opts.recentReplies.length) {
      const opening = repeatOpening(clean, opts.recentReplies);
      if (opening) {
        issues.push({
          code: 'repetition-opening',
          severity: 'warn',
          detail: `reuses the opening of a recent reply: "${opening.slice(0, 50)}"`,
        });
      }

      const repeatedQ = repeatQuestion(clean, opts.recentReplies);
      if (repeatedQ) {
        issues.push({
          code: 'repeated-question',
          severity: 'info',
          detail: `asks a question already asked: "${repeatedQ.slice(0, 60)}"`,
        });
      }

      const emoji = repeatedEmoji(clean, opts.recentReplies);
      if (emoji) {
        issues.push({
          code: 'repeated-emoji',
          severity: 'info',
          detail: `reuses the emoji ${emoji} from a recent reply`,
        });
      }
    }

    // Language check: only meaningful when we have real signal on both sides.
    const expected =
      opts.expectedLanguage === 'auto' ? opts.incomingLanguage ?? memory.language : opts.expectedLanguage;
    if (expected) {
      const guess = detectLanguage(clean);
      if (guess.confidence > 0.4 && guess.lang !== expected) {
        // Cyrillic/CJK replies to a Latin message are a strong mismatch; short
        // Latin replies are too ambiguous to flag.
        const strongMismatch = guess.confidence > 0.6;
        if (strongMismatch) {
          issues.push({
            code: 'wrong-language',
            severity: 'warn',
            detail: `reply looks like ${guess.lang} but ${expected} was expected`,
          });
        }
      }
    }

    // Ignored question: the client asked something and the reply contains no
    // answer-like content (no question mark, no matching keywords, very short).
    const incomingQuestions = (opts.incoming.match(/\?/g) ?? []).length;
    if (incomingQuestions > 0 && QUESTION_STARTERS.test(opts.incoming)) {
      const replyWords = clean.split(/\s+/).filter(Boolean).length;
      if (replyWords <= 2 && !/[?!]/.test(clean)) {
        issues.push({
          code: 'ignored-question',
          severity: 'warn',
          detail: 'the client asked a question but the reply does not answer it',
        });
      }
    }

    // --- info-level --------------------------------------------------------
    if (clean.length > opts.maxChars) {
      issues.push({
        code: 'too-long',
        severity: 'info',
        detail: `${clean.length} chars exceeds the ${opts.maxChars} char limit`,
      });
    }

    const contradiction = this.findContradiction(clean, memory);
    if (contradiction) {
      issues.push({ code: 'contradiction', severity: 'info', detail: contradiction });
    }

    const score = this.score(issues);
    const ok = !issues.some((i) => i.severity === 'block');
    return { ok, issues, score };
  }

  /**
   * Detects a reply that denies a fact the client already stated.
   * Deliberately narrow: only explicit "I don't know / no" phrasing near a known
   * fact keyword is flagged, to avoid false positives on normal chat.
   */
  private findContradiction(reply: string, memory: ClientMemory): string | null {
    const lower = reply.toLowerCase();
    const denial = /\b(i (?:don'?t|do not) (?:know|remember)|i (?:never|didn'?t) (?:say|tell)|no idea|never told me|je ne (?:sais pas|me souviens pas)|no recuerdo|ich wei(?:ß|ss) nicht)\b/i;
    if (!denial.test(lower)) return null;

    for (const fact of memory.importantFacts) {
      const key = fact.key.toLowerCase();
      if (key.length < 3) continue;
      if (lower.includes(key)) {
        return `reply denies a known fact ("${fact.key}") the client already stated`;
      }
    }
    return null;
  }

  private score(issues: QualityIssue[]): number {
    let score = 1;
    for (const i of issues) {
      if (i.severity === 'block') score -= 0.6;
      else if (i.severity === 'warn') score -= 0.22;
      else score -= 0.07;
    }
    return Math.max(0, Math.round(score * 100) / 100);
  }

  /**
   * Picks the best suggestion. Prefers one with no blocking issues and the
   * highest score, breaking ties by the caller's preferred kind order.
   */
  pickBest(
    suggestions: Suggestion[],
    memory: ClientMemory,
    opts: GuardOptions,
    preferredOrder: Suggestion['kind'][] = ['natural', 'warm', 'engaging'],
  ): { suggestion: Suggestion; report: QualityReport } | null {
    const scored = suggestions
      .map((s) => ({ suggestion: s, report: this.check(s, memory, opts) }))
      .filter((s) => s.report.ok);

    if (scored.length === 0) return null;

    scored.sort((a, b) => {
      if (b.report.score !== a.report.score) return b.report.score - a.report.score;
      const ai = preferredOrder.indexOf(a.suggestion.kind);
      const bi = preferredOrder.indexOf(b.suggestion.kind);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    return scored[0]!;
  }

  /** True when every suggestion should be regenerated instead of shown. */
  shouldRegenerate(reports: QualityReport[]): boolean {
    if (reports.length === 0) return true;
    const REPETITION: QualityIssue['code'][] = ['duplicate', 'repetition-opening', 'repeated-question'];
    return reports.every((r) => !r.ok || r.issues.some((i) => REPETITION.includes(i.code)));
  }
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/** First few words, normalised — the part a reader recognises as "the same". */
function openingOf(text: string, words = 3): string {
  return fingerprint(text).split(' ').slice(0, words).join(' ');
}

/**
 * Same opening as a recent reply. Four words (rather than three) is the measured
 * threshold: three-word matches fire on ordinary shared phrasing ("I am doing
 * well…"), while four catches the reused template without false positives.
 */
function repeatOpening(reply: string, recent: string[]): string | null {
  const opening = openingOf(reply, 4);
  if (opening.split(' ').length < 4) return null;
  for (const prev of recent) {
    if (openingOf(prev, 4) === opening) return prev;
  }
  return null;
}

/** A question in this reply that also appears in a recent reply. */
function repeatQuestion(reply: string, recent: string[]): string | null {
  const asked = reply.split(/(?<=[?!])/).filter((s) => s.includes('?'));
  if (!asked.length) return null;
  for (const q of asked) {
    const qf = fingerprint(q);
    if (qf.length < 4) continue;
    for (const prev of recent) {
      for (const prevQ of prev.split(/(?<=[?!])/)) {
        if (prevQ.includes('?') && similarity(prevQ, q) > 0.86) return q.trim();
      }
    }
  }
  return null;
}

/** The same emoji used in a recent reply — heavy-handed emoji recycling. */
function repeatedEmoji(reply: string, recent: string[]): string | null {
  const emojis = reply.match(EMOJI_RE);
  if (!emojis?.length) return null;
  for (const e of emojis) {
    if (recent.some((prev) => prev.includes(e))) return e;
  }
  return null;
}
