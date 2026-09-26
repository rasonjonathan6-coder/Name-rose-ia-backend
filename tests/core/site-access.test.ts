import { describe, expect, it, vi } from 'vitest';
import { activateSite, originFor, scriptIdFor, type SiteAccessApi } from '@/background/site-access';

/**
 * A fake chrome surface that records what ROSE asked for. The assertions are on
 * the calls ROSE makes, since the real browser permission prompt cannot run in
 * a test process.
 *
 * Note there is no `request` recorder: `activateSite` must never be able to ask
 * for permission, because it runs in the service worker where Chrome rejects
 * the call outright.
 */
function fakeApi(over: {
  contains?: boolean;
  registered?: Array<{ id: string }>;
  queryTabs?: Array<{ id?: number; url?: string }>;
  failRegistration?: boolean;
} = {}) {
  const calls = {
    contains: [] as string[][],
    registered: [] as Array<{ id: string; matches: string[]; js: string[]; allFrames?: boolean }>,
    executed: [] as Array<{ target: { tabId: number }; files: string[] }>,
  };

  const api: SiteAccessApi = {
    permissions: {
      contains: async ({ origins }) => {
        calls.contains.push(origins);
        return over.contains ?? false;
      },
    },
    scripting: {
      getRegisteredContentScripts: async () => over.registered ?? [],
      registerContentScripts: async (scripts) => {
        if (over.failRegistration) throw new Error('duplicate id');
        calls.registered.push(...scripts);
      },
      executeScript: async (details) => {
        calls.executed.push(details);
      },
    },
    tabs: {
      query: async () => over.queryTabs ?? [],
    },
  };

  return { api, calls };
}

describe('site access helpers', () => {
  it('builds an https origin pattern for a host', () => {
    expect(originFor('chat.example.com')).toBe('https://chat.example.com/*');
  });

  it('builds a deterministic, chrome-valid script id', () => {
    expect(scriptIdFor('chat.example.com')).toBe('rose-chat-example-com');
    expect(scriptIdFor('chat.example.com')).toBe(scriptIdFor('chat.example.com'));
  });
});

describe('activateSite (post-grant activation)', () => {
  it('registers and injects the content script when the grant is held', async () => {
    const { api, calls } = fakeApi({ contains: true, queryTabs: [{ id: 7, url: 'https://chat.example.com/room' }] });

    const res = await activateSite(api, 'chat.example.com');

    expect(res).toEqual({ ok: true, host: 'chat.example.com', origin: 'https://chat.example.com/*' });
    expect(calls.registered).toEqual([
      {
        id: 'rose-chat-example-com',
        matches: ['https://chat.example.com/*'],
        js: ['content.js'],
        runAt: 'document_idle',
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
    expect(calls.executed).toEqual([{ target: { tabId: 7 }, files: ['content.js'] }]);
  });

  it('registers the dynamic script for child frames too (CooMeet hosts its chat in one)', async () => {
    const { api, calls } = fakeApi({ contains: true, queryTabs: [] });
    await activateSite(api, 'coomeet.com');
    expect(calls.registered[0]!.allFrames).toBe(true);
  });

  it('never requests permission — only checks it', async () => {
    const { api, calls } = fakeApi({ contains: true });

    await activateSite(api, 'chat.example.com');

    // The fake has no `request` method at all, so reaching for it would throw.
    expect(calls.contains).toEqual([['https://chat.example.com/*']]);
  });

  it('refuses to activate a host the user has not granted', async () => {
    const { api, calls } = fakeApi({ contains: false });

    const res = await activateSite(api, 'chat.example.com');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('does not have permission');
    expect(calls.registered).toEqual([]);
    expect(calls.executed).toEqual([]);
  });

  it('does not register a duplicate script for an already-registered host', async () => {
    const { api, calls } = fakeApi({ contains: true, registered: [{ id: 'rose-chat-example-com' }] });

    const res = await activateSite(api, 'chat.example.com');

    expect(res.ok).toBe(true);
    expect(calls.registered).toEqual([]);
  });

  it('reports a registration failure instead of throwing', async () => {
    const { api } = fakeApi({ contains: true, failRegistration: true });

    const res = await activateSite(api, 'chat.example.com');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('could not be registered');
  });

  it('rejects an empty host', async () => {
    const { api } = fakeApi();
    expect(await activateSite(api, '')).toEqual({ ok: false, error: 'No host supplied.' });
  });

  it('surfaces a permissions-API error rather than rejecting', async () => {
    const { api } = fakeApi();
    api.permissions.contains = vi.fn(async () => {
      throw new Error('permissions unavailable');
    });

    const res = await activateSite(api, 'chat.example.com');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('permissions unavailable');
  });

  it('skips injection when the active tab is a different host', async () => {
    const { api, calls } = fakeApi({ contains: true, queryTabs: [{ id: 3, url: 'https://other.example.com/x' }] });

    const res = await activateSite(api, 'chat.example.com');

    expect(res.ok).toBe(true);
    expect(calls.executed).toEqual([]);
  });
});
