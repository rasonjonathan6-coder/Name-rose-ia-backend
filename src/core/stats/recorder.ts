import type { DailyStats, StatsEvent } from '@/shared/types';
import { todayKey } from '@/shared/utils';
import * as storage from '@/storage';

/**
 * StatsRecorder — accumulates the dashboard counters.
 *
 * Deliberately honest about money: cost is only ever incremented by the amount
 * the AI layer actually computed from real token usage and a known price list.
 * When a model's pricing is unknown, cost stays at zero rather than being
 * estimated, so the dashboard never shows an invented figure.
 */

export interface StatsDelta {
  conversations?: number;
  messagesReceived?: number;
  responsesGenerated?: number;
  responsesSent?: number;
  responseMs?: number;
  tokensPrompt?: number;
  tokensCompletion?: number;
  requests?: number;
  costUsd?: number;
}

export class StatsRecorder {
  private cache = new Map<string, DailyStats>();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly flushDelayMs = 1500) {}

  async record(event: StatsEvent): Promise<void> {
    const delta: StatsDelta = {};
    switch (event.kind) {
      case 'conversation':
        delta.conversations = 1;
        break;
      case 'message-received':
        delta.messagesReceived = 1;
        break;
      case 'response-generated':
        delta.responsesGenerated = 1;
        if (typeof event.responseMs === 'number') delta.responseMs = event.responseMs;
        break;
      case 'response-sent':
        delta.responsesSent = 1;
        break;
      case 'ai-request':
        delta.requests = 1;
        delta.tokensPrompt = event.tokensPrompt ?? 0;
        delta.tokensCompletion = event.tokensCompletion ?? 0;
        delta.costUsd = event.costUsd ?? 0;
        break;
    }
    await this.apply(delta);
  }

  async apply(delta: StatsDelta): Promise<DailyStats> {
    const key = todayKey();
    const stats = this.cache.get(key) ?? (await storage.getStats(key));

    const next: DailyStats = {
      ...stats,
      conversations: stats.conversations + (delta.conversations ?? 0),
      messagesReceived: stats.messagesReceived + (delta.messagesReceived ?? 0),
      responsesGenerated: stats.responsesGenerated + (delta.responsesGenerated ?? 0),
      responsesSent: stats.responsesSent + (delta.responsesSent ?? 0),
      totalResponseMs: stats.totalResponseMs + (delta.responseMs ?? 0),
      tokensPrompt: stats.tokensPrompt + (delta.tokensPrompt ?? 0),
      tokensCompletion: stats.tokensCompletion + (delta.tokensCompletion ?? 0),
      requests: stats.requests + (delta.requests ?? 0),
      costUsd: Math.round((stats.costUsd + (delta.costUsd ?? 0)) * 1e6) / 1e6,
    };

    this.cache.set(key, next);
    this.scheduleFlush();
    return next;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  /** Writes the cached counters to storage. Called on a timer and on shutdown. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    for (const stats of this.cache.values()) {
      await storage.saveStats(stats);
    }
  }

  async today(): Promise<DailyStats> {
    return this.cache.get(todayKey()) ?? storage.getStats();
  }

  async range(days = 7): Promise<DailyStats[]> {
    const stored = await storage.getStatsRange(days);
    const byDate = new Map(stored.map((s) => [s.date, s]));
    // Prefer in-memory values for today, they are ahead of the last flush.
    for (const [date, stats] of this.cache) byDate.set(date, stats);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Derived metrics for the dashboard. */
  static averageResponseMs(stats: DailyStats): number {
    return stats.responsesGenerated > 0 ? Math.round(stats.totalResponseMs / stats.responsesGenerated) : 0;
  }

  static totalTokens(stats: DailyStats): number {
    return stats.tokensPrompt + stats.tokensCompletion;
  }
}

/** Formats an aggregate into the dashboard's summary shape. */
export function summarise(days: DailyStats[]) {
  const total = days.reduce(
    (acc, d) => ({
      conversations: acc.conversations + d.conversations,
      messagesReceived: acc.messagesReceived + d.messagesReceived,
      responsesGenerated: acc.responsesGenerated + d.responsesGenerated,
      responsesSent: acc.responsesSent + d.responsesSent,
      totalResponseMs: acc.totalResponseMs + d.totalResponseMs,
      tokens: acc.tokens + d.tokensPrompt + d.tokensCompletion,
      requests: acc.requests + d.requests,
      costUsd: acc.costUsd + d.costUsd,
    }),
    {
      conversations: 0,
      messagesReceived: 0,
      responsesGenerated: 0,
      responsesSent: 0,
      totalResponseMs: 0,
      tokens: 0,
      requests: 0,
      costUsd: 0,
    },
  );
  return {
    ...total,
    costUsd: Math.round(total.costUsd * 1e6) / 1e6,
    averageResponseMs:
      total.responsesGenerated > 0 ? Math.round(total.totalResponseMs / total.responsesGenerated) : 0,
  };
}
