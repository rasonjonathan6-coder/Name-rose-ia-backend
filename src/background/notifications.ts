import type { RoseSettings } from '@/shared/types';

/**
 * Notification gate.
 *
 * Notifications are the easiest way to make an assistant feel like spam, so
 * every notification passes through a per-topic cooldown and the user's own
 * toggles. Errors are the exception: they are always allowed through, because
 * silently failing is worse than a repeated alert.
 */

export type NotificationTopic =
  | 'new-message'
  | 'reply-ready'
  | 'error'
  | 'disconnected'
  | 'credits-low'
  | 'integration';

const ICON = 'icons/icon128.png';

export class NotificationGate {
  private lastSent = new Map<NotificationTopic, number>();

  constructor(private getSettings: () => RoseSettings) {}

  /** Topic is allowed when its toggle is on and the cooldown has elapsed. */
  allowed(topic: NotificationTopic, now = Date.now()): boolean {
    const s = this.getSettings();
    if (!s.notifications.enabled && topic !== 'error') return false;

    const toggle: Record<NotificationTopic, boolean> = {
      'new-message': s.notifications.onNewMessage,
      'reply-ready': s.notifications.onReplyReady,
      error: s.notifications.onError,
      disconnected: s.notifications.onError,
      'credits-low': s.notifications.onCreditsLow,
      integration: s.notifications.onError,
    };
    if (!toggle[topic]) return false;

    const last = this.lastSent.get(topic) ?? 0;
    // Errors bypass the cooldown so a persistent failure stays visible.
    if (topic !== 'error' && now - last < s.notifications.minIntervalMs) return false;
    return true;
  }

  async notify(
    topic: NotificationTopic,
    title: string,
    message: string,
    opts: { requireInteraction?: boolean; silent?: boolean } = {},
  ): Promise<boolean> {
    if (!this.allowed(topic)) return false;
    this.lastSent.set(topic, Date.now());

    const g = globalThis as unknown as { chrome?: typeof chrome };
    if (!g.chrome?.notifications?.create) return false;

    try {
      await g.chrome.notifications.create(`rose-${topic}-${Date.now()}`, {
        type: 'basic',
        iconUrl: ICON,
        title: `ROSE IA — ${title}`,
        message: message.slice(0, 220),
        priority: topic === 'error' ? 2 : 1,
        requireInteraction: opts.requireInteraction ?? topic === 'error',
        silent: opts.silent ?? false,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Clears the cooldown for a topic (used when the user fixes a problem). */
  reset(topic?: NotificationTopic): void {
    if (topic) this.lastSent.delete(topic);
    else this.lastSent.clear();
  }
}
