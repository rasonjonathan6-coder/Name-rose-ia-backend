/**
 * Shared helpers for the extension's own pages: DOM building, theming, and the
 * settings ↔ form plumbing that all four pages need.
 */

import type { RoseSettings } from '@/shared/types';
import { PAGE_CSS } from './page-styles';

/** Creates an element with attributes and children in one call. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | undefined> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'html') {
      el.innerHTML = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/** Injects the shared stylesheet once per document. */
export function installStyles(): void {
  if (document.getElementById('rose-page-styles')) return;
  const style = h('style', { id: 'rose-page-styles', text: PAGE_CSS });
  document.head.appendChild(style);
}

/** Applies the user's theme/accent to `:root` so CSS variables resolve. */
export function applyTheme(settings: RoseSettings): void {
  const root = document.documentElement;
  const theme =
    settings.appearance.theme === 'system'
      ? window.matchMedia?.('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : settings.appearance.theme;
  root.dataset.theme = theme;
  root.dataset.accent = settings.appearance.accent;
}

/** Shows a transient message at the bottom of the page. */
export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ms = 3600): void {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = h('div', { class: `toast ${kind}`, role: 'status', text: message });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function relativeTime(at: number): string {
  const diff = Date.now() - at;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatMs(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Reads the currently active tab, tolerating restricted pages. */
export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const g = globalThis as unknown as { chrome?: typeof chrome };
  if (!g.chrome?.tabs?.query) return null;
  try {
    const [tab] = await g.chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

/** True when the tab is a page ROSE can attach to. */
export function isSupportedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url) && !/^https?:\/\/(chrome|about|edge|chrome-extension|moz-extension)/i.test(url);
}

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export const PROVIDER_PRESETS = [
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini', 'meta-llama/llama-3.1-8b-instruct', 'anthropic/claude-3.5-haiku', 'google/gemini-flash-1.5'], keyHint: 'sk-or-…' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'], keyHint: 'sk-…' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'], keyHint: 'gsk_…' },
] as const;

export const STYLE_OPTIONS = [
  { value: 'natural', label: 'Natural' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'warm', label: 'Warm' },
  { value: 'flirty', label: 'Flirty' },
  { value: 'playful', label: 'Playful' },
  { value: 'direct', label: 'Direct' },
  { value: 'custom', label: 'Custom…' },
] as const;
