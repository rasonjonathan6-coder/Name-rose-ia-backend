import { beforeEach, describe, expect, it } from 'vitest';
import { FrameArbiter } from '@/background/frame-arbiter';

/**
 * Frame arbitration: which frame holds the data, and which frame draws the panel.
 *
 * Two invariants are pinned here, and both were real failure modes:
 *
 *   * exactly one panel per tab, whatever the frame shape;
 *   * the panel is drawn by the top frame even when the chat lives in a child
 *     frame, because a `position: fixed` panel inside an iframe is clipped to
 *     that iframe and could not be moved over the rest of the window.
 */

describe('FrameArbiter — data owner vs renderer', () => {
  let arbiter: FrameArbiter;

  beforeEach(() => {
    arbiter = new FrameArbiter();
  });

  it('the CooMeet shape: chat frame owns the data, top frame renders it', () => {
    // www.coomeet.com — the shell, no composer of its own.
    expect(arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: false })).toEqual({
      mountIn: [],
      unmountIn: [],
    });

    // iframe.coomeet.com — the conversation.
    const d = arbiter.report({ tabId: 1, frameId: 3, role: 'chat', hasChat: true });
    expect(d.mountIn).toEqual([{ frameId: 0, mirrorFor: 3 }]);
    expect(arbiter.dataOwner(1)).toBe(3);
    expect(arbiter.renderer(1)).toBe(0);
  });

  it('the CooMeet shape in the other order also ends with one panel in the top frame', () => {
    const first = arbiter.report({ tabId: 1, frameId: 3, role: 'chat', hasChat: true });
    // The chat frame reports first: the top frame is told to render, mirroring 3.
    expect(first.mountIn).toEqual([{ frameId: 0, mirrorFor: 3 }]);
    // The shell's own report must not move or duplicate the panel.
    expect(arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: false })).toEqual({
      mountIn: [],
      unmountIn: [],
    });
    expect(arbiter.renderer(1)).toBe(0);
  });

  it('a single-frame page renders in place, with no mirror', () => {
    const d = arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: true });
    expect(d.mountIn).toEqual([{ frameId: 0, mirrorFor: null }]);
    expect(arbiter.dataOwner(1)).toBe(0);
    expect(arbiter.renderer(1)).toBe(0);
  });

  it('never mounts a panel in a child frame, even when the chat is there', () => {
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: false });
    arbiter.report({ tabId: 1, frameId: 3, role: 'chat', hasChat: true });
    // Frame 3 is never a renderer.
    expect(arbiter.renderer(1)).toBe(0);
    expect(arbiter.frames(1).find((f) => f.frameId === 3)?.hasChat).toBe(true);
  });

  it('a page with no chat anywhere gets no panel', () => {
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: false });
    expect(arbiter.renderer(1)).toBe('none');
    expect(arbiter.dataOwner(1)).toBe('none');
  });

  it('an ignored frame is never the data owner', () => {
    arbiter.report({ tabId: 1, frameId: 4, role: 'ignored', hasChat: true });
    expect(arbiter.dataOwner(1)).toBe('none');
    expect(arbiter.renderer(1)).toBe('none');
  });

  it('repeated identical reports are silent — no mount churn', () => {
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: true });
    for (let i = 0; i < 5; i++) {
      expect(arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: true })).toEqual({
        mountIn: [],
        unmountIn: [],
      });
    }
  });

  it('picks a stable data owner when several chat frames report', () => {
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: false });
    arbiter.report({ tabId: 1, frameId: 9, role: 'chat', hasChat: true });
    const d = arbiter.report({ tabId: 1, frameId: 3, role: 'chat', hasChat: true });
    expect(arbiter.dataOwner(1)).toBe(3);
    // The panel stays in the top frame; only its mirror source is retargeted.
    expect(d.unmountIn).toEqual([]);
    expect(d.mountIn).toEqual([{ frameId: 0, mirrorFor: 3 }]);
  });

  it('a chat frame that navigates away takes the panel with it', () => {
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: false });
    arbiter.report({ tabId: 1, frameId: 3, role: 'chat', hasChat: true });
    expect(arbiter.renderer(1)).toBe(0);

    const d = arbiter.forgetFrame(1, 3);
    expect(d.unmountIn).toEqual([0]);
    expect(arbiter.renderer(1)).toBe('none');
  });

  it('the panel follows the chat from one frame to another', () => {
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: false });
    arbiter.report({ tabId: 1, frameId: 3, role: 'chat', hasChat: true });
    arbiter.forgetFrame(1, 3);
    const d = arbiter.report({ tabId: 1, frameId: 5, role: 'chat', hasChat: true });
    expect(d.mountIn).toEqual([{ frameId: 0, mirrorFor: 5 }]);
    expect(arbiter.dataOwner(1)).toBe(5);
  });

  it('a chat frame that loses its chat surface stops being the data owner', () => {
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: false });
    arbiter.report({ tabId: 1, frameId: 3, role: 'chat', hasChat: true });
    const d = arbiter.report({ tabId: 1, frameId: 3, role: 'chat', hasChat: false });
    expect(d.unmountIn).toEqual([0]);
    expect(arbiter.dataOwner(1)).toBe('none');
  });

  it('the top frame regaining a chat keeps the panel but drops the mirror', () => {
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: false });
    arbiter.report({ tabId: 1, frameId: 3, role: 'chat', hasChat: true });
    const d = arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: true });
    // No unmount: the same panel simply renders locally now.
    expect(d.unmountIn).toEqual([]);
    expect(d.mountIn).toEqual([{ frameId: 0, mirrorFor: null }]);
    expect(arbiter.dataOwner(1)).toBe(0);
  });

  it('an ad iframe reporting first does not block the chat frame', () => {
    arbiter.report({ tabId: 1, frameId: 2, role: 'ignored', hasChat: false });
    arbiter.report({ tabId: 1, frameId: 4, role: 'ignored', hasChat: false });
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: false });
    const d = arbiter.report({ tabId: 1, frameId: 3, role: 'chat', hasChat: true });
    expect(d.mountIn).toEqual([{ frameId: 0, mirrorFor: 3 }]);
  });

  it('tabs are isolated from each other', () => {
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: true });
    arbiter.report({ tabId: 2, frameId: 0, role: 'top', hasChat: false });
    arbiter.report({ tabId: 2, frameId: 3, role: 'chat', hasChat: true });
    expect(arbiter.renderer(1)).toBe(0);
    expect(arbiter.dataOwner(1)).toBe(0);
    expect(arbiter.renderer(2)).toBe(0);
    expect(arbiter.dataOwner(2)).toBe(3);
  });

  it('closing a tab drops its state', () => {
    arbiter.report({ tabId: 1, frameId: 0, role: 'top', hasChat: true });
    arbiter.forgetTab(1);
    expect(arbiter.renderer(1)).toBe('none');
    expect(arbiter.frames(1)).toEqual([]);
  });

  it('forgetting an unknown frame is harmless', () => {
    expect(arbiter.forgetFrame(42, 7)).toEqual({ mountIn: [], unmountIn: [] });
  });
});
