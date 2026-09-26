/**
 * ROSE IA content script.
 *
 * This is the page-side controller. It owns everything that touches the host
 * page's DOM: platform detection, message observation, reply-field writing and
 * the floating overlay. All decisions that cost money or need persistence are
 * delegated to the background service worker over RPC.
 *
 * Failure posture: every subsystem is wrapped so that a failure in an optional
 * module (live assist, overlay, translation) degrades gracefully instead of
 * taking down message detection. A chat site changing its markup must never
 * leave the page broken.
 */

import { MSG } from '@/shared/types';
import type {
  AutomationMode,
  AutomationState,
  Command,
  ConversationRef,
  DetectionReport,
  QualityIssue,
  RoseSettings,
  Suggestion,
} from '@/shared/types';
import { PlatformDetector } from '@/platforms/detector';
import type { PlatformAdapter } from '@/platforms/types';
import { BUILTIN_CONFIGS } from '@/platforms/generic/config';
import { MessageDetector } from '@/core/conversation/message-detector';
import { AutomationStateMachine } from '@/core/automation/state-machine';
import { ResponseQualityGuard } from '@/core/safety/quality-guard';
import { isAutoSendBlocked } from '@/core/safety/policy';
import { LiveCallAssistant, formatLiveTranscript } from '@/core/conversation/live-assistant';
import { ConversationEngine } from '@/core/conversation/engine';
import { detectLanguage } from '@/core/translation/language';
import { configureLogging, log, getLogEntries, onLog } from '@/core/logging/logger';
import { RoseOverlay } from '@/ui/overlay';
import { rpc } from '@/shared/rpc';
import { estimateTokens, normaliseText, sleep, truncate } from '@/shared/utils';
import * as storage from '@/storage';

const VERSION = '0.1.0';

class RoseController {
  private detector = new PlatformDetector();
  private adapter: PlatformAdapter | null = null;
  private messageDetector: MessageDetector | null = null;
  private overlay: RoseOverlay | null = null;
  private live: LiveCallAssistant | null = null;
  private machine = new AutomationStateMachine({ mode: 'manual' });
  private guard = new ResponseQualityGuard();
  private engine = new ConversationEngine(() => ({
    inactivityMinutes: this.settings?.automation.inactivityMinutes ?? 10,
    maxRecentMessages: this.settings?.memory.maxRecentMessages ?? 12,
  }));

  private settings: RoseSettings | null = null;
  private report: DetectionReport | null = null;
  private conversation: ConversationRef | null = null;
  private messages: ReturnType<PlatformAdapter['getMessages']> = [];
  private suggestions: Suggestion[] = [];
  private suggestionIssues: Record<number, QualityIssue[]> = {};
  private selectedIndex = 0;
  private incomingTranslation: string | null = null;
  private lastIncoming = '';
  private pendingSendTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private sendAbort: AbortController | null = null;
  private statsSnapshot = { tokens: 0, requests: 0, costUsd: 0 };
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private spaTimer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    this.settings = await storage.loadSettings();
    configureLogging({ enabled: this.settings.debug.enabled, verbose: this.settings.debug.verbose });

    this.detector.setUserConfigs(BUILTIN_CONFIGS);
    this.report = this.detector.detect(document);
    this.adapter = this.detector.resolve(document);

    log.info('content', `ROSE initialised on ${this.report.hostname}`, {
      platform: this.report.platform,
      confidence: this.report.confidence,
    });

    // Report detection, but never let a failure block the overlay.
    void rpc(MSG.DETECTION_REPORT, { report: this.report }).catch(() => undefined);

    this.machine = new AutomationStateMachine({ mode: this.settings.automation.mode });
    this.machine.applyConfig(this.settings.automation);

    this.mountOverlay();
    this.startDetection();
    this.watchSpaNavigation();
    this.listenForCommands();

