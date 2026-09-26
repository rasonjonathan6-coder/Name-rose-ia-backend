/**
 * Lightweight offline language identification.
 *
 * Runs on every incoming message, so it must be free (no API call) and fast.
 * Uses stop-word profiles plus script detection; good enough to pick a reply
 * language and to flag a wrong-language response in the quality guard.
 * The AI layer can override this for ambiguous short inputs.
 */

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'you', 'are', 'is', 'to', 'of', 'in', 'it', 'that', 'what', 'how', 'hello', 'hi', 'thanks', 'please', 'where', 'from', 'your', 'my', 'do', 'can', 'will', 'be', 'have'],
  fr: ['le', 'la', 'les', 'et', 'tu', 'vous', 'je', 'est', 'un', 'une', 'des', 'que', 'qui', 'comment', 'bonjour', 'salut', 'merci', 'où', 'de', 'mon', 'ma', 'pour', 'avec', 'ça', 'c\'est', 'pas', 'bien'],
  es: ['el', 'la', 'los', 'y', 'tú', 'usted', 'yo', 'es', 'un', 'una', 'que', 'cómo', 'hola', 'gracias', 'dónde', 'de', 'mi', 'para', 'con', 'bien', 'estás', 'por', 'favor', 'no'],
  de: ['der', 'die', 'das', 'und', 'du', 'sie', 'ich', 'ist', 'ein', 'eine', 'was', 'wie', 'hallo', 'danke', 'wo', 'von', 'mein', 'für', 'mit', 'gut', 'nicht', 'bitte'],
  it: ['il', 'la', 'gli', 'e', 'tu', 'lei', 'io', 'è', 'un', 'una', 'che', 'come', 'ciao', 'grazie', 'dove', 'di', 'mio', 'per', 'con', 'bene', 'non', 'sei'],
  pt: ['o', 'a', 'os', 'e', 'você', 'eu', 'é', 'um', 'uma', 'que', 'como', 'olá', 'obrigado', 'onde', 'de', 'meu', 'para', 'com', 'bem', 'não', 'está'],
  ru: ['и', 'в', 'не', 'на', 'я', 'ты', 'вы', 'это', 'как', 'что', 'привет', 'спасибо', 'где', 'от', 'мой', 'для', 'с', 'хорошо', 'да', 'нет', 'ты'],
  nl: ['de', 'het', 'en', 'jij', 'je', 'ik', 'is', 'een', 'wat', 'hoe', 'hallo', 'bedankt', 'waar', 'van', 'mijn', 'voor', 'met', 'goed', 'niet'],
  pl: ['i', 'w', 'nie', 'na', 'ja', 'ty', 'wy', 'to', 'jak', 'co', 'cześć', 'dziękuję', 'gdzie', 'od', 'mój', 'dla', 'z', 'dobrze', 'tak'],
  tr: ['ve', 'bir', 'bu', 'sen', 'ben', 'ne', 'nasıl', 'merhaba', 'teşekkür', 'nerede', 'için', 'ile', 'iyi', 'değil', 'evet'],
  ar: ['و', 'في', 'لا', 'على', 'أنا', 'أنت', 'هذا', 'كيف', 'مرحبا', 'شكرا', 'أين', 'من', 'لي', 'مع', 'جيد', 'نعم'],
};

const SCRIPTS: Array<{ lang: string; re: RegExp }> = [
  { lang: 'ru', re: /[\u0400-\u04FF]/ },
  { lang: 'ar', re: /[\u0600-\u06FF]/ },
  { lang: 'he', re: /[\u0590-\u05FF]/ },
  { lang: 'el', re: /[\u0370-\u03FF]/ },
  { lang: 'ko', re: /[\uAC00-\uD7AF]/ },
  { lang: 'ja', re: /[\u3040-\u30FF]/ },
  { lang: 'zh', re: /[\u4E00-\u9FFF]/ },
  { lang: 'th', re: /[\u0E00-\u0E7F]/ },
  { lang: 'hi', re: /[\u0900-\u097F]/ },
];

export const SUPPORTED_LANGUAGES: Array<{ code: string; label: string; flag: string }> = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  { code: 'pt', label: 'Português', flag: '🇵🇹' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'nl', label: 'Nederlands', flag: '🇳🇱' },
  { code: 'pl', label: 'Polski', flag: '🇵🇱' },
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
];

export function flagFor(code: string): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.flag ?? '🏳️';
}

export function labelFor(code: string): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase();
}

export interface LanguageGuess {
  lang: string;
  confidence: number;
}

/**
 * Detects the language of `text`.
 * Returns 'en' with low confidence when there is not enough signal, which the
 * caller treats as "unknown — mirror the conversation language".
 */
export function detectLanguage(text: string): LanguageGuess {
  const clean = text.toLowerCase().trim();
  if (!clean) return { lang: 'en', confidence: 0 };

  // 1. Non-latin scripts are unambiguous.
  for (const { lang, re } of SCRIPTS) {
    const matches = clean.match(new RegExp(re.source, 'g'));
    if (matches && matches.length >= Math.max(1, clean.length * 0.15)) {
      return { lang, confidence: 0.95 };
    }
  }

  // 2. Stop-word scoring. Weight by word length so distinctive words count more.
  const words = clean.replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lang: 'en', confidence: 0 };

  const scores = new Map<string, number>();
  for (const [lang, stops] of Object.entries(STOPWORDS)) {
    const set = new Set(stops);
    let score = 0;
    for (const w of words) {
      if (set.has(w)) score += 1 + Math.min(w.length, 8) / 8;
    }
    if (score > 0) scores.set(lang, score);
  }

  // Diacritics are a strong tiebreaker for latin-script languages.
  if (/[àâçéèêëîïôùûüÿœæ]/i.test(text)) scores.set('fr', (scores.get('fr') ?? 0) + 0.8);
  if (/[ñáéíóúü¿¡]/i.test(text)) scores.set('es', (scores.get('es') ?? 0) + 0.8);
  if (/[äöüß]/i.test(text)) scores.set('de', (scores.get('de') ?? 0) + 0.8);
  if (/[ãõç]/i.test(text)) scores.set('pt', (scores.get('pt') ?? 0) + 0.6);
  if (/[ąćęłńóśźż]/i.test(text)) scores.set('pl', (scores.get('pl') ?? 0) + 1.2);
  if (/[ğışçöü]/i.test(text)) scores.set('tr', (scores.get('tr') ?? 0) + 1.2);

  if (scores.size === 0) return { lang: 'en', confidence: 0.15 };

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [bestLang, bestScore] = sorted[0]!;
  const runnerUp = sorted[1]?.[1] ?? 0;

  const total = sorted.reduce((acc, [, v]) => acc + v, 0);
  const share = bestScore / total;
  const margin = bestScore - runnerUp;

  // Confidence blends absolute evidence with how far ahead the winner is.
  const evidence = Math.min(1, bestScore / Math.max(3, words.length * 0.6));
  const confidence = Math.max(0, Math.min(0.98, evidence * 0.6 + share * 0.25 + Math.min(margin / 4, 1) * 0.15));

  return { lang: bestLang, confidence: Math.round(confidence * 100) / 100 };
}

/** True when a message is too short to identify reliably. */
export function isAmbiguous(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length < 3;
}
