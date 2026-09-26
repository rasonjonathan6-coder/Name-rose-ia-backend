import { describe, expect, it } from 'vitest';
import {
  decideFrameRole,
  shouldMountOverlay,
  shouldRunPipeline,
  frameKey,
  type FrameRole,
} from '@/content/frame-role';

/**
 * Frame-role policy.
 *
 * Real-world driver: CooMeet serves its marketing shell on www.coomeet.com and
 * mounts the actual chat inside a cross-origin child frame on
 * iframe.coomeet.com. With `all_frames: false` the content script only ever ran
 * in the shell, so the chat was invisible to ROSE.
 *
 * The fix attaches to child frames too, which introduces a new risk: one ROSE
 * overlay per frame. These tests pin the policy that prevents that — the chat
 * frame runs the pipeline, but only the top frame owns the UI.
 */

describe('decideFrameRole', () => {
  it('marks the top document of an allowed host as the top frame', () => {
    expect(decideFrameRole({ isTopFrame: true, platformClaimsHost: true, chatDetected: false })).toBe('top');
  });

  it('marks a child frame that exposes a chat surface as a chat frame', () => {
    expect(decideFrameRole({ isTopFrame: false, platformClaimsHost: true, chatDetected: true })).toBe('chat');
  });

  it('ignores a child frame with no chat surface (ads, analytics, trackers)', () => {
    // googletagmanager / consent iframes must never get a ROSE pipeline.
    expect(decideFrameRole({ isTopFrame: false, platformClaimsHost: true, chatDetected: false })).toBe('ignored');
  });

  it('ignores a child frame whose host no adapter claims', () => {
    expect(decideFrameRole({ isTopFrame: false, platformClaimsHost: false, chatDetected: true })).toBe('ignored');
  });

  it('still serves the top frame on an unclaimed host (generic adapter)', () => {
    // The generic adapter is the whole point of ROSE; requiring a claim on the
    // top frame would disable it on every site without a dedicated adapter.
    expect(decideFrameRole({ isTopFrame: true, platformClaimsHost: false, chatDetected: true })).toBe('top');
    expect(decideFrameRole({ isTopFrame: true, platformClaimsHost: false, chatDetected: false })).toBe('top');
  });

  it('is deterministic — the same input always yields the same role', () => {
    const input = { isTopFrame: false, platformClaimsHost: true, chatDetected: true } as const;
    const roles = new Set<FrameRole>([decideFrameRole(input), decideFrameRole(input), decideFrameRole(input)]);
    expect(roles.size).toBe(1);
    expect([...roles][0]).toBe('chat');
  });

  it('re-evaluates a chat frame that loses its chat surface (SPA navigation)', () => {
    // The chat frame is torn down when the operator leaves the conversation.
    expect(decideFrameRole({ isTopFrame: false, platformClaimsHost: true, chatDetected: true })).toBe('chat');
    expect(decideFrameRole({ isTopFrame: false, platformClaimsHost: true, chatDetected: false })).toBe('ignored');
  });

  it('covers the CooMeet shape: shell top frame + chat child frame', () => {
    // www.coomeet.com — no composer in the shell.
    expect(decideFrameRole({ isTopFrame: true, platformClaimsHost: true, chatDetected: false })).toBe('top');
    // iframe.coomeet.com — the composer lives here.
    expect(decideFrameRole({ isTopFrame: false, platformClaimsHost: true, chatDetected: true })).toBe('chat');
    // about:blank sibling frame.
    expect(decideFrameRole({ isTopFrame: false, platformClaimsHost: true, chatDetected: false })).toBe('ignored');
  });
});

describe('shouldMountOverlay', () => {
  it('mounts the overlay in the top frame', () => {
    expect(shouldMountOverlay('top')).toBe(true);
  });

  it('never mounts a second overlay inside a chat frame', () => {
    expect(shouldMountOverlay('chat')).toBe(false);
  });

  it('never mounts an overlay in an ignored frame', () => {
    expect(shouldMountOverlay('ignored')).toBe(false);
  });

  it('a page with no iframe still gets exactly one overlay', () => {
    const roles: FrameRole[] = [decideFrameRole({ isTopFrame: true, platformClaimsHost: true, chatDetected: true })];
    expect(roles.filter(shouldMountOverlay)).toHaveLength(1);
  });

  it('the CooMeet frame tree yields exactly one overlay', () => {
    const roles = [
      decideFrameRole({ isTopFrame: true, platformClaimsHost: true, chatDetected: false }),
      decideFrameRole({ isTopFrame: false, platformClaimsHost: true, chatDetected: true }),
      decideFrameRole({ isTopFrame: false, platformClaimsHost: true, chatDetected: false }),
    ];
    expect(roles.filter(shouldMountOverlay)).toHaveLength(1);
  });

  it('a page with an irrelevant iframe yields exactly one overlay', () => {
    const roles = [
      decideFrameRole({ isTopFrame: true, platformClaimsHost: true, chatDetected: true }),
      decideFrameRole({ isTopFrame: false, platformClaimsHost: false, chatDetected: false }),
    ];
    expect(roles.filter(shouldMountOverlay)).toHaveLength(1);
  });
});

describe('shouldRunPipeline', () => {
  it('runs the pipeline in the top frame', () => {
    expect(shouldRunPipeline('top')).toBe(true);
  });

  it('runs the pipeline in a chat frame', () => {
    expect(shouldRunPipeline('chat')).toBe(true);
  });

  it('runs nothing in an ignored frame', () => {
    expect(shouldRunPipeline('ignored')).toBe(false);
  });

  it('the CooMeet tree runs exactly one overlay but two pipelines', () => {
    const roles: FrameRole[] = [
      decideFrameRole({ isTopFrame: true, platformClaimsHost: true, chatDetected: false }),
      decideFrameRole({ isTopFrame: false, platformClaimsHost: true, chatDetected: true }),
      decideFrameRole({ isTopFrame: false, platformClaimsHost: true, chatDetected: false }),
    ];
    expect(roles.filter(shouldMountOverlay)).toHaveLength(1);
    expect(roles.filter(shouldRunPipeline)).toHaveLength(2);
  });
});

describe('frameKey', () => {
  it('is stable for the same tab/frame/url', () => {
    expect(frameKey(7, 3, 'https://iframe.coomeet.com/?id=1')).toBe(
      frameKey(7, 3, 'https://iframe.coomeet.com/?id=1'),
    );
  });

  it('distinguishes two frames in the same tab', () => {
    expect(frameKey(7, 1, 'https://x.test/')).not.toBe(frameKey(7, 2, 'https://x.test/'));
  });

  it('distinguishes the same frame id across tabs', () => {
    expect(frameKey(7, 0, 'https://x.test/')).not.toBe(frameKey(8, 0, 'https://x.test/'));
  });

  it('changes when the frame navigates', () => {
    expect(frameKey(7, 3, 'https://a.test/')).not.toBe(frameKey(7, 3, 'https://b.test/'));
  });

  it('handles a missing tab id without throwing', () => {
    expect(() => frameKey(null, 0, 'https://x.test/')).not.toThrow();
    expect(frameKey(null, 0, 'https://x.test/')).toContain('0');
  });
});
