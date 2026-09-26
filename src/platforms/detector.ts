import type { DetectionReport, PlatformId } from '@/shared/types';
import { log } from '@/core/logging/logger';
import type { PlatformAdapter, SiteConfig } from './types';
import { documentUrl } from './types';
import { GenericChatAdapter } from './generic/adapter';
import { CooMeetAdapter } from './coomeet/adapter';
import { FlirtifyAdapter } from './flirtify/adapter';
import { DemoAdapter } from './generic/demo-adapter';

export type { PlatformAdapter, SiteConfig } from './types';

/**
 * PlatformDetector — resolves the best adapter for the current document.
 *
 * Order of resolution:
 *   1. user-supplied site configs (highest priority, they know their site)
 *   2. built-in adapters that match the hostname
 *   3. the generic heuristic adapter as a universal fallback
 *
 * The registry is append-only at runtime so new platforms can be registered
 * without touching the core.
 */
export class PlatformDetector {
  private readonly builtins: PlatformAdapter[] = [];
  private readonly userConfigs: SiteConfig[] = [];

  constructor() {
    this.register(new CooMeetAdapter());
    this.register(new FlirtifyAdapter());
    this.register(new DemoAdapter());
  }

  register(adapter: PlatformAdapter): void {
    this.builtins.push(adapter);
  }

  setUserConfigs(configs: SiteConfig[]): void {
    this.userConfigs.length = 0;
    this.userConfigs.push(...configs);
  }

  getUserConfigs(): SiteConfig[] {
    return [...this.userConfigs];
  }

  /**
   * Picks an adapter. `doc` defaults to the current document; tests pass a
   * jsdom document explicitly.
   */
  detect(doc: Document = document): DetectionReport {
    const url = documentUrl(doc);
    const notes: string[] = [];

    const candidates: Array<{ adapter: PlatformAdapter; score: number }> = [];

    // 1. User config for this host wins outright.
    const userConfig = this.userConfigs.find((c) => c.hosts.some((h: string) => matchHost(url.hostname, h)));
    if (userConfig) {
      candidates.push({ adapter: new GenericChatAdapter(userConfig), score: 1 });
      notes.push(`user config matched ${url.hostname}`);
    }

    // 2. Built-in adapters.
    for (const adapter of this.builtins) {
      let score = 0;
      try {
        if (adapter.matches(url)) score = adapter.score(doc);
      } catch (err) {
        notes.push(`adapter ${adapter.id} threw during scoring`);
        log.warn('detector', `adapter ${adapter.id} scoring failed`, err);
        score = 0;
      }
      if (score > 0) candidates.push({ adapter, score });
    }

    // 3. Generic fallback, always evaluated.
    const generic = new GenericChatAdapter();
    const genericScore = generic.score(doc);
    candidates.push({ adapter: generic, score: genericScore });

    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates[0]!;

    const report: DetectionReport = {
      platform: winner.adapter.id,
      confidence: Math.round(winner.score * 100) / 100,
      url: url.href,
      hostname: url.hostname,
      resolved: {},
      notes,
      detectedAt: Date.now(),
    };

    try {
      report.resolved = {
        conversation: winner.adapter.getConversation(doc)?.clientId ?? null,
        container: describe(winner.adapter.getMessageContainer(doc)),
        input: describe(winner.adapter.getInput(doc)),
        sendButton: describe(winner.adapter.getSendButton(doc)),
      };
    } catch (err) {
      notes.push('adapter capability resolution failed');
      log.warn('detector', 'capability resolution failed', err);
    }

    log.info('detector', `platform=${report.platform} confidence=${report.confidence}`, {
      hostname: report.hostname,
      resolved: report.resolved,
    });
    return report;
  }

  /** Convenience for tests and for the content script. */
  resolve(doc: Document = document): PlatformAdapter {
    const report = this.detect(doc);
    const url = documentUrl(doc);
    const userConfig = this.userConfigs.find((c) => c.hosts.some((h: string) => matchHost(url.hostname, h)));
    if (userConfig && report.confidence >= 0.95) return new GenericChatAdapter(userConfig);
    return (
      this.builtins.find((a) => a.id === report.platform) ?? new GenericChatAdapter()
    );
  }
}


function describe(el: Element | null): string | null {
  if (!el) return null;
  const id = el.id ? `#${el.id}` : '';
  const cls = el.className?.toString().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return `${el.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ''}`;
}

export function matchHost(hostname: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/^\*\./, '');
  const h = hostname.toLowerCase();
  return h === p || h.endsWith(`.${p}`);
}

export type { PlatformId };
