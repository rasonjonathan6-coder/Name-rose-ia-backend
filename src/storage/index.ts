/**
 * Persistence layer.
 *
 * Uses `chrome.storage.local` inside the extension and transparently falls back
 * to an in-memory shim (plus `localStorage` when available) so the same modules
 * can run under Vitest/jsdom and in the demo harness.
 *
 * API keys are stored separately from general settings so a settings export
 * never leaks credentials.
 */

import { mergeSettings, DEFAULT_SETTINGS } from '@/shared/settings';
import type { ClientMemory, DailyStats, RoseSettings } from '@/shared/types';
import { todayKey } from '@/shared/utils';

const NS = {
  settings: 'rose:settings',
  secrets: 'rose:secrets',
  memory: 'rose:memory:', // + clientId
  memoryIndex: 'rose:memory:__index__',
  stats: 'rose:stats:',
  statsIndex: 'rose:stats:__index__',
  runtime: 'rose:runtime',
} as const;

interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

function createMemoryArea(): StorageArea {
  const map = new Map<string, unknown>();
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of keys) map.delete(k);
    },
    async clear() {
      map.clear();
    },
  };
}

function createLocalStorageArea(): StorageArea {
  const PREFIX = 'rose::';
  const encode = (v: unknown) => JSON.stringify(v);
  const decode = <T>(raw: string | null): T | undefined => {
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  };
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const v = decode(localStorage.getItem(PREFIX + k));
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) localStorage.setItem(PREFIX + k, encode(v));
    },
    async remove(keys) {
      for (const k of keys) localStorage.removeItem(PREFIX + k);
    },
    async clear() {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(PREFIX)) toRemove.push(k);
      }
      toRemove.forEach((k) => localStorage.removeItem(k));
    },
  };
}

function pickArea(): StorageArea {
  const g = globalThis as unknown as { chrome?: typeof chrome };
  if (g.chrome?.storage?.local) {
    return {
      async get(keys) {
        return (await g.chrome!.storage.local.get(keys)) as Record<string, unknown>;
      },
      async set(items) {
        await g.chrome!.storage.local.set(items);
      },
      async remove(keys) {
        await g.chrome!.storage.local.remove(keys);
      },
      async clear() {
        await g.chrome!.storage.local.clear();
      },
    };
  }
  if (typeof localStorage !== 'undefined') return createLocalStorageArea();
  return createMemoryArea();
}

let area: StorageArea | null = null;
function store(): StorageArea {
  area ??= pickArea();
  return area;
}

