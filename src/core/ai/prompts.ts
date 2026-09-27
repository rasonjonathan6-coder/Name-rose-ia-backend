import type { GenerationRequest, ResponseLength, ResponseStyle } from '@/shared/types';
import { truncate } from '@/shared/utils';
import type { ClientMemory } from '@/shared/types';
import type { ContextView } from './prompt-sections';
import {
  PROMPT_VERSION,
  contextSection,
  memorySection,
  recentConversationSection,
  systemPromptSection,
  userRequestSection,
} from './prompt-sections';

/**
 * Prompt construction.
 *
 * Kept in one module so the safety framing, the memory-compression contract and
 * the output contract (strict JSON) are defined in a single auditable place.
 */

const STYLE_GUIDE: Record<ResponseStyle, string> = {
  natural: 'Write the way a real person types in a casual chat: contractions, short sentences, no formality.',
  friendly: 'Be friendly and approachable. Light, positive tone. Show interest in the other person.',
  warm: 'Be warm and affectionate but tasteful. Caring, attentive, emotionally present.',
  flirty: 'Be subtly flirty and teasing — playful innuendo only. Never explicit. Leave something to the imagination.',
  playful: 'Be playful and funny. Light banter, emojis used sparingly, keep the energy up.',
  direct: 'Be direct and concise. Answer the question, then move the conversation forward.',
  custom: 'Follow the user-provided style instructions exactly.',
};

const LENGTH_GUIDE: Record<ResponseLength, string> = {
  short: '1 short sentence, max ~15 words. No emojis unless they add meaning.',
  medium: '1-2 sentences, max ~35 words. At most one emoji.',
  long: '2-4 sentences, max ~70 words. At most one emoji.',
};

export interface PromptBundle {
  system: string;
  user: string;
  /** Tokens we estimate for the prompt, used for the cost meter. */
  approxChars: number;
}

export function buildGenerationPrompt(
  req: GenerationRequest,
  context?: ContextView,
): PromptBundle {
  const { memory, incoming, style, customStyle, length, targetLanguage, count } = req;

  const styleText = style === 'custom' && customStyle?.trim() ? customStyle.trim() : STYLE_GUIDE[style];
  const langInstruction =
    targetLanguage === 'auto'
      ? `Reply in the SAME language as the client's last message (detected: ${memory.language ?? 'unknown'}).`
      : `Reply in ${targetLanguage}.`;

  // SYSTEM PROMPT + CONTEXT + MEMORY + RECENT CONVERSATION + USER REQUEST are
  // assembled from named sections so each concern has one home.
  const system = systemPromptSection(
    { style: styleText, length: LENGTH_GUIDE[length], languageInstruction: langInstruction },
    count,
  );

  const sections: string[] = [];
  if (context) sections.push(contextSection(context));
  sections.push(memorySection(memory));
  sections.push(recentConversationSection(req.history));
  sections.push(userRequestSection(incoming));
  const user = sections.join('\n\n');

  return { system, user, approxChars: system.length + user.length };
}

/**
 * Renders memory under a strict token budget. Ordering matters: the summary and
 * facts survive truncation, recent messages are cut from the oldest end.
 */
export function renderMemory(memory: ClientMemory, maxChars = 1600): string {
  return memorySection(memory, maxChars);
}

/** Prompt for the rolling conversation summary (cheap/fast model). */
export function buildSummaryPrompt(memory: ClientMemory, messages: string[]): PromptBundle {
  const system = `You compress chat history for a long-running conversation assistant.
Extract durable information only: who the client is, what they have shared, their preferences, promises made, and open threads.
Ignore small talk, greetings and filler. Never invent facts.
Write at most 120 words of plain prose, third person, about the CLIENT.

OUTPUT FORMAT (strict): return ONLY the summary text. No JSON, no headings, no preamble.`;

  const user = `EXISTING SUMMARY:
${memory.summary || '(none yet)'}

NEW MESSAGES TO FOLD IN:
${messages.map((m) => `- ${truncate(m, 300)}`).join('\n')}

Updated summary:`;

  return { system, user, approxChars: system.length + user.length };
}

/** Prompt used to extract structured facts from a message (fast model). */
export function buildFactExtractionPrompt(message: string, existing: string[]): PromptBundle {
  const system = `You extract durable personal facts from a chat message.
Return ONLY a JSON array. Each item: {"key":"short_label","value":"fact","weight":0.0-1.0}
Extract only facts the client states about themselves (name, age, city, job, likes, dislikes, plans, relationship status).
Do NOT extract: questions they asked, opinions about the assistant, greetings, or anything you infer rather than read.
If there is nothing to extract, return [].
Do NOT repeat facts already known: ${existing.slice(0, 20).join(' | ') || '(none)'}`;

  const user = `MESSAGE: """${truncate(message, 800)}"""
Return the JSON array only.`;

  return { system, user, approxChars: system.length + user.length };
}

/** Prompt for translating a reply, preserving tone. */
export function buildTranslationPrompt(text: string, targetLang: string, tone: string): PromptBundle {
  const system = `You are a professional translator for casual online chat.
Translate faithfully, preserving tone, register, slang and emoji. Keep it as short as the original.
Do not add explanations, notes or alternatives.
The desired tone is: ${tone}.

OUTPUT FORMAT (strict): return ONLY the translated text.`;

  const user = `Translate into ${targetLang}:\n"""${truncate(text, 1200)}"""`;

  return { system, user, approxChars: system.length + user.length };
}
