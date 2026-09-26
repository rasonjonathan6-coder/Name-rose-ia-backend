import type {
  ClientMemory,
  ConversationRef,
  ConversationStatus,
  RawMessage,
  StoredMessage,
} from '@/shared/types';
import { detectLanguage, isAmbiguous, type LanguageGuess } from '@/core/translation/language';
import { normaliseText, truncate } from '@/shared/utils';

/**
 * ConversationEngine — turns raw messages into an understanding of the exchange.
 *
 * It answers the questions the AI layer needs answered before writing a reply:
 * what did the client ask, in what language, in what tone, and has it already
 * been answered? This keeps that reasoning deterministic and free, so the model
 * is only asked to do the part it is actually good at.
 */

export interface Understanding {
  /** The message that needs a reply. */
  incoming: string;
  language: LanguageGuess;
  /** True when the message asks something and an answer is required. */
  hasQuestion: boolean;
  /** Extracted questions, so the guard can verify they were addressed. */
  questions: string[];
  tone: 'neutral' | 'warm' | 'flirty' | 'upset' | 'playful' | 'serious';
  intent: 'greeting' | 'question' | 'smalltalk' | 'personal-disclosure' | 'request' | 'reaction' | 'farewell';
  /** Conversation state used for status and follow-up logic. */
  status: ConversationStatus;
  /** Minutes since the previous message. */
  silenceMinutes: number;
  /** True when this is the client's first message ever. */
  isFirstContact: boolean;
  /** True when the message repeats something already in memory. */
  isRepeat: boolean;
}

export interface EngineOptions {
  inactivityMinutes: number;
  maxRecentMessages: number;
}

