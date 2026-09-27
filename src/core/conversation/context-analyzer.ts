import type { ClientMemory, StoredMessage } from '@/shared/types';
import { detectLanguage, isAmbiguous } from '@/core/translation/language';
import { normaliseText, fingerprint } from '@/shared/utils';
import type { Understanding } from './engine';

/**
 * ContextAnalyzer — turns the raw conversation state into the structured context
 * the prompt layer and the router consume.
 *
 * The analysis is deterministic and free (no model call). It never invents a
 * value: anything the caller did not supply and the heuristics cannot read is
 * reported as `null` / `unknown`, so a downstream prompt can distinguish "the
 * client did not say" from "we guessed wrong".
 */

export interface ContextMessage {
  role: 'client' | 'assistant';
  text: string;
}

export interface AnalyzedContext {
  language: string;
  languageConfidence: number;
  /** null when the adapter could not resolve a name (never a placeholder). */
  clientName: string | null;
  recentMessages: ContextMessage[];
  /** Last durable topic tagged on the record, or null when none is known. */
  conversationTopic: string | null;
  detectedIntent: Understanding['intent'];
  tone: Understanding['tone'];
  importantFacts: Array<{ key: string; value: string }>;
  /** Client questions still standing — asked, never answered since. */
  unansweredQuestions: string[];
  recentAssistantResponses: string[];
  conversationLength: 'short' | 'medium' | 'long';
  /** True when the message introduces vocabulary the record has not seen. */
  isNewTopic: boolean;
  hasQuestion: boolean;
  questions: string[];
  /** Concrete signals, surfaced in the debug panel. Never model-generated. */
  notes: string[];
}

export interface AnalyzeOptions {
  /** How many history turns to hand to the prompt. */
  windowSize?: number;
  /** How many assistant replies count as "recent" for repetition checks. */
  recentReplies?: number;
}

export class ContextAnalyzer {
  constructor(private readonly maxWindow = 10) {}

  analyze(
    understanding: Understanding,
    memory: ClientMemory,
    history: StoredMessage[],
    opts: AnalyzeOptions = {},
  ): AnalyzedContext {
    const windowSize = opts.windowSize ?? this.maxWindow;
    const recentReplies = opts.recentReplies ?? 6;

    const notes: string[] = [];
    const window = history.slice(-windowSize);

    const language = this.resolveLanguage(understanding, memory, notes);
    const recentAssistantResponses = window
      .filter((m) => m.role === 'assistant')
      .slice(-recentReplies)
      .map((m) => m.text);

    const unansweredQuestions = this.findUnansweredQuestions(window, understanding);
    if (unansweredQuestions.length) {
      notes.push(`${unansweredQuestions.length} unanswered question(s) carried over`);
    }

    const isNewTopic = this.detectNewTopic(understanding.incoming, memory);
    if (isNewTopic) notes.push('message introduces a topic absent from memory');

    const conversationLength = this.lengthOf(memory.metadata.messageCount);
    const clientName =
      memory.displayName && memory.displayName !== 'Unknown' ? memory.displayName : null;

    return {
      language,
      languageConfidence: understanding.language.confidence,
      clientName,
      recentMessages: window.map((m) => ({ role: m.role, text: m.text })),
      conversationTopic: memory.topics.length ? memory.topics[memory.topics.length - 1]! : null,
      detectedIntent: understanding.intent,
      tone: understanding.tone,
      importantFacts: [...memory.importantFacts]
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 12)
        .map((f) => ({ key: f.key, value: f.value })),
      unansweredQuestions,
      recentAssistantResponses,
      conversationLength,
      isNewTopic,
      hasQuestion: understanding.hasQuestion,
      questions: understanding.questions,
      notes,
    };
  }

  /**
   * Resolution order: the conversation's established language wins over a short
   * ambiguous input, because a 2-word message carries almost no signal while the
   * record carries the whole relationship.
   */
  private resolveLanguage(understanding: Understanding, memory: ClientMemory, notes: string[]): string {
    if (isAmbiguous(understanding.incoming) && memory.language) {
      notes.push(`short message — kept conversation language ${memory.language}`);
      return memory.language;
    }
    if (understanding.language.confidence < 0.3 && memory.language) {
      notes.push(`low-confidence detection — kept conversation language ${memory.language}`);
      return memory.language;
    }
    if (understanding.language.confidence < 0.3) {
      notes.push('language could not be determined with confidence');
      // Honest fallback: the detector returned its documented default, not a
      // measurement. Say so rather than presenting a guess as a fact.
      return detectLanguage(understanding.incoming).lang;
    }
    return understanding.language.lang;
  }

  /**
   * Walks backwards from the newest turn: client questions that have no
   * assistant turn after them are still open. The current message's own
   * questions are added on top, since nothing has answered them yet.
   */
  private findUnansweredQuestions(window: StoredMessage[], understanding: Understanding): string[] {
    const open: string[] = [];
    for (let i = window.length - 1; i >= 0; i--) {
      const msg = window[i]!;
      if (msg.role === 'assistant') break; // we replied after that point
      if (msg.text.includes('?')) open.unshift(normaliseText(msg.text));
    }
    for (const q of understanding.questions) {
      if (!open.some((o) => fingerprint(o) === fingerprint(q))) open.push(q);
    }
    // The current message may be a question without an extractable clause
    // ("Where are you from?" has one, but "And you?" does not).
    if (understanding.hasQuestion && understanding.questions.length === 0) {
      const norm = normaliseText(understanding.incoming);
      if (!open.some((o) => fingerprint(o) === fingerprint(norm))) open.push(norm);
    }
    return open.slice(0, 5);
  }

  /** Cheap, model-free topic freshness check against the tagged topic list. */
  private detectNewTopic(text: string, memory: ClientMemory): boolean {
    if (!memory.topics.length) return false;
    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 4);
    if (words.length === 0) return false;
    const known = new Set(memory.topics.map((t) => t.toLowerCase()));
    const novel = words.filter((w) => !known.has(w));
    // A single shared word is enough to consider it "the same thread"; only a
    // fully novel sentence is a topic switch.
    return novel.length === words.length && novel.length >= 3;
  }

  private lengthOf(messageCount: number): AnalyzedContext['conversationLength'] {
    if (messageCount < 4) return 'short';
    if (messageCount < 16) return 'medium';
    return 'long';
  }
}
