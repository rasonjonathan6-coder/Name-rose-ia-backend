import { describe, expect, it } from 'vitest';
import { ResponseQualityGuard } from '@/core/safety/quality-guard';
import type { ClientMemory, Suggestion } from '@/shared/types';

const guard = new ResponseQualityGuard();

function memory(patch: Partial<ClientMemory> = {}): ClientMemory {
  return {
    id: 'generic:a',
    platform: 'generic',
    clientId: 'a',
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
    metadata: { messageCount: 1, platformsSeen: ['generic'], tokensSaved: 0, version: 1 },
    ...patch,
  };
}

const OPTS = {
  expectedLanguage: 'en',
  maxChars: 600,
  recentReplies: [] as string[],
  incoming: 'Hello, how are you?',
};

describe('ResponseQualityGuard — blocking', () => {
  it('blocks empty output', () => {
    const report = guard.check('   ', memory(), OPTS);
    expect(report.ok).toBe(false);
    expect(report.issues[0]!.code).toBe('empty');
  });

  it('blocks content referencing a minor', () => {
    const report = guard.check('she said she is a minor', memory(), OPTS);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'banned-content')).toBe(true);
  });

  it('blocks non-consensual content references', () => {
    expect(guard.check('that would be non-consensual', memory(), OPTS).ok).toBe(false);
  });

  it('blocks breaking character as an AI', () => {
    const report = guard.check('As an AI language model, I cannot...', memory(), OPTS);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.detail.includes('AI'))).toBe(true);
  });

  it('blocks money requests', () => {
    expect(guard.check('please send me money via Western Union', memory(), OPTS).ok).toBe(false);
  });

  it('blocks executable markup', () => {
    expect(guard.check('<script>alert(1)</script>', memory(), OPTS).ok).toBe(false);
  });

  it('allows ordinary replies', () => {
    const report = guard.check("I'm doing great, thanks! How about you?", memory(), OPTS);
    expect(report.ok).toBe(true);
    expect(report.issues).toHaveLength(0);
  });
});

describe('ResponseQualityGuard — duplicate detection', () => {
  it('flags an exact repeat of a recent reply', () => {
    const report = guard.check('How are you doing today?', memory(), {
      ...OPTS,
      recentReplies: ['How are you doing today?'],
    });
    expect(report.issues.some((i) => i.code === 'duplicate')).toBe(true);
    expect(report.issues.find((i) => i.code === 'duplicate')!.severity).toBe('warn');
  });

  it('flags a near-repeat', () => {
    const report = guard.check('How are you doing today my friend?', memory(), {
      ...OPTS,
      recentReplies: ['How are you doing today?'],
    });
    expect(report.issues.some((i) => i.code === 'duplicate')).toBe(true);
  });

  it('flags a repeat that differs only by emoji', () => {
    const report = guard.check('Nice to meet you! 😊', memory(), {
      ...OPTS,
      recentReplies: ['Nice to meet you!'],
    });
    expect(report.issues.some((i) => i.code === 'duplicate')).toBe(true);
  });

  it('does not flag a genuinely different reply', () => {
    const report = guard.check('I work as a nurse in Berlin.', memory(), {
      ...OPTS,
      recentReplies: ['How are you doing today?'],
    });
    expect(report.issues.some((i) => i.code === 'duplicate')).toBe(false);
  });

  it('still allows a duplicate (warn, not block) but recommends regeneration', () => {
    const reports = [
      guard.check('same text', memory(), { ...OPTS, recentReplies: ['same text'] }),
    ];
    expect(reports[0]!.ok).toBe(true);
    expect(guard.shouldRegenerate(reports)).toBe(true);
  });
});

describe('ResponseQualityGuard — language', () => {
  it('flags a reply in the wrong language', () => {
    const report = guard.check('Привет, как дела сегодня? Я хорошо.', memory(), {
      ...OPTS,
      expectedLanguage: 'en',
      incoming: 'Hello there, how are you?',
    });
    expect(report.issues.some((i) => i.code === 'wrong-language')).toBe(true);
  });

  it('accepts a reply in the expected language', () => {
    const report = guard.check("I'm good thanks, and you?", memory(), {
      ...OPTS,
      expectedLanguage: 'en',
    });
    expect(report.issues.some((i) => i.code === 'wrong-language')).toBe(false);
  });

  it('resolves "auto" from the incoming message language', () => {
    const report = guard.check('Привет! Как дела?', memory({ language: 'ru' }), {
      ...OPTS,
      expectedLanguage: 'auto',
      incomingLanguage: 'ru',
      incoming: 'Привет',
    });
    expect(report.issues.some((i) => i.code === 'wrong-language')).toBe(false);
  });
});

