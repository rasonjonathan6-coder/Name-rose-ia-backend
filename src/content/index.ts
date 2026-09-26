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
  OverlayIntent,
  QualityIssue,
  RoseSettings,
  Suggestion,
} from '@/shared/types';
import { PlatformDetector } from '@/platforms/detector';
import type { PlatformAdapter } from '@/platforms/types';
import { documentUrl } from '@/platforms/types';
import { BUILTIN_CONFIGS } from '@/platforms/generic/config';
import {
  decideFrameRole,
  shouldMountOverlay,
  shouldRunPipeline,
  frameKey,
  type FrameRole,
} from '@/content/frame-role';
import { MessageDetector } from '@/core/conversation/message-detector';
import { AutomationStateMachine } from '@/core/automation/state-machine';
import { ResponseQualityGuard } from '@/core/safety/quality-guard';
import { isAutoSendBlocked } from '@/core/safety/policy';
import { LiveCallAssistant, formatLiveTranscript } from '@/core/conversation/live-assistant';
import { ConversationEngine } from '@/core/conversation/engine';
import { detectLanguage } from '@/core/translation/language';
import { configureLogging, log, getLogEntries, onLog } from '@/core/logging/logger';
import { RoseOverlay } from '@/ui/overlay';
import type { OverlayState } from '@/ui/overlay';
import type { OverlaySurface } from '@/ui/surface';
import { RemoteOverlay, dispatchOverlayIntent, onOverlayIntent } from '@/ui/remote-overlay';
import { rpc } from '@/shared/rpc';
import { estimateTokens, normaliseText, sleep, truncate } from '@/shared/utils';
import * as storage from '@/storage';

const VERSION = '0.1.0';

class RoseController {
  private detector = new PlatformDetector();
  private adapter: PlatformAdapter | null = null;
  private messageDetector: MessageDetector | null = null;
  private overlay: OverlaySurface | null = null;
  /** Set when this frame draws a panel whose data belongs to another frame. */
  private mirrorFor: number | null = null;
  /** Set when this frame owns the chat data but forwards panel updates. */
  private remoteOverlay: RemoteOverlay | null = null;
  /** Whether the arbiter has allowed this frame to draw the panel. */
  private rendersPanel = false;
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
  /** What this frame is allowed to do (see content/frame-role). */
  private role: FrameRole = 'top';
  private readonly tabId: number | null = currentTabId();
  private readonly frameId: number = currentFrameId();

  async init(): Promise<void> {
    this.settings = await storage.loadSettings();
    configureLogging({ enabled: this.settings.debug.enabled, verbose: this.settings.debug.verbose });

    this.detector.registerBuiltinConfigs(BUILTIN_CONFIGS);
    this.report = this.detector.detect(document);
    this.adapter = this.detector.resolve(document);

    // Decide what this frame is allowed to do before anything is mounted. The
    // chat on some platforms (CooMeet) lives in a child frame, so the script now
    // runs in child frames too — this is what stops a second overlay appearing
    // inside one, and what stops ROSE attaching to ad/consent frames.
    this.role = decideFrameRole({
      isTopFrame: isTopFrame(),
      platformClaimsHost: this.detector.claimsHost(documentUrl(document)),
      chatDetected: !!this.report.resolved.input || !!this.report.resolved.container,
    });

    log.info('content', `ROSE initialised on ${this.report.hostname}`, {
      platform: this.report.platform,
      confidence: this.report.confidence,
      role: this.role,
      isTopFrame: isTopFrame(),
    });

    // Report detection, but never let a failure block the overlay. The response
    // also carries this frame's panel verdict, because the push notification can
    // be lost if this frame's listener did not exist yet.
    //
    // That is exactly why the command listener is wired *before* this call:
    // reporting is what makes the arbiter elect a renderer, and the election
    // pushes `mount-overlay` straight back to this frame. Registering the
    // listener afterwards drops that push (observed as "could not reach frame
    // <tabId>:0") and leaves the panel dependent on the verdict fallback alone.
    const relevant = shouldRunPipeline(this.role);
    if (relevant) {
      this.machine = new AutomationStateMachine({ mode: this.settings.automation.mode });
      this.machine.applyConfig(this.settings.automation);
      this.listenForCommands();
    }

    const verdict = await rpc(MSG.DETECTION_REPORT, {
      report: this.report,
      role: this.role,
      frame: this.frameIdentity(),
    }).catch(() => null);

    if (!relevant) {
      log.info('content', 'frame not relevant to ROSE; standing down', { role: this.role });
      return;
    }

    // A frame that only mirrors another frame's panel must not run its own
    // pipeline: on the CooMeet shape the shell frame has no chat, and letting its
    // empty pipeline publish would overwrite the real state arriving from the
    // chat frame.
    const pureMirror = !!verdict?.ok && !!verdict.data?.render && verdict.data.mirrorFor !== null;

    // The panel surface is created before detection starts. Detection can fire a
    // message callback on the very first scan, and the state it publishes has to
    // land somewhere; creating the surface afterwards would drop that first
    // message and leave the panel blank until the next one.
    if (verdict?.ok && verdict.data) {
      this.applyPanelVerdict(verdict.data);
    } else if (shouldMountOverlay(this.role)) {
      // No arbitration available (an older background, or the report failed):
      // fall back to the pre-existing single-frame behaviour so ROSE still works
      // rather than silently showing nothing.
      this.rendersPanel = true;
      this.mountOverlay();
      this.announceActive();
    }

    if (!pureMirror) {
      this.startDetection();
      this.watchSpaNavigation();
      this.watchFrameTeardown();
      // The chat frame may receive panel actions from the frame that draws the
      // panel, so the intent handler is always wired, not only in publishing mode.
      onOverlayIntent((intent) => this.handleOverlayIntent(intent));
    }
  }

