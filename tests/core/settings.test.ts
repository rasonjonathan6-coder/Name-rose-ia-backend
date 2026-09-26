import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, deepMerge, mergeSettings, normalizeSettings } from '@/shared/settings';

describe('mergeSettings — upgrade safety', () => {
  it('returns defaults when nothing is stored', () => {
    const s = mergeSettings(undefined);
    expect(s.ai.activeProvider).toBe(DEFAULT_SETTINGS.ai.activeProvider);
    expect(s.automation.mode).toBe('manual');
  });

  it('fills in keys added after the user last saved', () => {
    const s = mergeSettings({ appearance: { theme: 'light' } });
    expect(s.appearance.theme).toBe('light');
    // Present in defaults, absent from the stored blob.
    expect(s.memory.enabled).toBe(true);
    expect(s.notifications.minIntervalMs).toBe(60_000);
  });

  it('preserves user values over defaults', () => {
    const s = mergeSettings({ automation: { mode: 'auto', replyDelayMs: 1234 } });
    expect(s.automation.mode).toBe('auto');
    expect(s.automation.replyDelayMs).toBe(1234);
  });

  it('does not share mutable state with DEFAULT_SETTINGS', () => {
    const s = mergeSettings(undefined);
    s.ai.providers[0]!.model = 'mutated';
    expect(DEFAULT_SETTINGS.ai.providers[0]!.model).not.toBe('mutated');
  });
});

describe('normalizeSettings — malformed input cannot crash the UI', () => {
  it('repairs a provider with no temperature', () => {
    // Regression: an imported provider without `temperature` crashed the Options
    // page on `undefined.toFixed(2)`.
    const s = mergeSettings({ ai: { providers: [{ id: 'custom', label: 'Custom', baseUrl: 'https://x', model: 'm' }] } });
    const provider = s.ai.providers.find((p) => p.id === 'custom')!;
    expect(provider).toBeDefined();
    expect(typeof provider.temperature).toBe('number');
    expect(Number.isFinite(provider.temperature)).toBe(true);
    expect(() => provider.temperature.toFixed(2)).not.toThrow();
    expect(provider.maxTokens).toBeGreaterThan(0);
  });

  it('coerces numeric strings and clamps out-of-range values', () => {
    const s = normalizeSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      ai: {
        ...structuredClone(DEFAULT_SETTINGS.ai),
        providers: [
          { id: 'a', label: 'A', baseUrl: '', apiKey: '', model: 'm', fastModel: 'm', temperature: '0.5' as unknown as number, maxTokens: 999_999, enabled: true, viaProxy: false },
          { id: 'b', label: 'B', baseUrl: '', apiKey: '', model: 'm', fastModel: 'm', temperature: -3, maxTokens: 0, enabled: true, viaProxy: false },
        ],
      },
    });
    expect(s.ai.providers[0]!.temperature).toBe(0.5);
    expect(s.ai.providers[0]!.maxTokens).toBe(32_000);
    expect(s.ai.providers[1]!.temperature).toBe(0);
    expect(s.ai.providers[1]!.maxTokens).toBe(1);
  });

  it('falls back when a numeric field is NaN', () => {
    const s = normalizeSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      ai: { ...structuredClone(DEFAULT_SETTINGS.ai), maxResponseChars: Number.NaN },
    });
    expect(Number.isFinite(s.ai.maxResponseChars)).toBe(true);
    expect(s.ai.maxResponseChars).toBeGreaterThan(0);
  });

  it('survives a providers array that is missing entirely', () => {
    const s = mergeSettings({ ai: { providers: undefined } });
    expect(Array.isArray(s.ai.providers)).toBe(true);
    expect(s.ai.providers.length).toBeGreaterThan(0);
  });

  it('repairs a provider with no label', () => {
    // Regression found on the demo page: `label` is typed as required, but a
    // provider synced from an older build can arrive without one. Every error
    // message and the Options provider list interpolate it, so the user saw
    // 'Provider "undefined" is disabled.'
    const s = mergeSettings({
      ai: { providers: [{ id: 'legacy', baseUrl: 'https://x', model: 'm' }] },
    });
    const provider = s.ai.providers.find((p) => p.id === 'legacy')!;
    expect(provider.label).toBe('legacy');
    expect(provider.label).not.toContain('undefined');
  });
});

describe('deepMerge', () => {
  it('merges nested objects without dropping siblings', () => {
    const out = deepMerge({ a: { x: 1, y: 2 }, b: 3 }, { a: { y: 9 } });
    expect(out).toEqual({ a: { x: 1, y: 9 }, b: 3 });
  });

  it('replaces arrays wholesale rather than merging by index', () => {
    const out = deepMerge({ list: [1, 2, 3] }, { list: [9] });
    expect(out.list).toEqual([9]);
  });

  it('ignores undefined values so a partial patch cannot erase data', () => {
    const out = deepMerge({ a: 1 } as Record<string, unknown>, { a: undefined, b: 2 });
    expect(out.a).toBe(1);
    expect(out.b).toBe(2);
  });
});
