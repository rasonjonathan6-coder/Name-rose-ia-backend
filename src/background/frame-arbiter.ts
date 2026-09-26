/**
 * Per-tab frame arbitration.
 *
 * The problem this solves: ROSE attaches to child frames (CooMeet serves its
 * shell on www.coomeet.com and its chat on iframe.coomeet.com). Attaching to
 * every frame naively would produce one floating panel per frame.
 *
 * There are two separate questions, and conflating them is what makes this
 * subtle:
 *
 *   1. Which frame holds the *data* — the messages, the composer, the memory?
 *      That is the frame that resolved a chat surface.
 *   2. Which frame *draws the panel*? Always the top frame, and only when some
 *      frame in the tab has a chat surface.
 *
 * The renderer is not the data owner because a `position: fixed` panel inside an
 * iframe is clipped to that iframe: it could not be dragged over the rest of the
 * window, which is a stated requirement. So on the CooMeet shape the chat frame
 * owns the data and publishes it, and the top frame renders it (see
 * ui/remote-overlay).
 *
 * When the top frame itself has the chat — Flirtify, generic sites, the demo —
 * both answers are frame 0 and nothing is mirrored.
 *
 * The arbiter is pure: it takes reports and returns decisions. It touches no
 * chrome API, so the policy is unit-testable and the background only has to
 * deliver the messages.
 */

export type ArbiterRole = 'top' | 'chat' | 'ignored';

export interface FrameReport {
  tabId: number;
  frameId: number;
  role: ArbiterRole;
  /** Whether the frame resolved a reply field or message container. */
  hasChat: boolean;
}

export interface ArbiterDecision {
  /** Frames that must mount the panel now, and whether as a mirror of another. */
  mountIn: Array<{ frameId: number; mirrorFor: number | null }>;
  /** Frames that must unmount it. */
  unmountIn: number[];
}

/** `'none'` means no frame in the tab has a chat surface. */
export type DataOwner = number | 'none';

interface FrameState {
  role: ArbiterRole;
  hasChat: boolean;
}

interface TabState {
  frames: Map<number, FrameState>;
  /** Last rendered frame, so decisions only fire on change. */
  renderer: DataOwner;
  /** Last data owner, so the renderer learns when its mirror source changes. */
  dataOwner: DataOwner;
}

export class FrameArbiter {
  private readonly tabs = new Map<number, TabState>();

  /**
   * Records what a frame reported and returns what should change.
   *
   * A frame that reports `ignored` is dropped from consideration entirely — that
   * is how an ad/consent iframe, or a chat frame that navigated away from the
   * conversation, stops being the data owner.
   */
  report(r: FrameReport): ArbiterDecision {
    let tab = this.tabs.get(r.tabId);
    if (!tab) {
      tab = { frames: new Map(), renderer: 'none', dataOwner: 'none' };
      this.tabs.set(r.tabId, tab);
    }

    if (r.role === 'ignored') tab.frames.delete(r.frameId);
    else tab.frames.set(r.frameId, { role: r.role, hasChat: r.hasChat });

    return this.reconcile(r.tabId);
  }

  /** Drops one frame (it navigated or was removed) and re-reconciles. */
  forgetFrame(tabId: number, frameId: number): ArbiterDecision {
    const tab = this.tabs.get(tabId);
    if (!tab) return { mountIn: [], unmountIn: [] };
    tab.frames.delete(frameId);
    return this.reconcile(tabId);
  }

  /** Drops a whole tab (closed). */
  forgetTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  /** The frame holding the chat data, or `'none'`. */
  dataOwner(tabId: number): DataOwner {
    return this.tabs.get(tabId)?.dataOwner ?? 'none';
  }

  /** The frame drawing the panel, or `'none'`. */
  renderer(tabId: number): DataOwner {
    return this.tabs.get(tabId)?.renderer ?? 'none';
  }

  /** Every frame currently registered for a tab, for diagnostics. */
  frames(tabId: number): Array<{ frameId: number } & FrameState> {
    const tab = this.tabs.get(tabId);
    if (!tab) return [];
    return [...tab.frames.entries()].map(([frameId, s]) => ({ frameId, ...s }));
  }

  /**
   * What a frame should do about the panel, asked *by* that frame.
   *
   * Needed because a decision can be taken before the frame it names has loaded
   * its content script: the chat frame usually reports first, so the top frame is
   * elected renderer while it is still starting up and the push notification is
   * lost. Rather than have the arbiter re-push on every report (which would spam)
   * each frame asks this after reporting, and gets the verdict that applies to it.
   */
  instructionFor(
    tabId: number,
    frameId: number,
  ): { render: boolean; mirrorFor: number | null; dataOwner: boolean } {
    const tab = this.tabs.get(tabId);
    if (!tab) return { render: false, mirrorFor: null, dataOwner: false };
    const renders = tab.renderer === frameId;
    return {
      render: renders,
      // Only meaningful for the renderer: null means it holds the data itself.
      mirrorFor: renders && tab.dataOwner !== 'none' && tab.dataOwner !== 0 ? tab.dataOwner : null,
      dataOwner: tab.dataOwner === frameId,
    };
  }

  private reconcile(tabId: number): ArbiterDecision {
    const tab = this.tabs.get(tabId);
    if (!tab) return { mountIn: [], unmountIn: [] };

    const nextData = computeDataOwner(tab);
    // The renderer is the top frame whenever there is anything to render.
    const nextRenderer: DataOwner = nextData === 'none' ? 'none' : 0;

    const prevData = tab.dataOwner;
    const prevRenderer = tab.renderer;
    tab.dataOwner = nextData;
    tab.renderer = nextRenderer;

    const unmountIn: number[] = [];
    const mountIn: Array<{ frameId: number; mirrorFor: number | null }> = [];

    if (prevRenderer !== nextRenderer) {
      // Renderer changed: the old one stands down, the new one mounts.
      if (prevRenderer !== 'none') unmountIn.push(prevRenderer);
      if (nextRenderer !== 'none') {
        mountIn.push({ frameId: nextRenderer, mirrorFor: mirrorSource(nextData) });
      }
    } else if (nextRenderer !== 'none' && prevData !== nextData) {
      // Same renderer, different data source: it must re-target its mirror. No
      // unmount/remount, so the panel does not visibly flicker.
      mountIn.push({ frameId: nextRenderer, mirrorFor: mirrorSource(nextData) });
    }

    return { mountIn, unmountIn };
  }
}

/**
 * The frame a renderer must mirror, or `null` when it holds the data itself.
 *
 * `'none'` cannot happen here in practice — a renderer only exists when some
 * frame has a chat — but returning `null` keeps the type honest rather than
 * casting the sentinel away.
 */
function mirrorSource(dataOwner: DataOwner): number | null {
  return typeof dataOwner === 'number' && dataOwner !== 0 ? dataOwner : null;
}

function computeDataOwner(tab: TabState): DataOwner {
  const top = tab.frames.get(0);
  if (top?.hasChat) return 0;

  const chatFrames = [...tab.frames.entries()]
    .filter(([, s]) => s.role === 'chat' && s.hasChat)
    .map(([frameId]) => frameId)
    .sort((a, b) => a - b);

  return chatFrames[0] ?? 'none';
}
