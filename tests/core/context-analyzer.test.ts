/**
 * ContextAnalyzer tests.
 *
 * The analyzer is deterministic and model-free, so every case here asserts on
 * real computed output. The behaviours that matter operationally are the ones
 * pinned: unanswered questions are carried over, language detection does not
 * flip on a two-word message, and nothing is invented when a field is unknown.
 */

import { describe, expect, it } from 'vitest';
import { ContextAnalyzer, type AnalyzeOptions } from '@/core/conversation/context-analyzer';
import { ConversationEngine } from '@/core/conversation/engine';
import type { ClientMemory, StoredMessage } from '@/shared/types';

const analyzer = new ContextAnalyzer();
const engine = new ConversationEngine(() => ({ inactivityMinutes: 10, maxRecentMessages: 12 }));

function memory(patch: Partial<ClientMemory> = {}): ClientMemory {
  return {
    id: 'generic:alice',
    platform: 'generic',
    clientId: 'alice',
    displayName: 'Alice',
    language: 'en',
    conversationId: 'c1',
    summary: '',
    recentMessages: [],
    importantFacts: [],
    preferences: {},
    topics: [],
    lastInteraction: Date.now(),
    createdAt: Date.now(),
    metadata: { messageCount: 3, platformsSeen: ['generic'], tokensSaved: 0, version: 1 },
    ...patch,
  };
}

function turn(role: 'client' | 'assistant', text: string, at = Date.now()): StoredMessage {
  return { role, text, at };
}

function analyze(
  incoming: string,
  mem: ClientMemory = memory(),
  history: StoredMessage[] = [],
  opts: AnalyzeOptions = {},
) {
  const understanding = engine.understand(incoming, mem, history);
  return analyzer.analyze(understanding, mem, history, opts);
}

describe('ContextAnalyzer — language', () => {
  it('uses the detected language of a clear message', () => {
    expect(analyze('I really enjoy walking in the park every morning').language).toBe('en');
  });

  it('keeps the conversation language for a very short ambiguous message', () => {
    // "ok" carries almost no signal; the relationship's language is the better
    // answer, and flipping to a guess would mistranslate the reply.
    const ctx = analyze('ok', memory({ language: 'fr' }));
    expect(ctx.language).toBe('fr');
    expect(ctx.notes.join(' ')).toContain('short message');
  });

  it('reports the detection confidence it actually measured', () => {
    const ctx = analyze('Bonjour, comment allez-vous aujourd’hui ?', memory({ language: 'fr' }));
    expect(ctx.language).toBe('fr');
    expect(ctx.languageConfidence).toBeGreaterThan(0);
  });
});

describe('ContextAnalyzer — unanswered questions', () => {
  it('carries over a question the assistant never answered', () => {
    const history = [turn('client', 'Where are you from?'), turn('client', 'And what do you do?')];
    const ctx = analyze('Nice to meet you', memory(), history);
    expect(ctx.unansweredQuestions.length).toBeGreaterThan(0);
    expect(ctx.notes.join(' ')).toContain('unanswered question');
  });

  it('drops a question once the assistant has replied after it', () => {
    const history = [
      turn('client', 'Where are you from?'),
      turn('assistant', 'I am from Paris.'),
      turn('client', 'Nice.'),
    ];
    const ctx = analyze('What about you?', memory(), history);
    expect(ctx.unansweredQuestions.some((q) => /where are you from/i.test(q))).toBe(false);
  });

  it('always includes the current message question even with no history', () => {
    const ctx = analyze('What is your favourite colour?');
    expect(ctx.unansweredQuestions.some((q) => /favourite colour/i.test(q))).toBe(true);
    expect(ctx.hasQuestion).toBe(true);
  });
});

describe('ContextAnalyzer — fields are never invented', () => {
  it('reports a null client name when the adapter resolved none', () => {
    expect(analyze('Hi', memory({ displayName: 'Unknown' })).clientName).toBeNull();
  });

  it('reports the name once it is known', () => {
    expect(analyze('Hi', memory({ displayName: 'Alice' })).clientName).toBe('Alice');
  });

  it('reports no topic when none has been tagged', () => {
    expect(analyze('Hi').conversationTopic).toBeNull();
  });

  it('reports the last tagged topic when one exists', () => {
    expect(analyze('Hi', memory({ topics: ['travel', 'music'] })).conversationTopic).toBe('music');
  });

  it('returns only facts that exist in memory', () => {
    const ctx = analyze(
      'Hi',
      memory({ importantFacts: [{ key: 'job', value: 'designer', weight: 5, at: Date.now() }] }),
    );
    expect(ctx.importantFacts).toEqual([{ key: 'job', value: 'designer' }]);
  });

  it('orders facts by weight so the strongest survive the prompt budget', () => {
    const ctx = analyze(
      'Hi',
      memory({
        importantFacts: [
          { key: 'low', value: 'a', weight: 1, at: Date.now() },
          { key: 'high', value: 'b', weight: 9, at: Date.now() },
        ],
      }),
    );
    expect(ctx.importantFacts[0]!.key).toBe('high');
  });
});

describe('ContextAnalyzer — window and length', () => {
  it('respects the requested history window', () => {
    const history = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? 'assistant' : 'client', `m${i}`));
    const ctx = analyze('Hi', memory(), history, { windowSize: 4 });
    expect(ctx.recentMessages).toHaveLength(4);
  });

  it('keeps only the most recent assistant replies for anti-repetition', () => {
    const history = Array.from({ length: 12 }, (_, i) => turn('assistant', `r${i}`));
    const ctx = analyze('Hi', memory(), history, { recentReplies: 3 });
    expect(ctx.recentAssistantResponses).toHaveLength(3);
    expect(ctx.recentAssistantResponses[2]).toBe('r11');
  });

  it('classifies conversation length from the message count', () => {
    expect(analyze('Hi', memory({ metadata: { messageCount: 2, platformsSeen: [], tokensSaved: 0, version: 1 } })).conversationLength).toBe('short');
    expect(analyze('Hi', memory({ metadata: { messageCount: 10, platformsSeen: [], tokensSaved: 0, version: 1 } })).conversationLength).toBe('medium');
    expect(analyze('Hi', memory({ metadata: { messageCount: 40, platformsSeen: [], tokensSaved: 0, version: 1 } })).conversationLength).toBe('long');
  });
});

describe('ContextAnalyzer — topic freshness', () => {
  it('flags a fully novel multi-word message against a tagged topic list', () => {
    const ctx = analyze(
      'I have been renovating my apartment lately',
      memory({ topics: ['travel', 'music'] }),
    );
    expect(ctx.isNewTopic).toBe(true);
    expect(ctx.notes.join(' ')).toContain('topic absent from memory');
  });

  it('does not flag a message that shares a known topic word', () => {
    const ctx = analyze('I still love music', memory({ topics: ['music'] }));
    expect(ctx.isNewTopic).toBe(false);
  });

  it('never flags novelty when memory has no topics at all', () => {
    expect(analyze('Anything at all about quantum physics', memory({ topics: [] })).isNewTopic).toBe(false);
  });
});

describe('ContextAnalyzer — intent and tone surface through', () => {
  it('passes the detected intent and tone into the context', () => {
    const ctx = analyze('Hey babe, I missed you 😉', memory());
    expect(ctx.detectedIntent).toBe('greeting');
    expect(ctx.tone).toBe('flirty');
  });
});
