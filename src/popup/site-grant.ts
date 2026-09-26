/**
 * The one place that may ask Chrome for host permission.
 *
 * `chrome.permissions.request()` is only legal while a user gesture is being
 * handled. Two rules keep it that way:
 *
 *   1. It lives here, in the popup, not in the service worker. A message
 *      round-trip to the background loses the gesture, so a request issued
 *      there always fails with "This function must be called during a user
 *      gesture".
 *   2. `requestHostPermission` is only ever called from a click listener, as
 *      the first thing that listener does. Nothing in this module requests on
 *      load, on a timer, on tab change, or on navigation.
 *
 * The grant itself is written by Chrome; `activateSite` in the background then
 * registers and injects the content script.
 */

import { originFor } from '@/background/site-access';

/** The subset of the chrome API this module needs, so it can be faked in tests. */
export interface HostGrantApi {
  permissions: {
    contains(details: { origins: string[] }): Promise<boolean>;
    request(details: { origins: string[] }): Promise<boolean>;
  };
}

export type HostGrantResult = { granted: true } | { granted: false; error: string };

function chromeApi(): HostGrantApi | null {
  const g = globalThis as unknown as { chrome?: Partial<HostGrantApi> };
  const api = g.chrome;
  if (!api?.permissions?.contains || !api?.permissions?.request) return null;
  return api as HostGrantApi;
}

/**
 * True when ROSE already holds this host, from the static manifest list or a
 * previous runtime grant. Never prompts.
 *
 * Returns `true` when the API is unavailable, so a browser that cannot answer
 * does not get a permission nag it cannot act on.
 */
export async function hasHostPermission(host: string): Promise<boolean> {
  if (!host) return false;
  const api = chromeApi();
  if (!api) return true;
  try {
    return await api.permissions.contains({ origins: [originFor(host)] });
  } catch {
    return true;
  }
}

/**
 * Requests host permission for `host`.
 *
 * MUST be called synchronously from within a user-gesture handler — the browser
 * checks the gesture at call time, so any `await` before this point discards it.
 * Callers should not await anything before invoking this.
 */
export async function requestHostPermission(host: string): Promise<HostGrantResult> {
  if (!host) return { granted: false, error: 'No host to request.' };

  const api = chromeApi();
  if (!api) return { granted: false, error: 'This browser does not expose the permissions API.' };

  try {
    const granted = await api.permissions.request({ origins: [originFor(host)] });
    if (!granted) {
      return {
        granted: false,
        error: `Chrome did not grant access to ${host}. ROSE cannot run there without it.`,
      };
    }
    return { granted: true };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { granted: false, error: `Could not request permission: ${text}` };
  }
}