/** Test helper — swaps the backing store. */
export function __setStorageArea(a: StorageArea | null) {
  area = a;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadSettings(): Promise<RoseSettings> {
  const raw = await store().get([NS.settings]);
  return mergeSettings(raw[NS.settings]);
}

export async function saveSettings(settings: RoseSettings): Promise<void> {
  await store().set({ [NS.settings]: settings });
}

export async function patchSettings(patch: Partial<RoseSettings>): Promise<RoseSettings> {
  const current = await loadSettings();
  const { deepMerge } = await import('@/shared/settings');
  const next = deepMerge(current, patch) as RoseSettings;
  await saveSettings(next);
  return next;
}

export async function resetSettings(): Promise<RoseSettings> {
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
  return structuredClone(DEFAULT_SETTINGS);
}

// ---------------------------------------------------------------------------
// Secrets (API keys) — separate namespace
// ---------------------------------------------------------------------------

export type SecretMap = Record<string, string>;

export async function loadSecrets(): Promise<SecretMap> {
  const raw = await store().get([NS.secrets]);
  return (raw[NS.secrets] as SecretMap) ?? {};
}

export async function saveSecret(providerId: string, key: string): Promise<void> {
  const all = await loadSecrets();
  if (key) all[providerId] = key;
  else delete all[providerId];
  await store().set({ [NS.secrets]: all });
}

export async function clearSecrets(): Promise<void> {
  await store().remove([NS.secrets]);
}

// ---------------------------------------------------------------------------
// Client memory
// ---------------------------------------------------------------------------

export async function getMemoryIndex(): Promise<string[]> {
  const raw = await store().get([NS.memoryIndex]);
  return (raw[NS.memoryIndex] as string[]) ?? [];
}

async function setMemoryIndex(ids: string[]): Promise<void> {
  await store().set({ [NS.memoryIndex]: ids });
}

export async function loadMemory(clientId: string): Promise<ClientMemory | null> {
  const raw = await store().get([NS.memory + clientId]);
  return (raw[NS.memory + clientId] as ClientMemory) ?? null;
}

export async function saveMemory(memory: ClientMemory): Promise<void> {
  await store().set({ [NS.memory + memory.id]: memory });
  const index = await getMemoryIndex();
  if (!index.includes(memory.id)) await setMemoryIndex([...index, memory.id]);
}

export async function listMemories(): Promise<ClientMemory[]> {
  const index = await getMemoryIndex();
  if (index.length === 0) return [];
  const keys = index.map((id) => NS.memory + id);
  const raw = await store().get(keys);
  return keys.map((k) => raw[k] as ClientMemory).filter(Boolean);
}

export async function deleteMemory(clientId: string): Promise<void> {
  await store().remove([NS.memory + clientId]);
  const index = await getMemoryIndex();
  await setMemoryIndex(index.filter((id) => id !== clientId));
}

export async function clearAllMemory(): Promise<void> {
  const index = await getMemoryIndex();
  if (index.length) await store().remove(index.map((id) => NS.memory + id));
  await setMemoryIndex([]);
}

/** Drops memories untouched for longer than the retention window. */
export async function pruneMemory(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const all = await listMemories();
  const stale = all.filter((m) => m.lastInteraction < cutoff);
  for (const m of stale) await deleteMemory(m.id);
  return stale.length;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function getStats(date = todayKey()): Promise<DailyStats> {
  const raw = await store().get([NS.stats + date]);
  return (
    (raw[NS.stats + date] as DailyStats) ?? {
      date,
      conversations: 0,
      messagesReceived: 0,
      responsesGenerated: 0,
      responsesSent: 0,
      totalResponseMs: 0,
      tokensPrompt: 0,
      tokensCompletion: 0,
      requests: 0,
      costUsd: 0,
    }
  );
}

export async function saveStats(stats: DailyStats): Promise<void> {
  await store().set({ [NS.stats + stats.date]: stats });
  const raw = await store().get([NS.statsIndex]);
  const index = (raw[NS.statsIndex] as string[]) ?? [];
  if (!index.includes(stats.date)) {
    await store().set({ [NS.statsIndex]: [...index, stats.date].sort().slice(-60) });
  }
}

export async function getStatsRange(days = 7): Promise<DailyStats[]> {
  const raw = await store().get([NS.statsIndex]);
  const index = (raw[NS.statsIndex] as string[]) ?? [];
  const wanted = index.slice(-days);
  if (!wanted.length) return [];
  const keys = wanted.map((d) => NS.stats + d);
  const data = await store().get(keys);
  return keys.map((k) => data[k] as DailyStats).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Runtime flags (pause state survives service-worker restarts)
// ---------------------------------------------------------------------------

export interface RuntimeFlags {
  globalPaused: boolean;
  stoppedAt: number | null;
  mode: string;
}

export async function loadRuntime(): Promise<RuntimeFlags> {
  const raw = await store().get([NS.runtime]);
  return (raw[NS.runtime] as RuntimeFlags) ?? { globalPaused: false, stoppedAt: null, mode: 'manual' };
}

export async function saveRuntime(flags: RuntimeFlags): Promise<void> {
  await store().set({ [NS.runtime]: flags });
}

export const STORAGE_KEYS = NS;
