import { describe, expect, it } from 'vitest';
import { CooldownGate, RateLimiter, canUseAI, canUseAutomation, isAutoSendBlocked, sanitiseForExport } from '@/core/safety/policy';
import { DEFAULT_SETTINGS } from '@/shared/settings';
import type { RoseSettings } from '@/shared/types';

function settings(patch: Partial<RoseSettings> = {}): RoseSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...patch,
    ai: { ...DEFAULT_SETTINGS.ai, acknowledgedPolicy: true, ...(patch.ai ?? {}) },
    automation: { ...DEFAULT_SETTINGS.automation, globalEnabled: true, ...(patch.automation ?? {}) },
  };
}

describe('canUseAI', () => {
  it('blocks AI until the policy is acknowledged', () => {
    const s = settings({ ai: { ...DEFAULT_SETTINGS.ai, acknowledgedPolicy: false } });
    const res = canUseAI(s);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('policy');
  });

  it('allows AI once acknowledged with an enabled provider', () => {
    expect(canUseAI(settings()).allowed).toBe(true);
  });

  it('blocks when the active provider is disabled', () => {
    const s = settings();
    s.ai.providers = s.ai.providers.map((p) => ({ ...p, enabled: p.id !== s.ai.activeProvider }));
    const res = canUseAI(s);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('disabled');
  });

  it('blocks when the active provider does not exist', () => {
    const s = settings();
    s.ai.activeProvider = 'nonexistent';
    expect(canUseAI(s).allowed).toBe(false);
  });
});

describe('canUseAutomation', () => {
  it('requires AI availability first', () => {
    const s = settings({ ai: { ...DEFAULT_SETTINGS.ai, acknowledgedPolicy: false } });
    expect(canUseAutomation(s).allowed).toBe(false);
  });

  it('requires the master switch', () => {
    const s = settings({ automation: { ...DEFAULT_SETTINGS.automation, globalEnabled: false } });
    expect(canUseAutomation(s).allowed).toBe(false);
  });

  it('respects the global pause', () => {
    const s = settings();
    s.automation = { ...s.automation, globalEnabled: true, globalPaused: true };
    const res = canUseAutomation(s);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('paused');
  });

  it('allows when everything is enabled', () => {
    expect(canUseAutomation(settings()).allowed).toBe(true);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit then refuses', () => {
    const rl = new RateLimiter(3);
    expect(rl.tryConsume('c1')).toBe(true);
    expect(rl.tryConsume('c1')).toBe(true);
    expect(rl.tryConsume('c1')).toBe(true);
    expect(rl.tryConsume('c1')).toBe(false);
    expect(rl.remaining('c1')).toBe(0);
  });

  it('tracks conversations independently', () => {
    const rl = new RateLimiter(1);
    expect(rl.tryConsume('c1')).toBe(true);
    expect(rl.tryConsume('c1')).toBe(false);
    expect(rl.tryConsume('c2')).toBe(true);
  });

  it('expires entries outside the window', () => {
    const rl = new RateLimiter(1, 1000);
    const t0 = 1_000_000;
    expect(rl.tryConsume('c1', t0)).toBe(true);
    expect(rl.tryConsume('c1', t0 + 500)).toBe(false);
    expect(rl.tryConsume('c1', t0 + 1500)).toBe(true);
  });

  it('retunes the limit at runtime', () => {
    const rl = new RateLimiter(1);
    rl.tryConsume('c1');
    expect(rl.tryConsume('c1')).toBe(false);
    rl.setLimit(5);
    expect(rl.tryConsume('c1')).toBe(true);
  });

  it('reset clears a specific key or everything', () => {
    const rl = new RateLimiter(1);
    rl.tryConsume('c1');
    rl.reset('c1');
    expect(rl.tryConsume('c1')).toBe(true);
    rl.reset();
    expect(rl.remaining('c1')).toBe(1);
  });
});

describe('CooldownGate', () => {
  it('is ready immediately, then blocked for the cooldown', () => {
    const g = new CooldownGate(4000);
    const t0 = 1_000_000;
    expect(g.ready('c1', t0)).toBe(true);
    g.mark('c1', t0);
    expect(g.ready('c1', t0 + 1000)).toBe(false);
    expect(g.ready('c1', t0 + 4000)).toBe(true);
  });

  it('reports the remaining wait', () => {
    const g = new CooldownGate(5000);
    g.mark('c1', 1000);
    expect(g.msUntilReady('c1', 2000)).toBe(4000);
    expect(g.msUntilReady('c1', 9000)).toBe(0);
  });

  it('is per-conversation', () => {
    const g = new CooldownGate(5000);
    g.mark('c1', 1000);
    expect(g.ready('c2', 1000)).toBe(true);
  });
});

describe('isAutoSendBlocked', () => {
  it('blocks money requests', () => {
    expect(isAutoSendBlocked('Can you send me money via Western Union?').allowed).toBe(false);
    expect(isAutoSendBlocked('send me btc please').allowed).toBe(false);
    expect(isAutoSendBlocked('what is your bank account number').allowed).toBe(false);
  });

  it('blocks references to minors', () => {
    expect(isAutoSendBlocked('are you a minor?').allowed).toBe(false);
  });

  it('blocks prohibited content references', () => {
    expect(isAutoSendBlocked('that sounds like incest').allowed).toBe(false);
  });

  it('blocks off-platform contact sharing', () => {
    expect(isAutoSendBlocked('add me on WhatsApp: +33612345678').allowed).toBe(false);
  });

  it('allows ordinary conversation', () => {
    expect(isAutoSendBlocked('Hey! How was your day?').allowed).toBe(true);
    expect(isAutoSendBlocked('I would love to visit Paris someday').allowed).toBe(true);
  });

  it('does not false-positive on the word "send" alone', () => {
    expect(isAutoSendBlocked('I will send you a photo of my cat').allowed).toBe(true);
  });
});

describe('sanitiseForExport', () => {
  it('redacts API keys', () => {
    const out = sanitiseForExport('key sk-abcdefghijklmnopqrstuvwxyz123456') as string;
    expect(out).toContain('REDACTED');
    expect(out).not.toContain('sk-abcdefghij');
  });

  it('redacts OpenRouter and Groq key formats', () => {
    expect(sanitiseForExport('sk-or-abcdefghijklmnopqrstuvwx')).toContain('REDACTED');
    expect(sanitiseForExport('gsk_abcdefghijklmnopqrstuvwx')).toContain('REDACTED');
  });

  it('redacts emails and phone numbers', () => {
    expect(sanitiseForExport('contact me at user@example.com')).toContain('***@***');
    expect(sanitiseForExport('call +33612345678')).toContain('PHONE');
  });

  it('redacts secret-named object fields', () => {
    const out = sanitiseForExport({ apiKey: 'secret', token: 'abc', name: 'visible' }) as Record<string, unknown>;
    expect(out.apiKey).toBe('***');
    expect(out.token).toBe('***');
    expect(out.name).toBe('visible');
  });

  it('recurses into nested structures', () => {
    const out = sanitiseForExport({ a: { b: { apiKey: 'x' } } }) as { a: { b: { apiKey: string } } };
    expect(out.a.b.apiKey).toBe('***');
  });
});