const QUESTION_RE = /\?/;
const TONE_PATTERNS: Array<{ tone: Understanding['tone']; re: RegExp }> = [
  { tone: 'upset', re: /\b(angry|upset|annoyed|hate|stop|why didn'?t|disappointed|sad|hurt|ignore|triste|fâché|en colère|обидно|злит)\b/i },
  { tone: 'flirty', re: /\b(sexy|hot|beautiful|gorgeous|cute|kiss|hug|miss you|love you|baby|babe|mignon|belle|красив|скучаю)\b/i },
  { tone: 'playful', re: /(😂|🤣|😜|😉|haha|lol|hehe|jaja|mdr|ptdr|смешно|😄)/i },
  { tone: 'warm', re: /\b(thank|thanks|appreciate|nice|sweet|kind|lovely|merci|gracias|спасибо)\b/i },
  { tone: 'serious', re: /\b(serious|important|honest|truth|real|actually|really need|sérieux|серьёзно)\b/i },
];

const INTENT_PATTERNS: Array<{ intent: Understanding['intent']; re: RegExp }> = [
  { intent: 'farewell', re: /\b(bye|goodbye|good night|see you|talk later|later|ciao|au revoir|à plus|пока|до свидания)\b/i },
  { intent: 'greeting', re: /^(hi+|hey+|hello+|yo|howdy|bonjour|salut|coucou|hola|hallo|ciao|olá|привет|مرحبا|你好|こんにちは)\b/i },
  { intent: 'personal-disclosure', re: /\b(i am|i'?m|my name is|i live|i work|i like|i love|i have|je suis|j'?ai|je vis|je travaille|j'?aime|я \w+|меня зовут)\b/i },
  { intent: 'request', re: /\b(can you|could you|would you|please|send me|show me|tell me|help me|peux-tu|peux tu|s'?il te plaît|пожалуйста|можешь)\b/i },
  { intent: 'question', re: QUESTION_RE },
  { intent: 'reaction', re: /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!.,?]+$/u },
];

export class ConversationEngine {
  constructor(private readonly getOptions: () => EngineOptions) {}

  /**
   * Builds an understanding of `incoming` given the client's memory and history.
   */
  understand(
    incoming: string,
    memory: ClientMemory,
    history: StoredMessage[],
  ): Understanding {
    const text = normaliseText(incoming);
    const language = detectLanguage(text);
    const questions = extractQuestions(text);

    const hasQuestion =
      questions.length > 0 ||
      (QUESTION_RE.test(text) && text.trim().length > 1) ||
      /^(what|who|where|when|why|how|do you|are you|can you|qui|que|où|pourquoi|comment)\b/i.test(text.trim());

    const tone = TONE_PATTERNS.find((t) => t.re.test(text))?.tone ?? 'neutral';
    const intent = INTENT_PATTERNS.find((i) => i.re.test(text.trim()))?.intent ?? 'smalltalk';

    const lastMessageAt = history.length ? history[history.length - 1]!.at : memory.lastInteraction;
    const silenceMinutes = Math.max(0, Math.round((Date.now() - lastMessageAt) / 60_000));

    const isFirstContact = memory.metadata.messageCount === 0;
    const isRepeat = history.some(
      (m) => m.role === 'client' && normaliseText(m.text).toLowerCase() === text.toLowerCase(),
    );

    return {
      incoming: text,
      language,
      hasQuestion,
      questions,
      tone,
      intent,
      status: this.deriveStatus(memory, silenceMinutes, isFirstContact),
      silenceMinutes,
      isFirstContact,
      isRepeat,
    };
  }

  private deriveStatus(
    memory: ClientMemory,
    silenceMinutes: number,
    isFirstContact: boolean,
  ): ConversationStatus {
    if (isFirstContact) return 'new';
    if (silenceMinutes >= this.getOptions().inactivityMinutes) return 'inactive';
    // The client wrote last and we have not answered: we owe a reply.
    const last = memory.recentMessages[memory.recentMessages.length - 1];
    if (last?.role === 'client') return 'waiting';
    return 'active';
  }

  /**
   * Builds the recent history window for the prompt, oldest first, with
   * assistant turns labelled. Bounded to keep prompt size predictable.
   */
  buildHistory(memory: ClientMemory, incoming?: string): StoredMessage[] {
    const max = this.getOptions().maxRecentMessages;
    let history = memory.recentMessages.slice(-max);
    // Do not duplicate the message we are answering if it was already recorded.
    if (incoming) {
      const last = history[history.length - 1];
      if (last?.role === 'client' && normaliseText(last.text) === normaliseText(incoming)) {
        history = history.slice(0, -1);
      }
    }
    return history;
  }

  /**
   * Decides whether a follow-up (relance) is warranted, and what to say.
   * Returns null when the conversation should be left alone.
   */
  suggestFollowUp(
    memory: ClientMemory,
    opts: { enabled: boolean; inactivityMinutes: number; maxFollowUps: number; followUpsSent: number },
  ): { kind: 'nudge'; reason: string; prompt: string } | null {
    if (!opts.enabled) return null;
    if (opts.followUpsSent >= opts.maxFollowUps) return null;

    const last = memory.recentMessages[memory.recentMessages.length - 1];
    if (!last || last.role !== 'client') return null;

    const silence = Math.round((Date.now() - last.at) / 60_000);
    if (silence < opts.inactivityMinutes) return null;

    return {
      kind: 'nudge',
      reason: `conversation inactive for ${silence} minutes`,
      prompt: truncate(last.text, 120),
    };
  }

  /** Formats a human-readable inactivity notice for the UI. */
  inactivityNotice(silenceMinutes: number): string | null {
    if (silenceMinutes < this.getOptions().inactivityMinutes) return null;
    return `Conversation inactive for ${silenceMinutes} minute${silenceMinutes === 1 ? '' : 's'}.`;
  }

  /**
   * Rough reply-worthiness: should this message be answered at all?
   * System notices and duplicates are not worth a generation.
   */
  isReplyWorthy(message: RawMessage, understanding: Understanding): { worthy: boolean; reason?: string } {
    if (message.direction !== 'incoming') return { worthy: false, reason: 'not an incoming message' };
    if (!understanding.incoming) return { worthy: false, reason: 'empty message' };
    if (understanding.isRepeat) return { worthy: false, reason: 'client repeated an earlier message' };
    return { worthy: true };
  }
}

/** Extracts individual questions from a multi-question message. */
export function extractQuestions(text: string): string[] {
  if (!text.includes('?')) return [];
  return text
    .split(/(?<=\?)/)
    .map((s) => normaliseText(s))
    .filter((s) => s.includes('?') && s.length > 3)
    .slice(0, 4);
}

/**
 * Confidence-aware language resolution: prefers the client's established
 * language, falls back to the current message, and only trusts short messages
 * when the conversation language is already known.
 */
export function resolveLanguage(
  incoming: string,
  memory: ClientMemory,
  targetLanguage: string,
): string {
  if (targetLanguage !== 'auto') return targetLanguage;
  const guess = detectLanguage(incoming);
  if (isAmbiguous(incoming) && memory.language) return memory.language;
  if (guess.confidence < 0.3 && memory.language) return memory.language;
  return guess.lang;
}
