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
 * Three tiers, in descending priority:
 *
 *   1. built-in adapters (CooMeet, Flirtify, demo) — these are the shipped,
 *      platform-specific implementations and are the *correct* winner on their
 *      own hosts;
 *   2. built-in heuristic configs registered via `registerBuiltinConfigs` —
 *      selector hints for hosts ROSE ships knowledge about but no dedicated
 *      adapter for;
 *   3. user-supplied configs registered via `setUserConfigs` — explicit,
 *      operator-authored configurations, which win outright because the operator
 *      knows their site better than the heuristics do.
 *
 * `setUserConfigs` must only ever receive *user* configurations. Passing the
 * shipped `BUILTIN_CONFIGS` through it was a real production bug: the user-config
 * tier short-circuits to score 1 and instantiates a GenericChatAdapter, so
 * coomeet.com reported `platform=generic confidence=1` and the dedicated
 * CooMeet/Flirtify adapters never ran. Shipped configs belong in
 * `registerBuiltinConfigs`.
 *
 * The registry is append-only at runtime so new platforms can be registered
 * without touching the core.
 */
export class PlatformDetector {
  private readonly builtins: PlatformAdapter[] = [];
  private readonly builtinConfigs: SiteConfig[] = [];
  private readonly userConfigs: SiteConfig[] = [];

  constructor() {
    this.register(new CooMeetAdapter());
    this.register(new FlirtifyAdapter());
    this.register(new DemoAdapter());
  }

  register(adapter: PlatformAdapter): void {
    this.builtins.push(adapter);
  }

  /**
   * Registers the shipped selector hints (COOMEET_CONFIG, FLIRTIFY_CONFIG,
   * DEMO_CONFIG). They participate as a *lower* priority than the dedicated
   * adapters so a shipped config can never displace an adapter that knows the
   * platform properly.
   */
  registerBuiltinConfigs(configs: readonly SiteConfig[]): void {
    this.builtinConfigs.length = 0;
    this.builtinConfigs.push(...configs);
  }

  /** Registers operator-authored site configs. These win outright. */
  setUserConfigs(configs: SiteConfig[]): void {
    this.userConfigs.length = 0;
    this.userConfigs.push(...configs);
  }

  getUserConfigs(): SiteConfig[] {
    return [...this.userConfigs];
  }

  getBuiltinConfigs(): SiteConfig[] {
    return [...this.builtinConfigs];
  }

  /**
   * Whether any built-in adapter or registered config explicitly claims this
   * URL's host.
   *
   * Used by the content script's frame policy: the manifest's match patterns
   * already gate which origins the script can run on, and this is the finer
   * filter that separates "a chat platform ROSE ships knowledge about" from
   * "some other frame that happens to be injected into". The top frame is
   * exempt — the generic adapter must still serve unclaimed hosts.
   */
  claimsHost(url: URL): boolean {
    if (this.configFor(url, this.userConfigs) || this.configFor(url, this.builtinConfigs)) return true;
    return this.builtins.some((a) => {
      try {
        return a.matches(url);
      } catch {
        return false;
      }
    });
  }

  /** First config in `configs` whose host patterns match the URL, if any. */
  private configFor(url: URL, configs: readonly SiteConfig[]): SiteConfig | null {
    return configs.find((c) => c.hosts.some((h) => matchHost(url.hostname, h))) ?? null;
  }

  /**
   * Picks an adapter. `doc` defaults to the current document; tests pass a
   * jsdom document explicitly.
   */
  detect(doc: Document = document): DetectionReport {
    const url = documentUrl(doc);
    const notes: string[] = [];

    const candidates: Array<{ adapter: PlatformAdapter; score: number }> = [];

    // 1. A user config for this host wins outright. Score 1 is intentional here
    //    and only here: the operator explicitly said "this is my site's markup".
    const userConfig = this.configFor(url, this.userConfigs);
    if (userConfig) {
      candidates.push({ adapter: new GenericChatAdapter(userConfig), score: 1 });
      notes.push(`user config matched ${url.hostname}`);
    }

    // 2. Built-in adapters. These carry real platform knowledge, so they are
    //    scored against the DOM rather than assumed.
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

    // 3. Built-in configs as a GenericChatAdapter. This is the tier that used to
    //    be (incorrectly) registered as a user config. It sits below the
    //    dedicated adapters and above the pure-generic fallback.
    const builtinConfig = this.configFor(url, this.builtinConfigs);
    if (builtinConfig) {
      const adapter = new GenericChatAdapter(builtinConfig);
      candidates.push({ adapter, score: Math.max(adapter.score(doc), 0.3) });
      notes.push(`builtin config matched ${url.hostname}`);
    }

    // 4. Generic fallback, always evaluated.
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
    const userConfig = this.configFor(url, this.userConfigs);
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
