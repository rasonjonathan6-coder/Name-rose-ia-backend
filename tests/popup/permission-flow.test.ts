import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Popup permission-flow tests.
 *
 * These drive the real popup module — no module mocks — against a fake `chrome`
 * surface, and assert on the permission calls ROSE makes. The bug this guards
 * against is subtle: `chrome.permissions.request()` is only legal inside a user
 * gesture, so it must be reachable *only* from the Enable button's click
 * listener, and never while the popup is merely rendering.
 */

interface Harness {
  calls: { request: string[][]; contains: string[][]; registered: unknown[]; reloaded: number[] };
  /** Dispatches a real click, with the gesture flag set the way Chrome would. */
  click(el: Element): Promise<void>;
}

let gestureActive = false;

const SETTINGS_KEY = 'rose:settings';

/** A settings blob that clears the AI policy gate so the popup renders fully. */
function readySettings() {
  return {
    ai: {
      acknowledgedPolicy: true,
      activeProvider: 'openai',
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: '',
          model: 'mock',
          enabled: true,
          viaProxy: false,
          requiresKey: false,
        },
      ],
    },
  };
}

async function bootPopup(
  over: { url: string; granted?: boolean; denyRequest?: boolean } = { url: 'https://chat.example.com/room' },
): Promise<Harness> {
  const calls = {
    request: [] as string[][],
    contains: [] as string[][],
    registered: [] as unknown[],
    reloaded: [] as number[],
  };

  const storageMap = new Map<string, unknown>([[SETTINGS_KEY, readySettings()]]);

  const chrome = {
    storage: {
      local: {
        async get(keys: string[]) {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (storageMap.has(k)) out[k] = storageMap.get(k);
          return out;
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) storageMap.set(k, structuredClone(v));
        },
        async remove(keys: string[]) {
          for (const k of keys) storageMap.delete(k);
        },
        async clear() {
          storageMap.clear();
        },
      },
    },
    permissions: {
      contains: vi.fn(async ({ origins }: { origins: string[] }) => {
        calls.contains.push(origins);
        return over.granted ?? false;
      }),
      request: vi.fn(async ({ origins }: { origins: string[] }) => {
        if (!gestureActive) throw new Error('This function must be called during a user gesture');
        calls.request.push(origins);
        return !over.denyRequest;
      }),
    },
    scripting: {
      async getRegisteredContentScripts() {
        return [];
      },
      async registerContentScripts(scripts: unknown[]) {
        calls.registered.push(...scripts);
      },
      async executeScript() {
        return [];
      },
    },
    tabs: {
      async query() {
        return [{ id: 42, url: over.url, windowId: 1 }];
      },
      async reload(id: number) {
        calls.reloaded.push(id);
      },
      async create() {},
      async sendMessage() {
        throw new Error('no content script');
      },
    },
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p}`,
      async sendMessage(msg: { type: string; payload?: { host?: string } }) {
        // Mirrors the background handler: verify the grant, then register.
        if (msg.type === 'rose/site/activate') {
          const host = msg.payload?.host ?? '';
          const held = await chrome.permissions.contains({ origins: [`https://${host}/*`] });
          if (!held) return { ok: false, error: 'ROSE does not have permission for this site yet.' };
          await chrome.scripting.registerContentScripts([{ id: `rose-${host}`, matches: [`https://${host}/*`] }]);
          return { ok: true, host, origin: `https://${host}/*` };
        }
        return { ok: false, error: `unhandled ${msg.type}` };
      },
    },
  };

  (globalThis as unknown as { chrome?: unknown }).chrome = chrome;
  document.body.innerHTML = '<div id="root"></div>';

  // Importing the popup runs init(); it must render without prompting.
  vi.resetModules();
  await import('@/popup/popup');
  await vi.waitFor(() => {
    expect(document.querySelector('#root')!.children.length).toBeGreaterThan(0);
  });

  return {
    calls,
    async click(el: Element) {
      gestureActive = true;
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // Let the handler's awaits settle while the gesture is still "live".
        await new Promise((r) => setTimeout(r, 0));
      } finally {
        gestureActive = false;
      }
    },
  };
}

function enableButton(): HTMLButtonElement | null {
  const found = [...document.querySelectorAll('button')].find((b) => /Enable ROSE on/.test(b.textContent ?? ''));
  return (found as HTMLButtonElement | undefined) ?? null;
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  gestureActive = false;
  document.body.innerHTML = '';
});

describe('popup permission flow', () => {
  it('1. opening the popup on an ungranted host requests nothing', async () => {
    const h = await bootPopup({ url: 'https://chat.example.com/room', granted: false });
    expect(h.calls.request).toEqual([]);
  });

  it('2. shows the "Enable ROSE on" button for an ungranted host', async () => {
    await bootPopup({ url: 'https://chat.example.com/room', granted: false });
    expect(enableButton()).not.toBeNull();
    expect(enableButton()!.textContent).toContain('chat.example.com');
  });

  it('3. clicking Enable calls chrome.permissions.request', async () => {
    const h = await bootPopup({ url: 'https://chat.example.com/room', granted: false });
    await h.click(enableButton()!);
    expect(h.calls.request).toEqual([['https://chat.example.com/*']]);
  });

  it('4. a granted permission activates the host (register + reload)', async () => {
    const h = await bootPopup({ url: 'https://chat.example.com/room', granted: false });
    // The grant lands during the request, as Chrome would do.
    (globalThis as unknown as { chrome: { permissions: { contains: unknown } } }).chrome.permissions.contains = vi.fn(
      async () => true,
    );

    await h.click(enableButton()!);

    expect(h.calls.registered).toHaveLength(1);
    expect(h.calls.reloaded).toEqual([42]);
  });

  it('5. a refused permission shows an error and does not activate', async () => {
    const h = await bootPopup({ url: 'https://chat.example.com/room', granted: false, denyRequest: true });
    await h.click(enableButton()!);

    const toast = document.querySelector('.toast.error');
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain('chat.example.com');
    expect(h.calls.registered).toEqual([]);
    expect(h.calls.reloaded).toEqual([]);
  });

  it('6. re-opening the popup does not request again', async () => {
    const h = await bootPopup({ url: 'https://chat.example.com/room', granted: false });
    await h.click(enableButton()!);
    expect(h.calls.request).toHaveLength(1);

    // Second open: fresh render, no click.
    const h2 = await bootPopup({ url: 'https://chat.example.com/room', granted: false });
    expect(h2.calls.request).toEqual([]);
  });

  it('7. an already-granted host shows no Enable button', async () => {
    await bootPopup({ url: 'https://chat.example.com/room', granted: true });
    expect(enableButton()).toBeNull();
  });

  it('8. a different active tab resolves the right host', async () => {
    const h = await bootPopup({ url: 'https://other.example.com/lobby', granted: false });
    expect(enableButton()!.textContent).toContain('other.example.com');
    await h.click(enableButton()!);
    expect(h.calls.request).toEqual([['https://other.example.com/*']]);
  });

  it('9. an SPA navigation (re-render without a click) requests nothing', async () => {
    const h = await bootPopup({ url: 'https://chat.example.com/room', granted: false });

    // A route change re-reads the tab and re-renders. Nothing here is a click.
    const chrome = (globalThis as unknown as { chrome: { tabs: { query: unknown } } }).chrome;
    chrome.tabs.query = vi.fn(async () => [{ id: 42, url: 'https://chat.example.com/other-room', windowId: 1 }]);
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 10));

    expect(h.calls.request).toEqual([]);
  });
});
