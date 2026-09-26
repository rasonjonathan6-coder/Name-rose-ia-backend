import { describe, expect, it } from 'vitest';
import { detectLanguage, isAmbiguous, flagFor, SUPPORTED_LANGUAGES } from '@/core/translation/language';

describe('detectLanguage', () => {
  it('detects English', () => {
    const r = detectLanguage('Hi, how are you doing today?');
    expect(r.lang).toBe('en');
    expect(r.confidence).toBeGreaterThan(0.3);
  });

  it('detects French', () => {
    const r = detectLanguage('Salut, comment vas-tu aujourd\'hui ? Je vais bien merci.');
    expect(r.lang).toBe('fr');
    expect(r.confidence).toBeGreaterThan(0.4);
  });

  it('detects Spanish', () => {
    const r = detectLanguage('Hola, ¿cómo estás? Yo estoy bien, gracias por preguntar.');
    expect(r.lang).toBe('es');
  });

  it('detects German', () => {
    const r = detectLanguage('Hallo, wie geht es dir? Ich bin gut, danke für die Frage.');
    expect(r.lang).toBe('de');
  });

  it('detects Russian by script', () => {
    const r = detectLanguage('Привет! Как дела? Я хорошо, спасибо.');
    expect(r.lang).toBe('ru');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('detects Chinese by script', () => {
    expect(detectLanguage('你好，你好吗？我很好，谢谢').lang).toBe('zh');
  });

  it('detects Japanese by script', () => {
    expect(detectLanguage('こんにちは、元気ですか').lang).toBe('ja');
  });

  it('detects Arabic by script', () => {
    expect(detectLanguage('مرحبا كيف حالك').lang).toBe('ar');
  });

  it('detects Portuguese', () => {
    const r = detectLanguage('Olá, como você está? Eu estou bem, obrigado pela pergunta.');
    expect(r.lang).toBe('pt');
  });

  it('returns low confidence for empty input', () => {
    const r = detectLanguage('');
    expect(r.confidence).toBe(0);
  });

  it('returns low confidence for emoji-only input', () => {
    const r = detectLanguage('😊😂👍');
    expect(r.confidence).toBeLessThan(0.3);
  });

  it('handles a single ambiguous word without pretending confidence', () => {
    const r = detectLanguage('ok');
    expect(r.confidence).toBeLessThan(0.6);
  });

  it('is deterministic', () => {
    const a = detectLanguage('Bonjour, je m\'appelle Marie et je vis à Paris.');
    const b = detectLanguage('Bonjour, je m\'appelle Marie et je vis à Paris.');
    expect(a).toEqual(b);
  });
});

describe('isAmbiguous', () => {
  it('flags short messages as ambiguous', () => {
    expect(isAmbiguous('hi')).toBe(true);
    expect(isAmbiguous('ok thanks')).toBe(true);
  });

  it('does not flag longer messages', () => {
    expect(isAmbiguous('I went to the market this morning')).toBe(false);
  });
});

describe('language metadata', () => {
  it('exposes a flag for every supported language', () => {
    for (const l of SUPPORTED_LANGUAGES) {
      expect(flagFor(l.code)).toBeTruthy();
      expect(flagFor(l.code)).not.toBe('🏳️');
    }
  });

  it('falls back gracefully for unknown codes', () => {
    expect(flagFor('xx')).toBe('🏳️');
  });
});
