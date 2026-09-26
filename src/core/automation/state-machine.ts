import type { AutomationConfig, AutomationMode, Suggestion } from '@/shared/types';

/**
 * AutomationStateMachine — the single authority on what ROSE is allowed to do.
 *
 * It is a pure, synchronous state machine: every transition is explicit, every
 * refusal carries a reason, and nothing here touches the DOM or the network.
 * That makes the safety-critical behaviour (what can auto-send, and when it must
 * stop) fully unit-testable without a browser.
 *
 * Modes:
 *   manual   — generate only; never insert, never send.
 *   assisted — generate and insert into the field; the human presses send.
 *   auto     — generate, insert and send, subject to delay, rate limit and the
 *              hard content block.
 *
 * The machine can always be stopped: `stop()` moves to `stopped` from any state,
 * and no transition out of `stopped` exists except an explicit `arm()`.
 */

export type AutomationState =
  | 'idle'          // nothing pending
  | 'generating'    // waiting on the AI
  | 'ready'         // suggestions available, awaiting a decision
  | 'inserting'     // writing into the reply field
  | 'awaiting-confirm' // assisted mode: text is in the field, human must send
  | 'waiting-delay' // auto mode: cooling down before sending
  | 'sending'
  | 'sent'
  | 'paused'
  | 'stopped'
  | 'error';

export type AutomationEvent =
  | { type: 'message'; conversationId: string }
  | { type: 'generation-started'; conversationId: string }
  | { type: 'generation-succeeded'; conversationId: string; suggestions?: Suggestion[] }
  | { type: 'generation-failed'; conversationId: string; error: string }
  | { type: 'insert'; conversationId: string }
  | { type: 'inserted'; conversationId: string }
  | { type: 'delay-elapsed'; conversationId: string }
  | { type: 'send'; conversationId: string }
  | { type: 'sent'; conversationId: string }
  | { type: 'user-selected'; conversationId: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'arm' }
  | { type: 'mode-changed'; mode: AutomationMode }
  | { type: 'conversation-changed'; conversationId: string | null }
  | { type: 'reset' };

export interface TransitionResult {
  state: AutomationState;
  changed: boolean;
  /** What the caller should do next, if anything. */
  action?: 'generate' | 'insert' | 'schedule-send' | 'send' | 'none';
  reason?: string;
  /** Milliseconds the caller should wait before the next action. */
  delayMs?: number;
}

export interface GuardInput {
  /** Hard content block result from the safety layer. */
  contentAllowed: boolean;
  contentReason?: string;
  /** Rate limiter verdict for this conversation. */
  rateAllowed: boolean;
  /** Cooldown gate verdict for this conversation. */
  cooldownReady: boolean;
  /** Whether the provider is configured and the policy acknowledged. */
  policyAllowed: boolean;
  policyReason?: string;
}

const TERMINAL_SAFE: AutomationState[] = ['stopped'];

export class AutomationStateMachine {
  private state: AutomationState = 'idle';
  private mode: AutomationMode = 'manual';
  private activeConversation: string | null = null;
  private lastError: string | null = null;
  private sentCount = 0;

  constructor(initial?: { mode?: AutomationMode; state?: AutomationState }) {
    if (initial?.mode) this.mode = initial.mode;
    if (initial?.state) this.state = initial.state;
  }

  get current(): AutomationState {
    return this.state;
  }

  get currentMode(): AutomationMode {
    return this.mode;
  }

  get conversation(): string | null {
    return this.activeConversation;
  }

  get error(): string | null {
    return this.lastError;
  }

  get totalSent(): number {
    return this.sentCount;
  }

  /** True when the machine will not act until explicitly armed again. */
  get isStopped(): boolean {
    return this.state === 'stopped';
  }

  get isPaused(): boolean {
    return this.state === 'paused';
  }

  /** True when an auto-send is imminent or in flight. */
  get isBusy(): boolean {
    return this.state === 'generating' || this.state === 'inserting' || this.state === 'sending' || this.state === 'waiting-delay';
  }

