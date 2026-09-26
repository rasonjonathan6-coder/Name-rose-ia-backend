import type { OverlayState } from '@/ui/overlay';

/**
 * The surface a controller needs from a floating panel.
 *
 * The chat frame on a multi-frame platform does not draw the panel itself — the
 * top frame does, because a `position: fixed` panel inside an iframe is clipped
 * to that iframe and could not be dragged over the rest of the window. Both a
 * real `RoseOverlay` and a mirror that forwards to another frame implement this,
 * so the controller's code is identical either way.
 */
export interface OverlaySurface {
  mount(): void;
  unmount(): void;
  update(patch: Partial<OverlayState>): void;
  toast(message: string, kind?: 'info' | 'error' | 'success', ms?: number): void;
  getState(): Readonly<OverlayState>;
  readonly isMounted: boolean;
}
