/**
 * Runtime host access — post-grant activation.
 *
 * The manifest can only declare content scripts for a fixed list of origins, so
 * any other chat platform — the whole point of the generic adapter — needs the
 * user to grant its host at runtime. This module owns everything that happens
 * *after* that grant: verify it, register a persistent dynamic content script,
 * and inject into the current tab so the user does not have to reload.
 *
 * It deliberately cannot request the permission. `chrome.permissions.request()`
 * is only legal while a user gesture is being handled, and this code runs in the
 * service worker, which never receives one — calling it here is what produced
 * "This function must be called during a user gesture". The popup owns the
 * request (see `src/popup/site-grant.ts`); the background only consumes the
 * result. The `SiteAccessApi` type has no `request` member so the mistake cannot
 * be reintroduced without a compile error.
 */

import { log } from '@/core/logging/logger';

/** The subset of the chrome API this module needs, so it can be faked in tests. */
export interface SiteAccessApi {
  permissions: {
    contains(details: { origins: string[] }): Promise<boolean>;
  };
  scripting: {
    getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<Array<{ id: string }>>;
    registerContentScripts(
      scripts: Array<{
        id: string;
        matches: string[];
        js: string[];
        runAt: 'document_idle';
        allFrames: boolean;
        persistAcrossSessions: boolean;
      }>,
    ): Promise<void>;
    executeScript(
      details: { target: { tabId: number; allFrames?: boolean }; files: string[] },
    ): Promise<unknown>;
  };
  tabs: {
    query(query: { active: true; currentWindow: true }): Promise<Array<{ id?: number; url?: string }>>;
  };
}

export type SiteAccessResult =
  | { ok: true; host: string; origin: string }
  | { ok: false; error: string };

/** Origin pattern ROSE requests for a hostname. */
export function originFor(host: string): string {
  return `https://${host}/*`;
}

/** Deterministic, chrome-valid content script id for a hostname. */
export function scriptIdFor(host: string): string {
  return `rose-${host.replace(/[^a-z0-9]+/gi, '-')}`;
}

/**
 * Activates ROSE on `host`, assuming the host permission has already been
 * granted by the popup. Registers the content script and injects into the
 * current tab.
 *
 * The grant is re-checked rather than trusted, because this is reachable by
 * message: it must not be possible to register a content script for an origin
 * the user never approved.
 *
 * Every failure is returned rather than thrown so the caller can surface a
 * clear message instead of an unhandled rejection.
 */
export async function activateSite(api: SiteAccessApi, host: string): Promise<SiteAccessResult> {
  if (!host) return { ok: false, error: 'No host supplied.' };

  const origin = originFor(host);

  try {
    const granted = await api.permissions.contains({ origins: [origin] });
    if (!granted) {
      return {
        ok: false,
        error: 'ROSE does not have permission for this site yet. Open the popup and click “Enable ROSE on this host”.',
      };
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not verify permission: ${text}` };
  }

  const scriptId = scriptIdFor(host);
  try {
    const existing = await api.scripting.getRegisteredContentScripts({ ids: [scriptId] });
    if (existing.length === 0) {
      await api.scripting.registerContentScripts([
        {
          id: scriptId,
          matches: [origin],
          js: ['content.js'],
          runAt: 'document_idle',
          // Mirrors the manifest: a chat platform may host its chat in a child
          // frame (CooMeet), so the dynamically-registered script must reach
          // those frames too.
          allFrames: true,
          persistAcrossSessions: true,
        },
      ]);
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    log.error('background', 'failed to register content script', text);
    return { ok: false, error: `Permission granted, but the script could not be registered: ${text}` };
  }

  // Best-effort: inject now so the user sees ROSE without reloading. A failure
  // here is harmless — the registered script covers the next page load.
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab?.id !== undefined && tab.url && hostOfUrl(tab.url) === host) {
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    }
  } catch {
    /* ignore */
  }

  log.info('background', `site enabled: ${host}`);
  return { ok: true, host, origin };
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
