/**
 * Frame-role policy.
 *
 * Why this exists: CooMeet serves a marketing shell on `www.coomeet.com` and
 * mounts the actual chat inside a cross-origin child frame on
 * `iframe.coomeet.com`. With `all_frames: false` the content script only ever
 * ran in the shell, so ROSE saw no composer and no messages — the chat was
 * structurally invisible.
 *
 * Attaching to child frames fixes detection but introduces a new failure mode:
 * one ROSE overlay per frame. This module is the pure decision layer that keeps
 * exactly one frame in charge of the UI while still letting the frame that
 * actually holds the chat run the pipeline.
 *
 * The three roles:
 *   top     — the top-level document. Runs the pipeline and owns the UI.
 *   chat    — a child frame on a claimed host that exposes a chat surface.
 *             Runs the pipeline; deliberately mounts no UI.
 *   ignored — everything else (ads, consent widgets, trackers, a child frame
 *             with no chat). Runs nothing at all.
 *
 * Kept free of DOM and chrome APIs so the policy is unit-testable.
 */

export type FrameRole = 'top' | 'chat' | 'ignored';

export interface FrameRoleInput {
  /** `window.top === window`, computed safely for cross-origin frames. */
  isTopFrame: boolean;
  /**
   * Whether a platform adapter or a user site-config explicitly claims this
   * frame's host. The manifest's match patterns already gate *which* origins the
   * content script can run on, so this is the finer filter: it separates
   * "a chat platform we know about" from "some other frame that happens to be
   * injected into".
   */
  platformClaimsHost: boolean;
  /** Whether a reply field or message container resolved in this frame. */
  chatDetected: boolean;
}

/**
 * Decides what a frame is allowed to do.
 *
 * The top frame is always `top`, even on an unclaimed host: that is the generic
 * adapter's whole purpose, and requiring a claim there would disable ROSE on
 * every site without a dedicated adapter.
 */
export function decideFrameRole(input: FrameRoleInput): FrameRole {
  if (input.isTopFrame) return 'top';
  if (!input.platformClaimsHost) return 'ignored';
  return input.chatDetected ? 'chat' : 'ignored';
}

/**
 * Whether this frame should mount the floating overlay.
 *
 * Only the top frame mounts it. A chat frame runs detection and generation but
 * stays UI-free, because for the CooMeet shape the chat frame is an
 * implementation detail of the shell page the operator is actually looking at,
 * and a second overlay inside it would be a duplicate.
 */
export function shouldMountOverlay(role: FrameRole): boolean {
  return role === 'top';
}

/**
 * Whether this frame should run message detection and the reply pipeline.
 * Both the top frame and a chat frame do; an ignored frame does not.
 */
export function shouldRunPipeline(role: FrameRole): boolean {
  return role !== 'ignored';
}

/**
 * Stable identity for a frame within a tab.
 *
 * The tab/frame ids come from the extension's own message sender metadata, not
 * from the page, so a page cannot impersonate another frame. The URL is included
 * so that a frame navigation (same frameId, new document) yields a new key —
 * which is what makes "frame recreated" observable downstream.
 */
export function frameKey(tabId: number | null | undefined, frameId: number, url: string): string {
  return `${tabId ?? 'no-tab'}:${frameId}:${url}`;
}