  /**
   * Acts on the arbiter's verdict for this frame.
   *
   * Four cases, and only these:
   *   render + no mirror      — this frame draws its own chat's panel (the usual
   *                             single-frame site).
   *   render + mirror N       — this frame draws frame N's chat (the CooMeet
   *                             shape: the panel must be in the top frame because
   *                             a `position: fixed` panel inside an iframe is
   *                             clipped to that iframe).
   *   no render + owns data   — this frame has the chat but another frame draws,
   *                             so it publishes its panel state instead.
   *   neither                 — nothing to do.
   */
  private applyPanelVerdict(verdict: { render: boolean; mirrorFor: number | null; dataOwner: boolean }): void {
    if (!verdict.render) {
      if (verdict.dataOwner) this.startPublishingPanelState();
      return;
    }

    this.rendersPanel = true;
    if (verdict.mirrorFor === null) {
      this.mirrorFor = null;
      if (!this.overlay) this.mountOverlay();
      this.announceActive();
      return;
    }

    // Mirroring: this frame has no chat of its own, so the panel is a remote
    // view. Telling the background we are ready makes it send the current
    // snapshot and ask the source frame to republish.
    this.mirrorFor = verdict.mirrorFor;
    if (!this.overlay) this.mountOverlay();
    this.overlay?.update({ platformLabel: this.adapter?.label ?? 'Generic chat' });
    void rpc(MSG.OVERLAY_MIRROR_READY, {}).catch(() => undefined);
  }

  /**
   * Tells the operator ROSE is attached and how confident the detection was.
   *
   * Split out because the same message is shown both when the arbiter verdict
   * arrives and on the fallback path where no arbitration happened.
   */
  private announceActive(): void {
    if (!this.report) return;
    this.overlay?.toast(
      `ROSE active — ${this.report.platform} (${Math.round(this.report.confidence * 100)}% confidence)`,
      'success',
    );
  }

  /**
   * Switches this frame to publishing mode: it owns the chat data but another
   * frame draws the panel, so every panel update is forwarded instead of drawn.
   *
   * A `RemoteOverlay` is used as the surface, so all the existing
   * `this.overlay.update(...)` call sites keep working unchanged.
   */
  private startPublishingPanelState(): void {
    if (this.remoteOverlay) return;
    this.remoteOverlay = new RemoteOverlay();
    this.overlay = this.remoteOverlay;
    this.remoteOverlay.mount();
  }

