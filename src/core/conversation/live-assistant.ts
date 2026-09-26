import { log } from '@/core/logging/logger';
import type { ConversationRef, RawMessage } from '@/shared/types';

/**
 * LiveCallAssistant — real-time speech suggestions during voice/video calls.
 *
 * Scope and honest limitations:
 *  - It uses the browser's own Web Speech API (`SpeechRecognition`). It does NOT
 *    tap the WebRTC audio stream, does NOT access the microphone without the
 *    user's browser-level permission prompt, and does NOT bypass any platform
 *    protection. If the platform or the browser does not expose the API, the
 *    assistant reports unavailability and the chat features keep working.
 *  - Chromium only ships `webkitSpeechRecognition`, and it requires network
 *    access to the vendor's speech service. Nothing here is a workaround for
 *    that; it is a documented constraint.
 *  - Recognition of the *remote* party is not possible through this API: it
 *    captures the local microphone, which picks up the speaker's voice through
 *    the room. This is stated plainly in the UI so users are not misled.
 */

export interface LiveAssistantEvents {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onStateChange: (active: boolean) => void;
}

export type LiveAvailability =
  | { available: true }
  | { available: false; reason: string };

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

export class LiveCallAssistant {
  private recognition: SpeechRecognitionLike | null = null;
  private active = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartCount = 0;
  private lastFinalAt = 0;
  private readonly MAX_RESTARTS = 8;

  constructor(private readonly events: LiveAssistantEvents) {}

  /** Checks for API availability without prompting for microphone access. */
  checkAvailability(): LiveAvailability {
    const ctor = getRecognitionCtor();
    if (!ctor) {
      return {
        available: false,
        reason:
          'This browser does not expose the Web Speech API. Live call suggestions need Chrome or Edge. Chat features are unaffected.',
      };
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return { available: false, reason: 'Speech recognition requires a secure (HTTPS) context.' };
    }
    return { available: true };
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Starts listening. Returns the availability verdict so the caller can show a
   * precise message rather than a generic failure.
   */
  start(opts: { language: string; interim: boolean }): LiveAvailability {
    const availability = this.checkAvailability();
    if (!availability.available) {
      this.events.onError(availability.reason);
      return availability;
    }

    if (this.active) this.stop();

    const Ctor = getRecognitionCtor()!;
    const recognition = new Ctor() as SpeechRecognitionLike;
    recognition.lang = opts.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = opts.interim;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      this.active = true;
      this.restartCount = 0;
      this.events.onStateChange(true);
      log.info('live', 'speech recognition started', { lang: recognition.lang });
    };

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript: string = result[0]?.transcript ?? '';
        if (result.isFinal) {
          const clean = transcript.trim();
          if (clean) {
            this.lastFinalAt = Date.now();
            this.events.onFinal(clean);
          }
        } else {
          interim += transcript;
        }
      }
      if (interim.trim()) this.events.onInterim(interim.trim());
    };

    recognition.onerror = (event: any) => {
      const code = event?.error ?? 'unknown';
      const messages: Record<string, string> = {
        'not-allowed': 'Microphone access was denied. ROSE cannot listen without it.',
        'service-not-allowed': 'The browser blocked the speech service.',
        'no-speech': 'No speech detected.',
        'audio-capture': 'No microphone was found.',
        network: 'The speech service is unreachable.',
        aborted: 'Listening was stopped.',
      };
      // 'no-speech' fires constantly on silence; it is not worth surfacing.
      if (code !== 'no-speech' && code !== 'aborted') {
        this.events.onError(messages[code] ?? `Speech recognition error: ${code}`);
      }
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.stop();
      }
    };

    recognition.onend = () => {
      // Chromium ends the session after a period of silence even in continuous
      // mode. Restart, but stop escalating if it keeps failing.
      if (!this.active) return;
      if (this.restartCount >= this.MAX_RESTARTS) {
        this.events.onError('Speech recognition kept stopping. Restart live assist to continue.');
        this.stop();
        return;
      }
      this.restartCount++;
      this.restartTimer = setTimeout(() => {
        if (!this.active) return;
        try {
          recognition.start();
        } catch {
          /* start() throws if already started; safe to ignore */
        }
      }, 350);
    };

    try {
      recognition.start();
      this.recognition = recognition;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start speech recognition.';
      this.events.onError(message);
      return { available: false, reason: message };
    }

    return { available: true };
  }

  stop(): void {
    this.active = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    try {
      this.recognition?.abort();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
    this.events.onStateChange(false);
    log.info('live', 'speech recognition stopped');
  }

  /** Milliseconds since the last final transcript — used for follow-up timing. */
  get silenceMs(): number {
    return this.lastFinalAt ? Date.now() - this.lastFinalAt : 0;
  }
}

function getRecognitionCtor(): (new () => unknown) | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: new () => unknown;
    webkitSpeechRecognition?: new () => unknown;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Formats a transcript for the overlay's live bar. */
export function formatLiveTranscript(conversation: ConversationRef | null, text: string): string {
  const who = conversation?.displayName && conversation.displayName !== 'Unknown' ? conversation.displayName : 'Call';
  return `${who}: ${text}`;
}

/** Heuristic: does this transcript look like something needing a reply? */
export function transcriptNeedsReply(text: string, messages: RawMessage[]): boolean {
  if (text.trim().length < 3) return false;
  // Avoid re-suggesting for something already typed as a chat message.
  const normalised = text.trim().toLowerCase();
  return !messages.some((m) => m.text.toLowerCase().includes(normalised.slice(0, 24)));
}
