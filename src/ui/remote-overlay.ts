import { MSG } from '@/shared/types';
import type { OverlayIntent } from '@/shared/types';
import { rpc } from '@/shared/rpc';
import { log } from '@/core/logging/logger';
import type { OverlayState } from '@/ui/overlay';
import type { OverlaySurface } from '@/ui/surface';

/**
 * A panel that lives in another frame.
 *
 * Used by a chat frame on a platform where the conversation is embedded (CooMeet
 * serves the chat on iframe.coomeet.com). The chat frame has the data — the
 * messages, the composer, the memory — but a floating panel drawn there would be
 * clipped to the iframe, so the *top* frame draws it instead. This class is the
 * chat frame's side of that split: it keeps the authoritative state locally and
 * publishes it, and it never touches the DOM.
 *
 * The transport is the service worker, because the two frames are on different
 * origins and cannot talk to each other directly.
 */
export class RemoteOverlay implements OverlaySurface {
  private state: Partial<OverlayState> = {};
  private mounted = false;
  private mirrorAvailable = false;

  get isMounted(): boolean {
    return this.mounted;
  }

  /**
   * The mirror announces itself once it has rendered. Until then, publishes are
   * still sent: the background queues nothing, so an early publish may be
   * dropped, but the chat frame re-publishes on every state change and the
   * mirror requests a fresh snapshot when it appears.
   */
  markMirrorReady(): void {
    this.mirrorAvailable = true;
    void this.publish();
  }

  mount(): void {
    this.mounted = true;
    void this.publish();
  }

  unmount(): void {
    this.mounted = false;
  }

  update(patch: Partial<OverlayState>): void {
    Object.assign(this.state, patch);
    void this.publish();
  }

  /**
   * Toasts are state in the mirror, not a separate channel: the top frame shows
   * them in its own panel, so a failed publish is the only thing that can be
   * lost and the next update carries the state anyway.
   */
  toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ms = 4200): void {
    void this.publish({ toast: { message, kind, ms } });
  }

  getState(): Readonly<OverlayState> {
    return this.state as Readonly<OverlayState>;
  }

  private async publish(extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.mounted) return;
    try {
      await rpc(MSG.OVERLAY_SYNC, {
        state: { ...this.state, ...extra },
        // The chat frame is the data owner; it names the conversation so the
        // mirror can label the panel even before it has any memory loaded.
        mounted: this.mounted,
      });
    } catch (err) {
      // A closed tab or a torn-down service worker: the frame is going away and
      // there is nothing useful to report to the operator.
      log.debug('overlay', 'mirror publish failed', err);
    }
  }

  /**
   * Re-sends the current state.
   *
   * Needed because the renderer can mount after this frame's first publish, in
   * which case that message had nowhere to go and the panel would stay blank.
   */
  republish(): void {
    void this.publish();
  }

  /** Whether a mirror has ever announced itself for this frame. */
  get hasMirror(): boolean {
    return this.mirrorAvailable;
  }
}

/** What the chat frame does when the mirror forwards an operator action. */
export type IntentHandler = (intent: OverlayIntent) => void;

let intentHandler: IntentHandler | null = null;

/** Registers the chat frame's handler for actions taken in the mirrored panel. */
export function onOverlayIntent(handler: IntentHandler): void {
  intentHandler = handler;
}

/** Called by the content script's message listener when an intent arrives. */
export function dispatchOverlayIntent(intent: OverlayIntent): void {
  intentHandler?.(intent);
}