  /**
   * Applies an event and returns the new state plus the action the caller
   * should perform. `guards` is only consulted for actions that reach the DOM.
   */
  dispatch(event: AutomationEvent, guards?: GuardInput): TransitionResult {
    // A stop is unconditional and can never be undone by an in-flight event.
    if (event.type === 'stop') {
      this.state = 'stopped';
      this.lastError = null;
      return { state: this.state, changed: true, action: 'none', reason: 'global stop engaged' };
    }
    if (event.type === 'arm') {
      this.state = 'idle';
      this.lastError = null;
      return { state: this.state, changed: true, action: 'none', reason: 'armed' };
    }
    if (event.type === 'reset') {
      this.state = 'idle';
      this.activeConversation = null;
      this.lastError = null;
      return { state: this.state, changed: true, action: 'none' };
    }

    if (TERMINAL_SAFE.includes(this.state)) {
      return {
        state: this.state,
        changed: false,
        action: 'none',
        reason: 'ROSE is stopped — press Arm to resume',
      };
    }

    switch (event.type) {
      case 'pause':
        return this.set('paused', 'paused by user');

      case 'resume':
        if (this.state !== 'paused') return this.noop('not paused');
        return this.set('idle', 'resumed');

      case 'mode-changed':
        this.mode = event.mode;
        // Leaving auto while a send is pending must cancel the pending send.
        if (this.mode !== 'auto' && (this.state === 'waiting-delay' || this.state === 'sending')) {
          return this.set('ready', `mode changed to ${this.mode} — pending auto-send cancelled`);
        }
        return { state: this.state, changed: true, action: 'none', reason: `mode=${this.mode}` };

      case 'conversation-changed':
        this.activeConversation = event.conversationId;
        // Switching conversations invalidates a pending auto-send.
        if (this.state === 'waiting-delay' || this.state === 'awaiting-confirm') {
          return this.set('idle', 'conversation changed');
        }
        return { state: this.state, changed: true, action: 'none' };

      case 'message': {
        this.activeConversation = event.conversationId;
        if (this.state === 'paused') return this.noop('paused');
        // Do not start a second generation while one is running for the same chat.
        if (this.isBusy && this.activeConversation === event.conversationId) {
          return this.noop('already processing this conversation');
        }
        if (guards && !guards.policyAllowed) {
          const reason = guards.policyReason ?? 'policy check failed';
          this.lastError = reason;
          return this.set('error', reason);
        }
        return this.set('generating', 'new message received', 'generate');
      }

      case 'generation-started':
        return this.set('generating', 'generation in flight');

      case 'generation-succeeded':
        return this.set('ready', 'suggestions ready');

      case 'generation-failed':
        this.lastError = event.error;
        return this.set('error', event.error);

      case 'insert': {
        if (guards && !guards.contentAllowed) {
          return this.set('ready', guards.contentReason ?? 'content blocked', 'none');
        }
        return this.set('inserting', 'inserting reply', 'insert');
      }

      case 'inserted': {
        if (this.mode === 'manual') {
          // Manual mode never puts text in the field; treat as a no-op guard.
          return this.set('ready', 'manual mode: text shown, not inserted');
        }
        if (this.mode === 'assisted') {
          return this.set('awaiting-confirm', 'inserted — awaiting human confirmation');
        }
        // Auto mode: go through the delay, rate limit and cooldown gates.
        if (guards) {
          if (!guards.policyAllowed) return this.set('error', guards.policyReason ?? 'policy check failed');
          if (!guards.contentAllowed) {
            return this.set('awaiting-confirm', guards.contentReason ?? 'content blocked from auto-send');
          }
          if (!guards.rateAllowed) {
            return this.set('awaiting-confirm', 'hourly auto-reply limit reached — manual send required');
          }
          if (!guards.cooldownReady) {
            return this.set('awaiting-confirm', 'minimum delay between replies not elapsed');
          }
        }
        return this.set('waiting-delay', 'auto mode: delay before send', 'schedule-send');
      }

      case 'delay-elapsed':
        if (this.state !== 'waiting-delay') return this.noop('no pending send');
        if (this.mode !== 'auto') return this.set('awaiting-confirm', 'auto mode no longer active');
        if (guards && !guards.contentAllowed) {
          return this.set('awaiting-confirm', guards.contentReason ?? 'content blocked');
        }
        if (guards && !guards.rateAllowed) {
          return this.set('awaiting-confirm', 'hourly limit reached');
        }
        return this.set('sending', 'sending reply', 'send');

      case 'send': {
        if (this.mode !== 'auto') {
          return this.set('awaiting-confirm', `send blocked in ${this.mode} mode`);
        }
        if (guards && !guards.contentAllowed) {
          return this.set('awaiting-confirm', guards.contentReason ?? 'content blocked');
        }
        return this.set('sending', 'sending', 'send');
      }

      case 'sent':
        this.sentCount++;
        return this.set('idle', 'reply sent');

      case 'user-selected':
        return this.set('ready', 'user selected a suggestion');

      default:
        return this.noop('unhandled event');
    }
  }

  /**
   * Applies a full settings object. Changing the mode away from auto cancels a
   * pending automatic send, and disabling automation stops the machine.
   */
  applyConfig(config: AutomationConfig): TransitionResult {
    this.mode = config.mode;
    if (!config.globalEnabled) {
      return this.dispatch({ type: 'stop' });
    }
    if (config.globalPaused) {
      return this.dispatch({ type: 'pause' });
    }
    if (this.state === 'stopped') return this.dispatch({ type: 'arm' });
    if (this.state === 'paused') return this.dispatch({ type: 'resume' });
    if (config.mode !== 'auto' && this.state === 'waiting-delay') {
      return this.set('ready', 'auto mode disabled — pending send cancelled');
    }
    return { state: this.state, changed: true, action: 'none' };
  }

  /** Snapshot for the UI and for logging. */
  snapshot() {
    return {
      state: this.state,
      mode: this.mode,
      conversation: this.activeConversation,
      error: this.lastError,
      sent: this.sentCount,
      isStopped: this.isStopped,
      isPaused: this.isPaused,
      isBusy: this.isBusy,
    };
  }

  private set(state: AutomationState, reason?: string, action: TransitionResult['action'] = 'none'): TransitionResult {
    const changed = state !== this.state;
    this.state = state;
    return { state, changed, action, reason };
  }

  private noop(reason: string): TransitionResult {
    return { state: this.state, changed: false, action: 'none', reason };
  }
}

/** Human-readable state labels for the overlay. */
export const STATE_LABELS: Record<AutomationState, string> = {
  idle: 'Idle',
  generating: 'Generating…',
  ready: 'Suggestions ready',
  inserting: 'Inserting…',
  'awaiting-confirm': 'Awaiting your confirmation',
  'waiting-delay': 'Waiting before send…',
  sending: 'Sending…',
  sent: 'Sent',
  paused: 'Paused',
  stopped: 'STOPPED',
  error: 'Error',
};
