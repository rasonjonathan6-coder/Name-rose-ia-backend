import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveCallAssistant } from '@/core/conversation/live-assistant';

/**
 * A stand-in for the browser's SpeechRecognition. Tests drive its handlers
 * directly, which is exactly what the real constructor does when the browser
 * fires results/errors/end.
 */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  started = false;
  aborted = false;
  /**
   * A real session fires `onstart` on every successful start. Set this false to
   * model a recognition engine that fails to come up, which is what makes the
   * restart budget in the assistant run out.
   */
  emitOnstart = true;

  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start() {
    this.started = true;
    if (this.emitOnstart) this.onstart?.();
  }
  stop() {
    this.started = false;
  }
  abort() {
    this.aborted = true;
    this.started = false;
  }

  emitFinal(transcript: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [[{ transcript }]] as unknown as unknown[],
    });
  }
}

/** Builds a fake `results` array where entry 0 is final. */
function resultsOf(entries: Array<{ transcript: string; isFinal: boolean }>) {
  const arr = entries.map((e) => [{ transcript: e.transcript }] as unknown[]);
  (arr as unknown as { isFinal?: boolean }[]).forEach((_, i) => {
    (arr[i] as unknown as { isFinal: boolean }).isFinal = entries[i]!.isFinal;
  });
  return arr;
}