  /** Applies a state snapshot published by the frame that owns the chat data. */
  private applyMirrorState(fromFrameId: number, state: Record<string, unknown>, mounted: boolean): void {
    if (this.mirrorFor !== fromFrameId) {
      log.debug('content', 'mirror state ignored (not my source)', {
        fromFrameId,
        mirrorFor: this.mirrorFor,
      });
      return;
    }
    if (!mounted) {
      this.destroyOverlay();
      return;
    }
    // `toast` is a one-shot side channel rather than panel state, so it is pulled
    // out and played once instead of being merged into the persistent state.
    const { toast, ...rest } = state as Partial<OverlayState> & {
      toast?: { message: string; kind?: 'info' | 'error' | 'success'; ms?: number };
    };
    log.debug('content', 'mirror state applied', {
      hasOverlay: !!this.overlay,
      conversationName: rest.conversationName,
      incoming: rest.incoming,
      suggestionCount: rest.suggestions?.length ?? 0,
    });
    this.overlay?.update(rest);
    if (toast?.message) this.overlay?.toast(toast.message, toast.kind ?? 'info', toast.ms);
  }

  /** Stable identity for this frame, from the extension's own metadata. */
  private frameIdentity(): { tabId: number | null; frameId: number; url: string; key: string } {
    const url = documentUrl(document).href;
    return {
      tabId: this.tabId,
      frameId: this.frameId,
      url,
      key: frameKey(this.tabId, this.frameId, url),
    };
  }

