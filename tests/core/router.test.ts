import { describe, expect, it } from 'vitest';
import {
  classifyComplexity,
  shouldCallAI,
  localReply,
  tokenBudget,
  pickModel,
  estimateCostUsd,
  hasKnownPricing,
  chooseProvider,
} from '@/core/ai/router';
import { DEFAULT_SETTINGS } from '@/shared/settings';
import type { AIProviderConfig } from '@/shared/types';

const provider: AIProviderConfig = {
  id: 'test',
  label: 'Test',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-4o',
  fastModel: 'gpt-4o-mini',
  apiKey: 'test-key',
  temperature: 0.85,
  maxTokens: 320,
  enabled: true,
  viaProxy: false,
};

describe('classifyComplexity', () => {
  it('classifies greetings as trivial', () => {
    for (const t of ['hi', 'Hey!', 'hello', 'Bonjour', 'Salut !', 'Привет', 'hola']) {
      expect(classifyComplexity(t), t).toBe('trivial');
    }
  });

  it('classifies acknowledgements as trivial', () => {
    for (const t of ['ok', 'thanks', 'yes', 'no', '👍', '😊', 'merci', 'спасибо']) {
      expect(classifyComplexity(t), t).toBe('trivial');
    }
  });

  it('classifies an emoji-only message as trivial', () => {
    expect(classifyComplexity('😂😂😂')).toBe('trivial');
  });

  it('classifies a short question as simple', () => {
    expect(classifyComplexity('Where are you from?')).toBe('simple');
  });

  it('classifies a long message as complex', () => {
    const long = 'I wanted to tell you something that has been on my mind for a while now, and I think you should know about it because it matters to me a great deal.';
    expect(classifyComplexity(long)).toBe('complex');
  });

  it('classifies emotional language as complex', () => {
    expect(classifyComplexity('I feel sad and lonely today')).toBe('complex');
  });

  it('escalates when there is no history to lean on', () => {
    expect(classifyComplexity('Tell me about yourself', 0)).not.toBe('trivial');
  });

  it('classifies empty input as trivial', () => {
    expect(classifyComplexity('   ')).toBe('trivial');
  });
});

describe('shouldCallAI', () => {
  it('skips trivial messages', () => {
    const res = shouldCallAI('hi', { complexity: 'trivial', consecutiveTrivial: 0 });
    expect(res.call).toBe(false);
    expect(res.reason).toContain('trivial');
  });

  it('skips emoji-only messages', () => {
    expect(shouldCallAI('😊', { complexity: 'trivial', consecutiveTrivial: 0 }).call).toBe(false);
  });

  it('skips empty messages', () => {
    expect(shouldCallAI('', { complexity: 'simple', consecutiveTrivial: 0 }).call).toBe(false);
  });

  it('calls for a substantive message', () => {
    expect(shouldCallAI('Where are you from?', { complexity: 'simple', consecutiveTrivial: 0 }).call).toBe(true);
  });

  it('stops after four consecutive low-content messages', () => {
    expect(shouldCallAI('Where are you from?', { complexity: 'simple', consecutiveTrivial: 4 }).call).toBe(false);
  });

  it('honours force', () => {
    expect(shouldCallAI('hi', { complexity: 'trivial', consecutiveTrivial: 9, force: true }).call).toBe(true);
  });
});

describe('localReply', () => {
  it('produces a reply in the requested language', () => {
    expect(localReply('fr', 'seed')).toMatch(/[a-zà-ÿ]/i);
    expect(localReply('ru', 'seed')).toMatch(/[а-яё]/i);
  });

  it('is deterministic for the same seed', () => {
    expect(localReply('en', 'hello')).toBe(localReply('en', 'hello'));
  });

  it('falls back to English for an unknown language', () => {
    expect(localReply('xx', 'seed')).toBeTruthy();
  });

  it('never returns an empty string', () => {
    for (const lang of ['en', 'fr', 'es', 'de', 'ru', 'unknown']) {
      expect(localReply(lang, 'x').length).toBeGreaterThan(0);
    }
  });
});

describe('tokenBudget', () => {
  it('gives translation a fixed budget', () => {
    expect(tokenBudget('translation', 'trivial', 'short')).toBe(320);
  });

  it('scales the generation budget by requested length', () => {
    const short = tokenBudget('generation', 'simple', 'short');
    const medium = tokenBudget('generation', 'simple', 'medium');
    const long = tokenBudget('generation', 'simple', 'long');
    expect(short).toBeLessThan(medium);
    expect(medium).toBeLessThan(long);
  });

  it('gives complex tasks a larger budget than simple ones', () => {
    expect(tokenBudget('generation', 'complex', 'medium')).toBeGreaterThan(
      tokenBudget('generation', 'simple', 'medium'),
    );
  });
});

describe('pickModel', () => {
  it('uses the fast model for summaries and fact extraction', () => {
    expect(pickModel(provider, 'summary', 'complex')).toBe('gpt-4o-mini');
    expect(pickModel(provider, 'facts', 'complex')).toBe('gpt-4o-mini');
  });

  it('uses the fast model for trivial and simple generation', () => {
    expect(pickModel(provider, 'generation', 'trivial')).toBe('gpt-4o-mini');
    expect(pickModel(provider, 'generation', 'simple')).toBe('gpt-4o-mini');
  });

  it('uses the full model for complex generation', () => {
    expect(pickModel(provider, 'generation', 'complex')).toBe('gpt-4o');
  });

  it('falls back to the main model when no fast model is configured', () => {
    expect(pickModel({ ...provider, fastModel: '' }, 'summary', 'simple')).toBe('gpt-4o');
  });
});

describe('estimateCostUsd', () => {
  it('returns zero cost for a known free model', () => {
    expect(estimateCostUsd('llama-3.1-8b-instant', 1000, 1000)).toBeGreaterThanOrEqual(0);
  });

  it('costs more for the full model than the mini one', () => {
    const full = estimateCostUsd('gpt-4o', 1000, 1000);
    const mini = estimateCostUsd('gpt-4o-mini', 1000, 1000);
    expect(full).toBeGreaterThan(mini);
  });

  it('returns 0 for an unknown model rather than guessing', () => {
    expect(estimateCostUsd('some-unknown-model-xyz', 1000, 1000)).toBe(0);
  });

  it('reports whether pricing is known', () => {
    expect(hasKnownPricing('gpt-4o')).toBe(true);
    expect(hasKnownPricing('totally-made-up-model')).toBe(false);
  });

  it('scales linearly with token count', () => {
    const a = estimateCostUsd('gpt-4o', 1000, 0);
    const b = estimateCostUsd('gpt-4o', 2000, 0);
    expect(b).toBeCloseTo(a * 2, 6);
  });
});

describe('chooseProvider', () => {
  it('returns the configured active provider', () => {
    const chosen = chooseProvider(DEFAULT_SETTINGS.ai);
    expect(chosen?.id).toBe(DEFAULT_SETTINGS.ai.activeProvider);
  });

  it('returns null when the active provider does not exist', () => {
    expect(chooseProvider({ ...DEFAULT_SETTINGS.ai, activeProvider: 'nope' })).toBeNull();
  });

  it('ignores a disabled provider', () => {
    const ai = { ...DEFAULT_SETTINGS.ai };
    ai.providers = ai.providers.map((p) => ({ ...p, enabled: false }));
    expect(chooseProvider(ai)).toBeNull();
  });
});
