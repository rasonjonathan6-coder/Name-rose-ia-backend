import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasHostPermission, requestHostPermission } from '@/popup/site-grant';

/**
 * `chrome.permissions.request()` only works inside a user gesture, so the point
 * of these tests is not just "does it call the API" but "does it call it at the
 * right moment, from the right context, and never on its own".
 *
 * The fake records a `gesture` flag the way Chrome would: it is true only when
 * the call happens synchronously within the click dispatch.
 */

interface FakeChrome {
  permissions: {
    contains: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
  };
}

let gestureActive = false;

function installFakeChrome(over: { contains?: boolean; request?: boolean; throwOnRequest?: string } = {}) {
  const calls = { contains: [] as string[][], request: [] as string[][], requestDuringGesture: [] as boolean[] };

  const chrome: FakeChrome = {
    permissions: {
      contains: vi.fn(async ({ origins }: { origins: string[] }) => {
        calls.contains.push(origins);
        return over.contains ?? false;
      }),
      request: vi.fn(async ({ origins }: { origins: string[] }) => {
        calls.request.push(origins);
        // Chrome throws when there is no gesture behind the call.
        calls.requestDuringGesture.push(gestureActive);
        if (over.throwOnRequest) throw new Error(over.throwOnRequest);
        return over.request ?? true;
      }),
    },
  };

  (globalThis as unknown as { chrome?: unknown }).chrome = chrome;
  return calls;
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  gestureActive = false;
});

describe('hasHostPermission (never prompts)', () => {
  it('reports a held grant', async () => {
    const calls = installFakeChrome({ contains: true });
    expect(await hasHostPermission('chat.example.com')).toBe(true);
    expect(calls.request).toEqual([]);
  });

  it('reports a missing grant without requesting it', async () => {
    const calls = installFakeChrome({ contains: false });
    expect(await hasHostPermission('chat.example.com')).toBe(false);
    expect(calls.request).toEqual([]);
  });

  it('checks the https origin pattern for the host', async () => {
    const calls = installFakeChrome({ contains: true });
    await hasHostPermission('chat.example.com');
    expect(calls.contains).toEqual([['https://chat.example.com/*']]);
  });

  it('does not prompt for an empty host', async () => {
    const calls = installFakeChrome({ contains: false });
    expect(await hasHostPermission('')).toBe(false);
    expect(calls.request).toEqual([]);
    expect(calls.contains).toEqual([]);
  });

  it('does not nag when the browser cannot answer', async () => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    expect(await hasHostPermission('chat.example.com')).toBe(true);
  });
});

describe('requestHostPermission (click-handler only)', () => {
  it('requests during the gesture and reports success', async () => {
    const calls = installFakeChrome({ request: true });

    // Simulate the click dispatch: the handler runs while the gesture is live.
    gestureActive = true;
    const res = await requestHostPermission('chat.example.com');
    gestureActive = false;

    expect(res).toEqual({ granted: true });
    expect(calls.request).toEqual([['https://chat.example.com/*']]);
    expect(calls.requestDuringGesture).toEqual([true]);
  });

  it('reports a refusal with a message naming the host', async () => {
    const calls = installFakeChrome({ request: false });

    gestureActive = true;
    const res = await requestHostPermission('chat.example.com');
    gestureActive = false;

    expect(res.granted).toBe(false);
    if (!res.granted) {
      expect(res.error).toContain('chat.example.com');
      expect(res.error).toContain('did not grant');
    }
    expect(calls.request).toHaveLength(1);
  });

  it('surfaces a gesture error instead of throwing', async () => {
    installFakeChrome({ throwOnRequest: 'This function must be called during a user gesture' });

    gestureActive = true;
    const res = await requestHostPermission('chat.example.com');
    gestureActive = false;

    expect(res.granted).toBe(false);
    if (!res.granted) expect(res.error).toContain('user gesture');
  });

  it('does not call the API for an empty host', async () => {
    const calls = installFakeChrome();
    const res = await requestHostPermission('');
    expect(res.granted).toBe(false);
    expect(calls.request).toEqual([]);
  });

  it('reports clearly when the permissions API is absent', async () => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    const res = await requestHostPermission('chat.example.com');
    expect(res.granted).toBe(false);
    if (!res.granted) expect(res.error).toContain('permissions API');
  });

  it('calls request synchronously — no await before it can consume the gesture', async () => {
    const calls = installFakeChrome({ request: true });

    // Calling it without any preceding await must keep the gesture. If the
    // implementation awaited anything first, this flag would already be false.
    gestureActive = true;
    const pending = requestHostPermission('chat.example.com');
    const gestureSeenAtCallTime = calls.requestDuringGesture.length === 1;
    await pending;
    gestureActive = false;

    expect(gestureSeenAtCallTime).toBe(true);
  });
});

describe('architectural guard: permission requests stay in the popup', () => {
  /**
   * The service worker cannot request permissions — Chrome rejects the call
   * because no gesture reaches it. Keeping every call site inside this one
   * popup module is what makes the gesture guarantee hold, so it is worth
   * pinning with a test rather than a comment.
   */
  it('only site-grant.ts calls permissions.request across src/', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(p)) files.push(p);
      }
    };
    walk('src');

    // Match a `.request(` reached through the permissions API, tolerating
    // intervening casts like `(chrome.permissions as any).request(`. Mentions in
    // comments and the API-shape probe (`permissions?.request`) are excluded.
    const callSite = /permissions[\s\S]{0,60}?\.request\s*\(/;
    const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
    const offenders = files.filter((f) => {
      if (f.endsWith('site-grant.ts')) return false;
      const src = readFileSync(f, 'utf8');
      // Strip block comments so prose describing the call is not a hit.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
      return code.split('\n').some((line) => callSite.test(line) && !isComment(line));
    });

    expect(offenders).toEqual([]);
  });

  it('the background module cannot request permission at all', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/background/site-access.ts', 'utf8');
    // The interface it accepts must not expose `request`, so a future edit that
    // tries to call it fails to typecheck rather than failing at runtime.
    expect(src).not.toMatch(/request\(details:/);
  });
});