  /**
   * Whether this frame holds an actual chat surface.
   *
   * Recomputed rather than cached: a SPA can mount the composer after the initial
   * detection, and this gates command handling (an insert must not land in an
   * unrelated field on a frame that only carries the platform shell).
   */
  private hasChatSurface(): boolean {
    if (!this.adapter) return false;
    try {
      return !!this.adapter.getInput(document) || !!this.adapter.getMessageContainer(document);
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Overlay
  // -------------------------------------------------------------------------

  private mountOverlay(): void {
    const s = this.settings!;
    // When the chat lives in a child frame, the panel is drawn here but the data
    // belongs elsewhere. Every callback then forwards an intent over RPC instead
    // of acting on a chat this frame does not have.
    const mirroring = this.mirrorFor !== null;
    const forward = (intent: OverlayIntent): void => {
      void rpc(MSG.OVERLAY_INTENT, { intent });
    };
    try {
      this.overlay = new RoseOverlay(
        {
          onGenerate: () => (mirroring ? forward({ action: 'generate', force: false }) : void this.generate()),
          onRegenerate: () => (mirroring ? forward({ action: 'generate', force: true }) : void this.generate(true)),
          onSelect: (sug) =>
            mirroring ? forward({ action: 'select', index: this.suggestions.indexOf(sug) }) : this.select(sug),
          onAction: (a) => (mirroring ? forward({ action: 'action', kind: a }) : void this.action(a)),
          onModeChange: (m) => (mirroring ? forward({ action: 'set-mode', mode: m }) : void this.setMode(m)),
          onStop: () => (mirroring ? forward({ action: 'stop-all' }) : this.stopAll()),
          onPauseToggle: () => (mirroring ? forward({ action: 'pause-toggle' }) : void this.togglePause()),
          onCollapse: () => this.toggleCollapse(),
          onClose: () => this.destroyOverlay(),
          onOpenOptions: () => this.openOptions(),
          onOpenDashboard: () => this.openDashboard(),
          onLiveToggle: () => (mirroring ? forward({ action: 'live-toggle' }) : void this.toggleLive()),
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
          // A mirror starts blank; the source frame fills it in.
          conversationName: mirroring ? 'Connecting…' : 'Unknown',
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
      // The detector primes existing history without emitting it as "new", so
      // nothing has published the conversation identity yet. Without this the
      // panel shows its placeholder name until the client's *next* message,
      // even though the conversation is already on screen.
      this.onConversationChanged();
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

  /**
   * Tells the background when this frame goes away.
   *
   * The overlay arbiter needs this: a chat frame that navigates away would
   * otherwise keep owning the UI, leaving the tab with no visible overlay at all.
   * `pagehide` fires on navigation and on frame removal, and unlike
   * `chrome.webNavigation` it needs no extra permission.
   */
  private watchFrameTeardown(): void {
    const announce = () => {
      if (this.destroyed) return;
      this.destroyed = true;
      void rpc(MSG.FRAME_GONE, {} as never).catch(() => undefined);
    };
    window.addEventListener('pagehide', announce, { once: true });
    window.addEventListener('unload', announce, { once: true });
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

    // Sync first, then publish the suggestions: every action button is disabled
    // while `busy` is true, so writing the suggestions before clearing `busy`
    // leaves the panel showing replies whose Insert/Copy are greyed out — the
    // operator sees the result but cannot act on it until the next update.
    this.syncOverlay(
      res.data?.result.cached
        ? 'cached reply (no tokens spent)'
        : `${res.data?.result.model ?? 'model'} · ${res.data?.result.latencyMs ?? 0}ms`,
    );
    this.overlay?.update({
      suggestions: this.suggestions,
      suggestionIssues: this.suggestionIssues,
      selectedIndex: 0,
      error: null,
    });
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

  /**
   * Handles an operator action forwarded from the frame that draws the panel.
   *
   * Only relevant when this frame owns the chat but does not draw: the panel is
   * in another frame, so its buttons arrive here as intents rather than as direct
   * calls.
   */
  private handleOverlayIntent(intent: OverlayIntent): void {
    switch (intent.action) {
      case 'generate':
        void this.generate(intent.force);
        break;
      case 'select':
        if (this.suggestions[intent.index]) this.select(this.suggestions[intent.index]!);
        break;
      case 'action':
        void this.action(intent.kind);
        break;
      case 'set-mode':
        void this.setMode(intent.mode);
        break;
      case 'stop-all':
        this.stopAll();
        break;
      case 'pause-toggle':
        void this.togglePause();
        break;
      case 'live-toggle':
        void this.toggleLive();
        break;
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
      // A tab can hold several frames that run the pipeline (the CooMeet shell
      // plus its chat frame). Only the frame that actually resolved a composer
      // may act on an insertion, otherwise a broadcast could write into an
      // unrelated field on the shell page.
      if (cmd.action === 'insert' && !this.hasChatSurface()) {
        log.debug('content', 'ignoring insert: no chat surface in this frame');
        sendResponse({ ok: true, ignored: 'no-chat-surface' });
        return false;
      }

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
            case 'mount-overlay':
              // Arbitrated by the background: this frame draws the panel, either
              // for its own chat or as a mirror of another frame's.
              this.applyPanelVerdict({ render: true, mirrorFor: cmd.mirrorFor, dataOwner: false });
              break;
            case 'unmount-overlay':
              // Another frame took over the panel; remove ours so the operator
              // never sees two.
              this.rendersPanel = false;
              this.mirrorFor = null;
              if (this.overlay) this.destroyOverlay();
              break;
            case 'mirror-state':
              log.debug('content', 'mirror state received', {
                fromFrameId: cmd.fromFrameId,
                mirrorFor: this.mirrorFor,
                mounted: cmd.mounted,
              });
              this.applyMirrorState(cmd.fromFrameId, cmd.state, cmd.mounted);
              break;
            case 'republish-overlay':
              this.remoteOverlay?.republish();
              break;
            case 'overlay-intent':
              dispatchOverlayIntent(cmd.intent);
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

/**
 * Whether this document is the top-level frame.
 *
 * `window.top` access throws in a cross-origin frame, so it is wrapped: a throw
 * is itself proof that we are not the top frame.
 */
function isTopFrame(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

/** Frame id from the extension's own metadata (0 = top frame). */
function currentFrameId(): number {
  const g = globalThis as unknown as { chrome?: { runtime?: { getFrameId?: () => number } } };
  try {
    return g.chrome?.runtime?.getFrameId?.() ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The tab id is not exposed to a content script, so it is resolved once over
 * RPC. Until it arrives, `frameKey` uses a stable placeholder — the key is only
 * ever used for identity/logging, never for authorization.
 */
function currentTabId(): number | null {
  return null;
}

let controller: RoseController | null = null;

async function boot(): Promise<void> {
  // Guard against double injection (reloads, SPA re-runs, manual re-injection).
  // The guard is per-document, so each frame gets its own controller — which is
  // required now that ROSE attaches to child frames.
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
