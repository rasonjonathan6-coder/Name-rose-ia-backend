import { describe, expect, it, vi } from 'vitest';
import { enableSite, originFor, scriptIdFor, type SiteAccessApi } from '@/background/site-access';

/**
 * A fake chrome surface that records what ROSE asked for. The assertions are on
 * the calls ROSE makes, since the real browser permission prompt cannot run in
 * a test process.
 */
function fakeApi(over: {
  contains?: boolean;
  request?: boolean;
  registered?: Array<{ id: string }>;
  queryTabs?: Array<{ id?: number; url?: string }>;
  failRegistration?: boolean;
} = {}) {
  const calls = {
    contains: [] as string[][],
    request: [] as string[][],
    registered: [] as Array<{ id: string; matches: string[]; js: string[] }>,
    executed: [] as Array<{ target: { tabId: number }; files: string[] }>,
  };

  const api: SiteAccessApi = {
    permissions: {
      contains: async ({ origins }) => {
        calls.contains.push(origins);
        return over.contains ?? false;
      },
      request: async ({ origins }) => {
        calls.request.push(origins);
        return over.request ?? true;
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

describe('enableSite', () => {
  it('requests permission then registers and injects the content script', async () => {
    const { api, calls } = fakeApi({ contains: false, request: true, queryTabs: [{ id: 7, url: 'https://chat.example.com/room' }] });

    const res = await enableSite(api, 'chat.example.com');

    expect(res).toEqual({ ok: true, host: 'chat.example.com', origin: 'https://chat.example.com/*' });
    expect(calls.request).toEqual([['https://chat.example.com/*']]);
    expect(calls.registered).toEqual([
      {
        id: 'rose-chat-example-com',
        matches: ['https://chat.example.com/*'],
        js: ['content.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ]);
    expect(calls.executed).toEqual([{ target: { tabId: 7 }, files: ['content.js'] }]);
  });

  it('does not re-prompt when permission is already held', async () => {
    const { api, calls } = fakeApi({ contains: true, queryTabs: [] });

    const res = await enableSite(api, 'chat.example.com');

    expect(res.ok).toBe(true);
    expect(calls.request).toEqual([]);
    expect(calls.registered).toHaveLength(1);
  });

  it('does not register a duplicate script for an already-registered host', async () => {
    const { api, calls } = fakeApi({ contains: true, registered: [{ id: 'rose-chat-example-com' }] });

    const res = await enableSite(api, 'chat.example.com');

    expect(res.ok).toBe(true);
    expect(calls.registered).toEqual([]);
  });

  it('fails cleanly when the user denies the permission', async () => {
    const { api, calls } = fakeApi({ contains: false, request: false });

    const res = await enableSite(api, 'chat.example.com');

    expect(res).toEqual({ ok: false, error: 'Permission was not granted.' });
    expect(calls.registered).toEqual([]);
  });

  it('reports a registration failure instead of throwing', async () => {
    const { api } = fakeApi({ contains: true, failRegistration: true });

    const res = await enableSite(api, 'chat.example.com');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('could not be registered');
  });

  it('rejects an empty host', async () => {
    const { api } = fakeApi();
    expect(await enableSite(api, '')).toEqual({ ok: false, error: 'No host supplied.' });
  });

  it('surfaces a permissions-API error rather than rejecting', async () => {
    const { api } = fakeApi();
    api.permissions.contains = vi.fn(async () => {
      throw new Error('permissions unavailable');
    });

    const res = await enableSite(api, 'chat.example.com');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('permissions unavailable');
  });

  it('skips injection when the active tab is a different host', async () => {
    const { api, calls } = fakeApi({ contains: true, queryTabs: [{ id: 3, url: 'https://other.example.com/x' }] });

    const res = await enableSite(api, 'chat.example.com');

    expect(res.ok).toBe(true);
    expect(calls.executed).toEqual([]);
  });
});