    this.overlay?.toast(`ROSE active — ${this.report.platform} (${Math.round(this.report.confidence * 100)}% confidence)`, 'success');
  }

  // -------------------------------------------------------------------------
  // Overlay
  // -------------------------------------------------------------------------

  private mountOverlay(): void {
    const s = this.settings!;
    try {
      this.overlay = new RoseOverlay(
        {
          onGenerate: () => void this.generate(),
          onRegenerate: () => void this.generate(true),
          onSelect: (sug) => this.select(sug),
          onAction: (a) => void this.action(a),
          onModeChange: (m) => void this.setMode(m),
          onStop: () => this.stopAll(),
          onPauseToggle: () => void this.togglePause(),
          onCollapse: () => this.toggleCollapse(),
          onClose: () => this.destroyOverlay(),
          onOpenOptions: () => this.openOptions(),
          onOpenDashboard: () => this.openDashboard(),
          onLiveToggle: () => void this.toggleLive(),
        },
        {
          mode: s.automation.mode,
          collapsed: s.appearance.collapsed,
          position: s.appearance.position ?? { x: -1, y: -1 },
          opacity: s.appearance.opacity,
          theme: s.appearance.theme === 'light' ? 'light' : 'dark',
          accent: s.appearance.accent,
          platformLabel: this.adapter?.label ?? 'Generic chat',
          debugVisible: s.debug.showOverlay,
        },
      );
      this.overlay.mount();

      window.addEventListener('rose:overlay-position', (e) => {
        const detail = (e as CustomEvent).detail as { position: { x: number; y: number }; size: { w: number; h: number } };
        void this.persistAppearance({ position: detail.position });
      });
      window.addEventListener('rose:overlay-geometry', (e) => {
        const detail = (e as CustomEvent).detail as { w: number; h: number };
        void this.persistAppearance({ scale: this.settings!.appearance.scale });
        void detail;
      });

      // Live log mirror for the debug panel.
      onLog(() => {
        if (this.settings?.debug.showOverlay) {
          this.overlay?.update({ logs: getLogEntries() });
        }
      });

      void this.refreshStats();
    } catch (err) {
      log.error('content', 'overlay failed to mount', err);
    }
  }

  private destroyOverlay(): void {
    this.overlay?.unmount();
    this.overlay = null;
    log.info('content', 'overlay closed for this page');
  }

  private toggleCollapse(): void {
    if (!this.overlay) return;
    const next = !this.overlay.getState().collapsed;
    this.overlay.update({ collapsed: next });
    void this.persistAppearance({ collapsed: next });
  }

  private async persistAppearance(patch: Partial<RoseSettings['appearance']>): Promise<void> {
    try {
      this.settings = await storage.patchSettings({ appearance: patch } as Partial<RoseSettings>);
    } catch (err) {
      log.warn('content', 'could not persist appearance', err);
    }
  }

  private openOptions(): void {
    const g = globalThis as unknown as { chrome?: typeof chrome };
    void g.chrome?.runtime?.openOptionsPage?.();
  }

  private openDashboard(): void {
    const g = globalThis as unknown as { chrome?: typeof chrome };
    const url = g.chrome?.runtime?.getURL?.('dashboard/dashboard.html');
    if (url) void g.chrome?.tabs?.create?.({ url });
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  private startDetection(): void {
    if (!this.adapter) return;
    try {
      this.messageDetector = new MessageDetector(this.adapter, {
        onMessages: (fresh, all) => void this.onMessages(fresh, all),
        onConversationChange: () => this.onConversationChanged(),
      });
      this.messageDetector.start(document);
    } catch (err) {
      log.error('content', 'detector failed to start', err);
    }
  }

  private onConversationChanged(): void {
    this.conversation = this.adapter?.getConversation(document) ?? null;
    this.suggestions = [];
    this.suggestionIssues = {};
    this.selectedIndex = 0;
    this.incomingTranslation = null;
    this.lastIncoming = '';

    if (this.conversation) {
      log.info('content', 'conversation detected', {
        clientId: this.conversation.clientId,
        name: this.conversation.displayName,
      });
      void rpc(MSG.CONVERSATION_ACTIVATED, { conversation: this.conversation }).then((res) => {
        if (res.ok && res.data?.memory) {
          this.overlay?.update({
            conversationName: this.conversation!.displayName,
            conversationLanguage: res.data.memory.language,
          });
        }
      });
      this.overlay?.update({
        conversationName: this.conversation.displayName,
        conversationStatus: 'new',
        incoming: '',
        suggestions: [],
        incomingTranslation: null,
        error: null,
      });
    }
  }

  private async onMessages(
    fresh: ReturnType<PlatformAdapter['getMessages']>,
    all: ReturnType<PlatformAdapter['getMessages']>,
  ): Promise<void> {
    this.messages = all;
    this.conversation = this.adapter?.getConversation(document) ?? this.conversation;

    if (!this.conversation) {
      this.syncOverlay();
      return;
    }

    const incoming = fresh.filter((m) => m.direction === 'incoming');
    if (incoming.length === 0) {
      this.syncOverlay();
      return;
    }

    // Process the newest incoming message; older ones are context only.
    const message = incoming[incoming.length - 1]!;
    const text = normaliseText(message.text);
    if (!text || text === this.lastIncoming) {
      this.syncOverlay();
      return;
    }
    this.lastIncoming = text;

    log.info('content', 'new message detected', { length: text.length, direction: message.direction });

    const langGuess = detectLanguage(text);
    const memoryRes = await rpc(MSG.MESSAGE_DETECTED, {
      conversation: this.conversation,
      text,
      language: langGuess.confidence > 0.4 ? langGuess.lang : null,
    });

    const memory = memoryRes.ok ? memoryRes.data?.memory : undefined;
    const shouldGenerate = memoryRes.ok ? (memoryRes.data?.shouldCallAI ?? true) : true;

    const understanding = this.engine.understand(text, {
      // Minimal memory view; the full record lives in the background.
      id: memory?.id ?? this.conversation.id,
      platform: this.conversation.platform,
      clientId: this.conversation.clientId,
      displayName: memory?.displayName ?? this.conversation.displayName,
      language: memory?.language ?? null,
      conversationId: this.conversation.conversationId,
      summary: memory?.summary ?? '',
      recentMessages: (memory?.recentMessages ?? []).map((m) => ({ ...m, lang: null })),
      importantFacts: [],
      preferences: {},
      topics: memory?.topics ?? [],
      lastInteraction: Date.now(),
      createdAt: Date.now(),
      metadata: {
        messageCount: memory?.messageCount ?? 0,
        platformsSeen: [this.conversation.platform],
        tokensSaved: 0,
        version: 1,
      },
    }, (memory?.recentMessages ?? []).map((m) => ({ ...m, lang: null })));

    this.overlay?.update({
      conversationName: this.conversation.displayName,
      conversationStatus: understanding.status,
      conversationLanguage: memory?.language ?? langGuess.lang,
      incoming: text,
      incomingTranslation: null,
      suggestions: [],
      suggestionIssues: {},
      selectedIndex: 0,
      error: null,
    });

    // Auto-translate the incoming message for the operator when enabled.
    if (this.settings?.translation.enabled && this.settings.translation.autoTranslateIncoming) {
      const myLang = this.settings.translation.myLanguage;
      const detected = memory?.language ?? langGuess.lang;
      if (detected && detected !== myLang && text.length > 2) {
        void this.translateIncoming(text, myLang);
      }
    }

    // Transition the state machine. In auto mode this may lead to a send.
    const transition = this.machine.dispatch({ type: 'message', conversationId: this.conversation.id });
    this.syncOverlay(transition.reason);

    if (!shouldGenerate) {
      log.info('content', 'skipping generation', { reason: memoryRes.data?.reason });
      this.overlay?.update({ statusNote: memoryRes.data?.reason ?? null });
      return;
    }

    if (this.settings?.automation.mode === 'auto' && transition.action === 'generate') {
      await this.generate();
    } else if (this.settings?.automation.mode !== 'auto') {
      // Manual/assisted: prepare suggestions so they are ready when the operator looks.
      await this.generate();
    }
  }

  private async translateIncoming(text: string, target: string): Promise<void> {
    const res = await rpc(MSG.REQUEST_TRANSLATION, { text, targetLanguage: target, tone: 'neutral' });
    if (res.ok && res.data?.text) {
      this.incomingTranslation = res.data.text;
      this.overlay?.update({ incomingTranslation: res.data.text });
    }
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  private async generate(force = false): Promise<void> {
    if (!this.conversation || !this.settings) return;
    if (!this.lastIncoming) {
      this.overlay?.toast('No client message to answer yet.', 'info');
      return;
    }
    if (this.machine.isStopped) {
      this.overlay?.toast('ROSE is stopped. Press STOP to arm it again.', 'error');
      return;
    }

    const transition = this.machine.dispatch({ type: 'generation-started', conversationId: this.conversation.id });
    if (transition.action === 'none' && this.machine.currentMode === 'manual' && this.machine.isStopped) return;

    this.syncOverlay('asking ROSE…');

    const res = await rpc(MSG.REQUEST_SUGGESTIONS, {
      conversation: this.conversation,
      incoming: this.lastIncoming,
      style: this.settings.conversation.style,
      customStyle: this.settings.conversation.customStyle,
      length: this.settings.conversation.length,
      targetLanguage: this.settings.conversation.targetLanguage,
      count: this.settings.conversation.suggestionCount,
      force,
    });

    if (!res.ok) {
      this.machine.dispatch({ type: 'generation-failed', conversationId: this.conversation.id, error: res.error ?? 'unknown' });
      this.overlay?.update({ error: res.error ?? 'Generation failed', suggestions: [] });
      this.syncOverlay(res.error);
      this.overlay?.toast(res.error ?? 'Generation failed', 'error');
      return;
    }

    this.suggestions = res.data?.suggestions ?? [];
    this.suggestionIssues = this.evaluateSuggestions(this.suggestions);
    this.selectedIndex = 0;
    this.machine.dispatch({ type: 'generation-succeeded', conversationId: this.conversation.id });

    this.overlay?.update({
      suggestions: this.suggestions,
      suggestionIssues: this.suggestionIssues,
      selectedIndex: 0,
      error: null,
    });
    this.syncOverlay(
      res.data?.result.cached
        ? 'cached reply (no tokens spent)'
        : `${res.data?.result.model ?? 'model'} · ${res.data?.result.latencyMs ?? 0}ms`,
    );
    await this.refreshStats();

    // Assisted mode: insert automatically once suggestions exist.
    if (this.settings.automation.mode === 'assisted' && this.suggestions.length) {
      await this.insert(this.suggestions[0]!.text);
    }
    // Auto mode: insert then send through the delay gate.
    if (this.settings.automation.mode === 'auto' && this.suggestions.length) {
      await this.insert(this.suggestions[0]!.text, true);
    }
  }

  private evaluateSuggestions(suggestions: Suggestion[]): Record<number, QualityIssue[]> {
    const issues: Record<number, QualityIssue[]> = {};
    const recentReplies = this.messages
      .filter((m) => m.direction === 'outgoing')
      .slice(-6)
      .map((m) => m.text);

    suggestions.forEach((s, i) => {
      const report = this.guard.check(s, {
        id: this.conversation?.id ?? '',
        platform: this.conversation?.platform ?? 'generic',
        clientId: this.conversation?.clientId ?? '',
        displayName: this.conversation?.displayName ?? '',
        language: this.overlay?.getState().conversationLanguage ?? null,
        conversationId: this.conversation?.conversationId ?? '',
        summary: '',
        recentMessages: [],
        importantFacts: [],
        preferences: {},
        topics: [],
        lastInteraction: Date.now(),
        createdAt: Date.now(),
        metadata: { messageCount: 0, platformsSeen: [], tokensSaved: 0, version: 1 },
      }, {
        expectedLanguage: this.settings?.conversation.targetLanguage ?? 'auto',
        maxChars: this.settings?.ai.maxResponseChars ?? 600,
        recentReplies,
        incoming: this.lastIncoming,
        incomingLanguage: this.overlay?.getState().conversationLanguage ?? undefined,
      });
      if (report.issues.length) issues[i] = report.issues;
    });
    return issues;
  }

  private select(suggestion: Suggestion): void {
    this.selectedIndex = Math.max(0, this.suggestions.indexOf(suggestion));
    this.machine.dispatch({ type: 'user-selected', conversationId: this.conversation?.id ?? '' });
    this.overlay?.update({ selectedIndex: this.selectedIndex });
  }

  private selectedText(): string | null {
    return this.suggestions[this.selectedIndex]?.text ?? null;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async action(a: 'shorter' | 'longer' | 'translate' | 'copy' | 'insert' | 'send'): Promise<void> {
    const text = this.selectedText();
    if (!text && a !== 'insert' && a !== 'send') {
      this.overlay?.toast('Select a suggestion first.', 'info');
      return;
    }

    switch (a) {
      case 'shorter':
        await this.rewrite('short');
        return;
      case 'longer':
        await this.rewrite('long');
        return;
      case 'translate': {
        const target = this.settings?.translation.myLanguage ?? 'fr';
        const res = await rpc(MSG.REQUEST_TRANSLATION, {
          text: text!,
          targetLanguage: target,
          tone: this.settings?.conversation.style ?? 'natural',
        });
        if (res.ok && res.data?.text) {
          this.suggestions[this.selectedIndex] = { ...this.suggestions[this.selectedIndex]!, text: res.data.text, lang: target };
          this.overlay?.update({ suggestions: [...this.suggestions] });
          this.overlay?.toast(`Translated to ${target}.`, 'success');
        } else {
          this.overlay?.toast(res.error ?? 'Translation failed.', 'error');
        }
        return;
      }
      case 'copy': {
        try {
          await navigator.clipboard.writeText(text!);
          this.overlay?.toast('Copied to clipboard.', 'success');
        } catch {
          this.overlay?.toast('Clipboard access was denied by the browser.', 'error');
        }
        return;
      }
      case 'insert':
        await this.insert(text ?? '');
        return;
      case 'send':
        await this.sendNow();
        return;
    }
  }

  /** Regenerates with a different length so the reply shrinks or grows. */
  private async rewrite(length: 'short' | 'long'): Promise<void> {
    if (!this.settings || !this.conversation) return;
    const original = this.settings.conversation.length;
    this.settings = { ...this.settings, conversation: { ...this.settings.conversation, length } };
    try {
      await this.generate(true);
    } finally {
      this.settings = { ...this.settings, conversation: { ...this.settings.conversation, length: original } };
    }
  }

  private async insert(text: string, autoChain = false): Promise<void> {
    if (!this.adapter || !this.conversation) return;
    const clean = normaliseText(text);
    if (!clean) return;

    const transition = this.machine.dispatch({ type: 'insert', conversationId: this.conversation.id });
    if (transition.action !== 'insert' && !autoChain) {
      if (this.settings?.automation.mode === 'manual') {
        this.overlay?.toast('Manual mode: copy the reply yourself, or switch to Assisted.', 'info');
        return;
      }
    }

    const input = this.adapter.getInput(document);
    if (!input) {
      log.warn('content', 'reply field not found');
      this.overlay?.toast('ROSE could not find the message field on this page.', 'error');
      return;
    }

    const ok = this.adapter.insertText(input, clean);
    if (!ok) {
      this.overlay?.toast('ROSE could not write into the message field.', 'error');
      return;
    }

    log.info('content', 'response inserted', { chars: clean.length });
    const after = this.machine.dispatch({ type: 'inserted', conversationId: this.conversation.id }, {
      contentAllowed: isAutoSendBlocked(clean).allowed,
      contentReason: isAutoSendBlocked(clean).reason,
      rateAllowed: true,
      cooldownReady: true,
      policyAllowed: true,
    });
    this.syncOverlay(after.reason);

    if (after.action === 'schedule-send') {
      this.scheduleSend(clean);
    }
  }

  private scheduleSend(text: string): void {
    if (this.pendingSendTimer) clearTimeout(this.pendingSendTimer);
    const delay = this.settings?.automation.replyDelayMs ?? 4000;

    log.info('content', `auto-send scheduled in ${delay}ms`);
    this.pendingSendTimer = setTimeout(() => {
      this.pendingSendTimer = null;
      const elapsed = this.machine.dispatch({ type: 'delay-elapsed', conversationId: this.conversation?.id ?? '' }, {
        contentAllowed: isAutoSendBlocked(text).allowed,
        contentReason: isAutoSendBlocked(text).reason,
        rateAllowed: true,
        cooldownReady: true,
        policyAllowed: true,
      });
      if (elapsed.action === 'send') void this.performSend(text);
      else this.syncOverlay(elapsed.reason);
    }, delay);
  }

  private async sendNow(): Promise<void> {
    const text = this.selectedText();
    if (!text) {
      this.overlay?.toast('Nothing to send.', 'info');
      return;
    }
    if (!this.settings) return;

    // Sending outside auto mode is always an explicit human action, so we only
    // enforce the hard content block here, not the automation gates.
    const blocked = isAutoSendBlocked(text);
    if (!blocked.allowed) {
      this.overlay?.toast(blocked.reason ?? 'Message blocked.', 'error');
      return;
    }

    const transition = this.machine.dispatch({ type: 'send', conversationId: this.conversation?.id ?? '' }, {
      contentAllowed: true,
      rateAllowed: true,
      cooldownReady: true,
      policyAllowed: true,
    });

    if (transition.action !== 'send') {
      // Manual mode refuses to send through the state machine; the human asked
      // explicitly, so fall back to a direct send.
      if (this.settings.automation.mode !== 'manual') {
        this.overlay?.toast(transition.reason ?? 'Send refused.', 'error');
        return;
      }
    }
    await this.performSend(text);
  }

  private async performSend(text: string): Promise<void> {
    if (!this.adapter || !this.conversation) return;

    const input = this.adapter.getInput(document);
    if (!input) {
      this.overlay?.toast('ROSE could not find the message field.', 'error');
      return;
    }

    this.syncOverlay('sending…');
    // Make sure the field holds exactly what we are about to send.
    this.adapter.insertText(input, text);
    await sleep(60);

    try {
      const ok = await this.adapter.send(input);
      if (!ok) {
        this.overlay?.toast('ROSE could not trigger send on this page. The text is in the field — press Enter.', 'info');
        this.syncOverlay('manual send required');
        return;
      }
    } catch (err) {
      log.error('content', 'send failed', err);
      this.overlay?.toast('Send failed. The text is in the field.', 'error');
      return;
    }

    this.machine.dispatch({ type: 'sent', conversationId: this.conversation.id });
    this.syncOverlay('sent');

    // Record the outgoing turn so memory, stats and anti-repetition stay accurate.
    void rpc(MSG.RECORD_OUTGOING, {
      conversation: this.conversation,
      text,
      language: this.overlay?.getState().conversationLanguage ?? null,
      sent: true,
    });

    log.info('content', 'response sent');
    await this.refreshStats();
  }

  private async setMode(mode: AutomationMode): Promise<void> {
    if (!this.settings) return;
    if (mode === 'auto') {
      // Arming auto is the one destructive-feeling action: require an explicit
      // acknowledgement so it cannot be switched on by a stray click.
      const confirmed = await this.confirmAuto();
      if (!confirmed) return;
    }

    this.settings = await storage.patchSettings({ automation: { mode } } as Partial<RoseSettings>);
    const res = this.machine.dispatch({ type: 'mode-changed', mode });
    this.overlay?.update({ mode, statusNote: res.reason ?? null });
    this.syncOverlay(res.reason);
    log.info('content', `mode set to ${mode}`);
    this.overlay?.toast(`Mode: ${mode.toUpperCase()}`, 'success');
  }

  private confirmAuto(): Promise<boolean> {
    // A native confirm() is the most reliable cross-site confirmation and cannot
    // be styled away by the host page.
    const message =
      'Enable AUTO mode?\n\nROSE will insert and send replies automatically after the configured delay.\n' +
      'The STOP button always takes back control immediately. Only enable this where automatic replies are permitted by the platform.';
    try {
      return Promise.resolve(window.confirm(message));
    } catch {
      return Promise.resolve(false);
    }
  }

  private async togglePause(): Promise<void> {
    if (!this.settings) return;
    const next = !this.settings.automation.globalPaused;
    this.settings = await storage.patchSettings({ automation: { globalPaused: next } } as Partial<RoseSettings>);
    const res = this.machine.dispatch({ type: next ? 'pause' : 'resume' });
    this.overlay?.update({ paused: next, statusNote: res.reason ?? null });
    this.syncOverlay(res.reason);
    this.overlay?.toast(next ? 'ROSE paused.' : 'ROSE resumed.', next ? 'info' : 'success');
  }

  private stopAll(): void {
    if (this.pendingSendTimer) {
      clearTimeout(this.pendingSendTimer);
      this.pendingSendTimer = null;
    }
    this.sendAbort?.abort();
    this.sendAbort = null;

    const res = this.machine.dispatch({ type: 'stop' });
    this.overlay?.update({ paused: true, statusNote: res.reason ?? 'stopped' });
    this.syncOverlay('STOP — all automatic action halted');
    this.overlay?.toast('STOP engaged. ROSE will not act automatically.', 'error', 6000);
    log.warn('content', 'global stop engaged');

    // Re-arm after a short grace period so the operator is not stuck, but never
    // automatically resume sending.
    setTimeout(() => {
      if (this.destroyed) return;
      this.machine.dispatch({ type: 'arm' });
      this.syncOverlay('armed — waiting for your instruction');
    }, 1500);
  }

  private async refreshStats(): Promise<void> {
    try {
      const g = globalThis as unknown as { chrome?: typeof chrome };
      // Stats live in the background; read them from storage directly to avoid
      // adding an RPC round-trip per message.
      const today = await storage.getStats();
      this.statsSnapshot = {
        tokens: today.tokensPrompt + today.tokensCompletion,
        requests: today.requests,
        costUsd: today.costUsd,
      };
      void g;
      this.overlay?.update({
        tokensUsed: this.statsSnapshot.tokens,
        requestsToday: this.statsSnapshot.requests,
        estimatedCostUsd: this.statsSnapshot.costUsd,
      });
    } catch {
      /* stats are cosmetic; ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Live call assistant
  // -------------------------------------------------------------------------

  private async toggleLive(): Promise<void> {
    if (!this.settings) return;
    if (this.live?.isActive) {
      this.live.stop();
      this.overlay?.update({ liveActive: false, liveTranscript: '' });
      return;
    }

    this.live = new LiveCallAssistant({
      onInterim: (t) => this.overlay?.update({ liveTranscript: t }),
      onFinal: (t) => void this.onLiveFinal(t),
      onError: (m) => {
        this.overlay?.toast(m, 'error');
        this.overlay?.update({ liveActive: false });
      },
      onStateChange: (active) => this.overlay?.update({ liveActive: active }),
    });

    const availability = this.live.checkAvailability();
    if (!availability.available) {
      this.overlay?.toast(availability.reason, 'info', 8000);
      return;
    }

    const result = this.live.start({
      language: this.settings.liveCall.language,
      interim: this.settings.liveCall.showInterim,
    });
    if (!result.available) {
      this.overlay?.toast(result.reason, 'error');
      return;
    }
    this.overlay?.update({ liveActive: true, liveTranscript: 'Listening…' });
    this.overlay?.toast(
      'Live assist is listening through your microphone. ROSE cannot access the remote audio stream directly.',
      'info',
      8000,
    );
  }

  private async onLiveFinal(transcript: string): Promise<void> {
    this.overlay?.update({ liveTranscript: formatLiveTranscript(this.conversation, transcript) });
    // Speech becomes a suggestion request, exactly like a typed message.
    if (!this.conversation) return;
    this.lastIncoming = transcript;
    this.overlay?.update({ incoming: transcript });
    await this.generate();
  }

  // -------------------------------------------------------------------------
  // Commands + SPA navigation
  // -------------------------------------------------------------------------

  private listenForCommands(): void {
    const g = globalThis as unknown as { chrome?: typeof chrome };
    g.chrome?.runtime?.onMessage?.addListener((message: unknown, _sender, sendResponse) => {
      const env = message as { type?: string; payload?: Command };
      if (env?.type !== MSG.COMMAND || !env.payload) return false;

      const cmd = env.payload;
      void (async () => {
        try {
          switch (cmd.action) {
            case 'insert':
              this.suggestions = [{ kind: 'natural', text: cmd.text, lang: 'en' }];
              this.selectedIndex = 0;
              this.overlay?.update({ suggestions: this.suggestions, selectedIndex: 0 });
              await this.insert(cmd.text);
              break;
            case 'stop-all':
              this.stopAll();
              break;
            case 'set-mode':
              await this.setMode(cmd.mode);
              break;
            case 'pause-conversation':
              if (cmd.paused) {
                if (this.conversation) this.settings!.automation.pausedConversations.push(this.conversation.id);
              }
              break;
            case 'rescan':
              this.messageDetector?.rescan(document);
              this.report = this.detector.detect(document);
              this.overlay?.toast('Rescanned the page.', 'success');
              break;
            case 'toggle-overlay':
              if (this.overlay) this.toggleCollapse();
              else this.mountOverlay();
              break;
            case 'open-conversation':
              this.overlay?.update({ collapsed: false });
              break;
          }
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true;
    });
  }

  /**
   * Chat platforms are SPAs: the URL and the chat column change without a page
   * load. We poll the URL cheaply and re-resolve everything when it moves.
   */
  private watchSpaNavigation(): void {
    let lastUrl = location.href;
    const check = () => {
      if (this.destroyed) return;
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log.info('content', 'SPA navigation detected; re-resolving adapter');
        this.report = this.detector.detect(document);
        this.adapter = this.detector.resolve(document);
        this.overlay?.update({ platformLabel: this.adapter.label });
        this.messageDetector?.rescan(document);
        this.onConversationChanged();
      }
    };
    // `popstate` misses pushState; a light interval is the reliable catch-all.
    window.addEventListener('popstate', check);
    window.addEventListener('hashchange', check);
    this.spaTimer = setInterval(check, 1200);

    // Some platforms swap the chat container in place; re-resolve the adapter
    // when our resolved input disappears.
    this.idleTimer = setInterval(() => {
      if (this.destroyed || !this.adapter) return;
      const input = this.adapter.getInput(document);
      if (!input && this.messageDetector) {
        log.warn('content', 'reply field vanished; rescanning');
        this.messageDetector.rescan(document);
      }
    }, 8000);
  }

  // -------------------------------------------------------------------------
  // UI sync
  // -------------------------------------------------------------------------

  private syncOverlay(note?: string): void {
    if (!this.overlay) return;
    const snap = this.machine.snapshot();
    this.overlay.update({
      mode: snap.mode,
      automationState: snap.state as AutomationState,
      busy: snap.isBusy,
      paused: snap.isPaused,
      canSend: true,
      statusNote: note ?? null,
      error: snap.error,
      logs: this.settings?.debug.showOverlay ? getLogEntries() : [],
    });
  }

  /** Re-reads settings changed in the Options page without a page reload. */
  async reloadSettings(): Promise<void> {
    this.settings = await storage.loadSettings();
    configureLogging({ enabled: this.settings.debug.enabled, verbose: this.settings.debug.verbose });
    this.machine.applyConfig(this.settings.automation);
    this.overlay?.update({
      mode: this.settings.automation.mode,
      paused: this.settings.automation.globalPaused,
      debugVisible: this.settings.debug.showOverlay,
      theme: this.settings.appearance.theme === 'light' ? 'light' : 'dark',
      accent: this.settings.appearance.accent,
      opacity: this.settings.appearance.opacity,
    });
    log.info('content', 'settings reloaded');
  }

  shutdown(): void {
    this.destroyed = true;
    if (this.pendingSendTimer) clearTimeout(this.pendingSendTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.spaTimer) clearInterval(this.spaTimer);
    this.messageDetector?.stop();
    this.live?.stop();
    this.overlay?.unmount();
    log.info('content', 'ROSE shut down for this page');
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let controller: RoseController | null = null;

async function boot(): Promise<void> {
  // Guard against double injection (reloads, SPA re-runs, manual re-injection).
  if ((globalThis as unknown as { __roseBooted?: boolean }).__roseBooted) {
    log.info('content', 'already booted; skipping duplicate injection');
    return;
  }
  (globalThis as unknown as { __roseBooted?: boolean }).__roseBooted = true;

  controller = new RoseController();
  try {
    await controller.init();
  } catch (err) {
    log.error('content', 'initialisation failed', err);
    // Do not leave the page in a broken state; the overlay may be absent but the
    // host page must keep working.
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
} else {
  void boot();
}

// React to settings changes broadcast by the background worker.
const gRuntime = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
gRuntime?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !changes['rose:settings']) return;
  void controller?.reloadSettings();
});

// Expose a tiny debug handle for manual inspection from the page console.
Object.defineProperty(window, 'ROSE_IA', {
  value: {
    version: VERSION,
    get controller() {
      return controller;
    },
    logs: () => getLogEntries(),
    estimateTokens,
    truncate,
  },
  configurable: true,
});
