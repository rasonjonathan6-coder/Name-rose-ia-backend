/**
 * Small DOM/text utilities shared by adapters, the UI and the AI layer.
 */

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = undefined;
        last = Date.now();
        fn(...args);
      }, remaining);
    }
  };
}

export function uid(prefix = 'id'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** djb2 — stable, cheap, collision-resistant enough for message dedupe keys. */
export function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function normaliseText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim();
}

/** Strips emoji/punctuation so near-identical replies compare equal. */
export function fingerprint(text: string): string {
  return normaliseText(text)
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Similarity in 0..1 between two strings.
 *
 * A token-set metric alone misses the case that actually matters here: a
 * reworded or extended version of a previous reply ("How are you doing today my
 * friend?" vs "How are you doing today?"). Blending a character-bigram Dice
 * coefficient in catches those without loosening the threshold enough to merge
 * genuinely different messages.
 */
export function similarity(a: string, b: string): number {
  const fa = fingerprint(a);
  const fb = fingerprint(b);
  if (!fa && !fb) return 1;
  if (!fa || !fb) return 0;
  if (fa === fb) return 1;

  return Math.round((tokenSimilarity(fa, fb) * 0.5 + bigramSimilarity(fa, fb) * 0.5) * 1000) / 1000;
}

/** Dice coefficient over the token sets. */
function tokenSimilarity(fa: string, fb: string): number {
  const ta = new Set(fa.split(' ').filter(Boolean));
  const tb = new Set(fb.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Dice coefficient over character bigrams, which tolerates word-form changes. */
function bigramSimilarity(fa: string, fb: string): number {
  const ga = bigrams(fa);
  const gb = bigrams(fb);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length === 1) {
    out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Rough token estimate: ~4 chars/token for latin scripts, ~1.6 for CJK. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.6 + rest / 4);
}

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Extracts the first JSON object/array from a model response that may be fenced. */
export function extractJson<T>(raw: string): T | null {
  const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/,'').trim();
  const direct = safeJsonParse<T | null>(cleaned, null);
  if (direct) return direct;
  const start = cleaned.search(/[[{]/);
  if (start === -1) return null;
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === open) depth++;
    else if (cleaned[i] === close) {
      depth--;
      if (depth === 0) return safeJsonParse<T | null>(cleaned.slice(start, i + 1), null);
    }
  }
  return null;
}

/**
 * Visibility from the element's own CSS and state — never from geometry.
 *
 * Geometry is deliberately excluded: an element can legitimately measure 0x0
 * while it is still mounting, inside a collapsed scroll container, or in an
 * environment without layout at all (jsdom). Treating that as "hidden" made
 * detection fail on real sites mid-render. Callers that care about size check it
 * separately as a soft scoring signal (`hasLayoutBox`).
 */
export function isVisible(el: Element | null | undefined): boolean {
  if (!el || !(el as HTMLElement).isConnected) return false;
  const html = el as HTMLElement;
  if (html.hidden) return false;
  if (html.getAttribute('aria-hidden') === 'true') return false;
  if (typeof getComputedStyle !== 'function') return true;

  const style = getComputedStyle(html);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
    return false;
  }
  // `opacity: 0` is used by some sites for animation staging; treat it as
  // visible so a mid-animation element is not missed.
  return true;
}

/** True when the element actually occupies space in the layout. */
export function hasLayoutBox(el: Element | null | undefined): boolean {
  if (!el) return false;
  const rect = (el as HTMLElement).getBoundingClientRect?.();
  return !!rect && rect.width > 0 && rect.height > 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
