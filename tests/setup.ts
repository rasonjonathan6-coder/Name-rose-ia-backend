import { beforeEach, vi } from 'vitest';

/**
 * Global test setup.
 *
 * Provides a clean storage backend per test and stubs the few Chrome APIs the
 * modules touch, so tests exercise real logic rather than mocks of our own code.
 */

// Fresh in-memory storage for every test — no state leaks between files.
beforeEach(async () => {
  const { __setStorageArea } = await import('@/storage');
  const map = new Map<string, unknown>();
  __setStorageArea({
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v));
    },
    async remove(keys: string[]) {
      for (const k of keys) map.delete(k);
    },
    async clear() {
      map.clear();
    },
  });
});

// jsdom lacks these; the overlay and adapters use them.
if (typeof globalThis.PointerEvent === 'undefined' && typeof globalThis.MouseEvent !== 'undefined') {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {} as unknown as typeof PointerEvent;
}

if (typeof document !== 'undefined' && !document.execCommand) {
  (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
}

// Keep test output readable: the logger is silent unless explicitly enabled.
vi.mock('@/core/logging/logger', async () => {
  const actual = await vi.importActual<typeof import('@/core/logging/logger')>('@/core/logging/logger');
  return {
    ...actual,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    configureLogging: () => {},
  };
});