describe('ResponseQualityGuard — ignored question', () => {
  it('flags a one-word non-answer to a question', () => {
    const report = guard.check('ok', memory(), {
      ...OPTS,
      incoming: 'Where are you from?',
    });
    expect(report.issues.some((i) => i.code === 'ignored-question')).toBe(true);
  });

  it('does not flag a reply that answers', () => {
    const report = guard.check('I am from Lyon, in France.', memory(), {
      ...OPTS,
      incoming: 'Where are you from?',
    });
    expect(report.issues.some((i) => i.code === 'ignored-question')).toBe(false);
  });

  it('does not flag when the client asked nothing', () => {
    const report = guard.check('ok', memory(), { ...OPTS, incoming: 'I had a long day' });
    expect(report.issues.some((i) => i.code === 'ignored-question')).toBe(false);
  });
});

describe('ResponseQualityGuard — length and contradiction', () => {
  it('flags an over-long reply as info', () => {
    const report = guard.check('word '.repeat(200), memory(), { ...OPTS, maxChars: 100 });
    const issue = report.issues.find((i) => i.code === 'too-long');
    expect(issue?.severity).toBe('info');
  });

  it('flags a denial of a known fact', () => {
    const report = guard.check("I don't know your city", memory({
      importantFacts: [{ key: 'city', value: 'Lyon', at: Date.now(), weight: 0.8 }],
    }), OPTS);
    expect(report.issues.some((i) => i.code === 'contradiction')).toBe(true);
  });

  it('does not flag a denial that mentions no known fact', () => {
    const report = guard.check("I don't know the weather there", memory({
      importantFacts: [{ key: 'city', value: 'Lyon', at: Date.now(), weight: 0.8 }],
    }), OPTS);
    expect(report.issues.some((i) => i.code === 'contradiction')).toBe(false);
  });
});

describe('ResponseQualityGuard — scoring and selection', () => {
  it('scores a clean reply at 1.0', () => {
    expect(guard.check("I'm good, thanks!", memory(), OPTS).score).toBe(1);
  });

  it('lowers the score as issues accumulate', () => {
    const clean = guard.check("I'm good, thanks!", memory(), OPTS).score;
    const warn = guard.check('ok', memory(), { ...OPTS, incoming: 'Where are you from?' }).score;
    expect(warn).toBeLessThan(clean);
  });

  it('picks the best suggestion by score then preferred kind', () => {
    const suggestions: Suggestion[] = [
      { kind: 'warm', text: 'Hey you 😊', lang: 'en' },
      { kind: 'natural', text: 'I am doing well, thanks for asking!', lang: 'en' },
    ];
    const best = guard.pickBest(suggestions, memory(), { ...OPTS, incoming: 'How are you?' });
    expect(best).not.toBeNull();
    expect(best!.suggestion.kind).toBe('natural');
  });

  it('never picks a blocked suggestion', () => {
    const suggestions: Suggestion[] = [
      { kind: 'natural', text: 'please send me money', lang: 'en' },
    ];
    expect(guard.pickBest(suggestions, memory(), OPTS)).toBeNull();
  });

  it('recommends regeneration when everything is a duplicate', () => {
    const reports = [
      guard.check('a', memory(), { ...OPTS, recentReplies: ['a'] }),
      guard.check('b', memory(), { ...OPTS, recentReplies: ['b'] }),
    ];
    expect(guard.shouldRegenerate(reports)).toBe(true);
  });

  it('does not recommend regeneration for a clean set', () => {
    const reports = [guard.check('A genuinely new reply about Paris.', memory(), OPTS)];
    expect(guard.shouldRegenerate(reports)).toBe(false);
  });
});