function installRecognition() {
  const w = globalThis as unknown as { SpeechRecognition?: unknown };
  w.SpeechRecognition = FakeRecognition;
  return () => {
    delete w.SpeechRecognition;
    delete (w as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  };
}

function events() {
  return {
    onInterim: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onStateChange: vi.fn(),
  };
}

describe('LiveCallAssistant', () => {
  let uninstall: () => void;

  beforeEach(() => {
    FakeRecognition.instances = [];
    uninstall = installRecognition();
    // checkAvailability() bails out on an insecure origin; the default test
    // environment is not HTTPS, so pin the flag the browser would set.
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    }
  });

  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  it('reports unavailability when the browser has no Web Speech API', () => {
    uninstall();
    const e = events();
    const assistant = new LiveCallAssistant(e);

    const availability = assistant.checkAvailability();

    expect(availability.available).toBe(false);
    if (!availability.available) expect(availability.reason).toMatch(/Web Speech API/);
  });

  it('reports unavailability at start() and emits an error when the API is missing', () => {
    uninstall();
    const e = events();
    const assistant = new LiveCallAssistant(e);

    const res = assistant.start({ language: 'en-US', interim: true });

    expect(res.available).toBe(false);
    expect(e.onError).toHaveBeenCalledOnce();
    expect(assistant.isActive).toBe(false);
  });

  it('starts recognition with the requested language and interim setting', () => {
    const e = events();
    const assistant = new LiveCallAssistant(e);

    const res = assistant.start({ language: 'ru-RU', interim: true });

    expect(res.available).toBe(true);
    const rec = FakeRecognition.instances[0]!;
    expect(rec.lang).toBe('ru-RU');
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.started).toBe(true);
    expect(assistant.isActive).toBe(true);
    expect(e.onStateChange).toHaveBeenCalledWith(true);
  });

  it('falls back to en-US when no language is supplied', () => {
    const assistant = new LiveCallAssistant(events());
    assistant.start({ language: '', interim: false });
    expect(FakeRecognition.instances[0]!.lang).toBe('en-US');
  });

  it('emits final transcripts and ignores empty ones', () => {
    const e = events();
    const assistant = new LiveCallAssistant(e);
    assistant.start({ language: 'en-US', interim: true });
    const rec = FakeRecognition.instances[0]!;

    rec.onresult?.({ resultIndex: 0, results: resultsOf([{ transcript: '  hello there  ', isFinal: true }]) });
    rec.onresult?.({ resultIndex: 0, results: resultsOf([{ transcript: '   ', isFinal: true }]) });

    expect(e.onFinal).toHaveBeenCalledTimes(1);
    expect(e.onFinal).toHaveBeenCalledWith('hello there');
  });

  it('emits interim transcripts', () => {
    const e = events();
    const assistant = new LiveCallAssistant(e);
    assistant.start({ language: 'en-US', interim: true });
    const rec = FakeRecognition.instances[0]!;

    rec.onresult?.({ resultIndex: 0, results: resultsOf([{ transcript: 'hel', isFinal: false }]) });

    expect(e.onInterim).toHaveBeenCalledWith('hel');
    expect(e.onFinal).not.toHaveBeenCalled();
  });

  it('tracks silence since the last final transcript', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const assistant = new LiveCallAssistant(events());
    assistant.start({ language: 'en-US', interim: true });
    const rec = FakeRecognition.instances[0]!;

    rec.onresult?.({ resultIndex: 0, results: resultsOf([{ transcript: 'hi', isFinal: true }]) });
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));

    expect(assistant.silenceMs).toBe(5000);
  });

  it('surfaces a denied microphone and stops listening', () => {
    const e = events();
    const assistant = new LiveCallAssistant(e);
    assistant.start({ language: 'en-US', interim: true });
    const rec = FakeRecognition.instances[0]!;

    rec.onerror?.({ error: 'not-allowed' });

    expect(e.onError).toHaveBeenCalledWith(expect.stringContaining('Microphone access was denied'));
    expect(assistant.isActive).toBe(false);
  });

  it('does not surface benign no-speech or aborted events', () => {
    const e = events();
    const assistant = new LiveCallAssistant(e);
    assistant.start({ language: 'en-US', interim: true });
    const rec = FakeRecognition.instances[0]!;

    rec.onerror?.({ error: 'no-speech' });
    rec.onerror?.({ error: 'aborted' });

    expect(e.onError).not.toHaveBeenCalled();
  });

  it('reports an unknown error code verbatim', () => {
    const e = events();
    const assistant = new LiveCallAssistant(e);
    assistant.start({ language: 'en-US', interim: true });

    FakeRecognition.instances[0]!.onerror?.({ error: 'weird-code' });

    expect(e.onError).toHaveBeenCalledWith(expect.stringContaining('weird-code'));
  });

  it('restarts after an unexpected end while still active', () => {
    vi.useFakeTimers();
    const e = events();
    const assistant = new LiveCallAssistant(e);
    assistant.start({ language: 'en-US', interim: true });
    const rec = FakeRecognition.instances[0]!;

    rec.onend?.();
    vi.advanceTimersByTime(400);

    expect(rec.started).toBe(true);
    expect(e.onError).not.toHaveBeenCalled();
  });

  it('gives up after too many restarts instead of looping forever', () => {
    vi.useFakeTimers();
    const e = events();
    const assistant = new LiveCallAssistant(e);
    assistant.start({ language: 'en-US', interim: true });
    const rec = FakeRecognition.instances[0]!;
    // The session keeps dying before it can start, so the budget is never reset.
    rec.emitOnstart = false;

    for (let i = 0; i < 10; i++) {
      rec.onend?.();
      vi.advanceTimersByTime(400);
    }

    expect(e.onError).toHaveBeenCalledWith(expect.stringContaining('kept stopping'));
    expect(assistant.isActive).toBe(false);
  });

  it('does not restart after stop()', () => {
    vi.useFakeTimers();
    const assistant = new LiveCallAssistant(events());
    assistant.start({ language: 'en-US', interim: true });
    const rec = FakeRecognition.instances[0]!;

    assistant.stop();
    rec.onend?.();
    vi.advanceTimersByTime(400);

    expect(rec.started).toBe(false);
  });

  it('stop() aborts recognition and emits the state change', () => {
    const e = events();
    const assistant = new LiveCallAssistant(e);
    assistant.start({ language: 'en-US', interim: true });
    const rec = FakeRecognition.instances[0]!;

    assistant.stop();

    expect(rec.aborted).toBe(true);
    expect(assistant.isActive).toBe(false);
    expect(e.onStateChange).toHaveBeenLastCalledWith(false);
  });

  it('restarts cleanly when start() is called while already active', () => {
    const e = events();
    const assistant = new LiveCallAssistant(e);
    assistant.start({ language: 'en-US', interim: true });
    const first = FakeRecognition.instances[0]!;

    assistant.start({ language: 'en-US', interim: true });

    expect(first.aborted).toBe(true);
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it('reports a thrown start() as unavailable without crashing', () => {
    class ThrowingRecognition extends FakeRecognition {
      override start() {
        throw new Error('mic busy');
      }
    }
    (globalThis as unknown as { SpeechRecognition: unknown }).SpeechRecognition = ThrowingRecognition;

    const e = events();
    const assistant = new LiveCallAssistant(e);
    const res = assistant.start({ language: 'en-US', interim: true });

    expect(res.available).toBe(false);
    expect(e.onError).toHaveBeenCalledWith('mic busy');
  });
});
