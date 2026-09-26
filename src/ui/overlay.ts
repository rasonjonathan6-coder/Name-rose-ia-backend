import type {
  AutomationMode,
  AutomationState,
  ConversationStatus,
  QualityIssue,
  Suggestion,
} from '@/shared/types';
import { STATE_LABELS } from '@/core/automation/state-machine';
import type { LogEntry } from '@/core/logging/logger';
import { flagFor } from '@/core/translation/language';
import { OVERLAY_CSS } from './styles';

/**
 * RoseOverlay — the floating assistant UI.
 *
 * Lives in a closed-off shadow root so the host page cannot restyle it and its
 * CSS cannot leak out. Renders nothing until `mount()` is called, and every
 * interactive element is wired through the callbacks passed to the constructor,
 * so the UI holds no business logic of its own.
 */

export interface OverlayCallbacks {
  onGenerate: () => void;
  onRegenerate: () => void;
  onSelect: (suggestion: Suggestion) => void;
  onAction: (action: 'shorter' | 'longer' | 'translate' | 'copy' | 'insert' | 'send') => void;
  onModeChange: (mode: AutomationMode) => void;
  onStop: () => void;
  onPauseToggle: () => void;
  onCollapse: () => void;
  onClose: () => void;
  onOpenOptions: () => void;
  onOpenDashboard: () => void;
  onLiveToggle: () => void;
}

export interface OverlayState {
  collapsed: boolean;
  mode: AutomationMode;
  automationState: AutomationState;
  paused: boolean;
  conversationName: string;
  conversationStatus: ConversationStatus;
  conversationLanguage: string | null;
  platformLabel: string;
  incoming: string;
  incomingTranslation: string | null;
  suggestions: Suggestion[];
  suggestionIssues: Record<number, QualityIssue[]>;
  selectedIndex: number;
  busy: boolean;
  error: string | null;
  statusNote: string | null;
  canSend: boolean;
  tokensUsed: number;
  requestsToday: number;
  estimatedCostUsd: number;
  liveActive: boolean;
  liveTranscript: string;
  debugVisible: boolean;
  logs: LogEntry[];
  position: { x: number; y: number };
  size: { w: number; h: number };
  opacity: number;
  theme: 'dark' | 'light';
  accent: 'violet' | 'rose' | 'cyan';
}

const KIND_LABELS: Record<Suggestion['kind'], string> = {
  natural: 'Natural',
  warm: 'Warm',
  engaging: 'Engaging',
};

export class RoseOverlay {
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private root!: HTMLDivElement;
  private launcher!: HTMLDivElement;
  private toastEl: HTMLDivElement | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private state: OverlayState;
  private dragging: { startX: number; startY: number; originX: number; originY: number } | null = null;
  private resizing: { startX: number; startY: number; w: number; h: number } | null = null;
  private destroyed = false;

  constructor(
    private readonly callbacks: OverlayCallbacks,
    initial: Partial<OverlayState> = {},
  ) {
    this.state = {
      collapsed: false,
      mode: 'manual',
      automationState: 'idle',
      paused: false,
      conversationName: 'Unknown',
      conversationStatus: 'new',
      conversationLanguage: null,
      platformLabel: 'Generic chat',
      incoming: '',
      incomingTranslation: null,
      suggestions: [],
      suggestionIssues: {},
      selectedIndex: 0,
      busy: false,
      error: null,
      statusNote: null,
      canSend: false,
      tokensUsed: 0,
      requestsToday: 0,
      estimatedCostUsd: 0,
      liveActive: false,
      liveTranscript: '',
      debugVisible: false,
      logs: [],
      position: { x: -1, y: -1 },
      size: { w: 372, h: 560 },
      opacity: 0.97,
      theme: 'dark',
      accent: 'violet',
      ...initial,
    };

    this.host = document.createElement('div');
    this.host.id = 'rose-shadow-host';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    this.shadow.appendChild(style);
  }

  mount(): void {
    if (this.destroyed) return;
    if (!document.getElementById('rose-shadow-host')) {
      document.documentElement.appendChild(this.host);
    }
    this.render();
  }

  unmount(): void {
    this.destroyed = true;
    this.host.remove();
  }

  get isMounted(): boolean {
    return !!this.host.isConnected;
  }

  /** Merges a partial state update and re-renders only if something changed. */
  update(patch: Partial<OverlayState>): void {
    let changed = false;
    const target = this.state as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (target[k] !== v) {
        target[k] = v;
        changed = true;
      }
    }
    if (changed) this.render();
  }

  getState(): Readonly<OverlayState> {
    return this.state;
  }

  toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ms = 4200): void {
    if (this.toastEl) this.toastEl.remove();
    if (this.toastTimer) clearTimeout(this.toastTimer);

    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.kind = kind;
    el.setAttribute('role', 'status');
    el.textContent = message;
    this.shadow.appendChild(el);
    this.toastEl = el;

    this.toastTimer = setTimeout(() => {
      el.remove();
      if (this.toastEl === el) this.toastEl = null;
    }, ms);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    if (this.destroyed) return;
    const { collapsed } = this.state;

    // Keep the launcher and the panel as siblings so switching between them does
    // not lose the drag position.
    this.renderLauncher();
    this.renderPanel();

    this.launcher.classList.toggle('hidden', !collapsed);
    this.root.classList.toggle('hidden', collapsed);

    this.host.dataset.theme = this.state.theme;
    this.host.dataset.accent = this.state.accent;
    this.host.style.setProperty('--rose-opacity', String(this.state.opacity));
    this.host.style.setProperty('--rose-scale', String(1));

    this.applyPosition();
  }

  private ensureRoots(): void {
    if (!this.launcher) {
      this.launcher = document.createElement('div');
      this.launcher.className = 'launcher';
      this.shadow.appendChild(this.launcher);
    }
    if (!this.root) {
      this.root = document.createElement('div');
      this.root.className = 'root';
      this.shadow.appendChild(this.root);
    }
  }

  private applyPosition(): void {
    this.ensureRoots();
    const { x, y } = this.state.position;
    const w = this.state.size.w;

    if (x < 0 || y < 0) {
      // Default: top-right, offset so it does not cover a typical chat header.
      const px = Math.max(12, window.innerWidth - w - 24);
      const py = 84;
      this.root.style.left = `${px}px`;
      this.root.style.top = `${py}px`;
      this.launcher.style.left = `${px}px`;
      this.launcher.style.top = `${py}px`;
      this.state.position = { x: px, y: py };
      return;
    }

    this.root.style.left = `${x}px`;
    this.root.style.top = `${y}px`;
    this.launcher.style.left = `${x}px`;
    this.launcher.style.top = `${y}px`;
  }

  private renderLauncher(): void {
    this.ensureRoots();
    this.launcher.dataset.state = this.state.automationState;
    this.launcher.innerHTML = `
      <span class="mark">R</span>
      <span class="label">ROSE</span>
      <span class="dot" aria-hidden="true"></span>
    `;
    this.launcher.title = `ROSE IA — ${STATE_LABELS[this.state.automationState]}`;
    this.launcher.setAttribute('role', 'button');
    this.launcher.setAttribute('tabindex', '0');

    const expand = (e: Event) => {
      if (this.dragging) return;
      e.stopPropagation();
      this.callbacks.onCollapse();
    };
    this.launcher.addEventListener('click', expand);
    this.launcher.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') expand(e);
    });
    this.makeDraggable(this.launcher);
  }

  private renderPanel(): void {
    this.ensureRoots();
    const s = this.state;

    this.root.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.width = `${s.size.w}px`;
    panel.style.maxHeight = `${s.size.h}px`;
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'ROSE IA assistant');

    panel.appendChild(this.buildHeader());
    panel.appendChild(this.buildModeBar());
    panel.appendChild(this.buildStopBar());

    const body = document.createElement('div');
    body.className = 'body';
    body.appendChild(this.buildIncomingCard());
    body.appendChild(this.buildSuggestions());
    body.appendChild(this.buildActions());
    if (s.debugVisible) body.appendChild(this.buildDebug());
    panel.appendChild(body);

    panel.appendChild(this.buildStatusBar());
    if (s.liveActive) panel.appendChild(this.buildLiveBar());

    const resizer = document.createElement('div');
    resizer.className = 'resizer';
    resizer.title = 'Resize';
    panel.appendChild(resizer);
    this.makeResizable(resizer, panel);

    this.root.appendChild(panel);
    this.makeDraggable(panel.querySelector('.header') as HTMLElement);
  }

  private buildHeader(): HTMLElement {
    const s = this.state;
    const header = document.createElement('div');
    header.className = 'header';
    header.innerHTML = `
      <span class="mark">R</span>
      <div class="titles">
        <div class="title">ROSE IA</div>
        <div class="sub">${escapeHtml(s.conversationName)} · ${escapeHtml(s.platformLabel)}${
          s.conversationLanguage ? ` · ${flagFor(s.conversationLanguage)}` : ''
        }</div>
      </div>
    `;

    const mkBtn = (label: string, title: string, cls: string, fn: () => void) => {
      const b = document.createElement('button');
      b.className = `icon-btn ${cls}`;
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };

    header.appendChild(mkBtn('⏸', s.paused ? 'Resume ROSE' : 'Pause ROSE', '', this.callbacks.onPauseToggle));
    header.appendChild(mkBtn('⧉', 'Collapse', '', this.callbacks.onCollapse));
    header.appendChild(mkBtn('⚙', 'Settings', '', this.callbacks.onOpenOptions));
    header.appendChild(mkBtn('✕', 'Close ROSE on this page', 'danger', this.callbacks.onClose));
    return header;
  }

  private buildModeBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'modes';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Automation mode');

    const modes: Array<{ id: AutomationMode; label: string; title: string }> = [
      { id: 'manual', label: 'Manual', title: 'Generate only — ROSE never touches the message field' },
      { id: 'assisted', label: 'Assisted', title: 'ROSE inserts the reply; you press send' },
      { id: 'auto', label: 'Auto', title: 'ROSE inserts and sends after the configured delay' },
    ];

    for (const m of modes) {
      const b = document.createElement('button');
      b.className = 'mode';
      b.dataset.mode = m.id;
      b.textContent = m.label;
      b.title = m.title;
      b.setAttribute('aria-pressed', String(this.state.mode === m.id));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onModeChange(m.id);
      });
      bar.appendChild(b);
    }
    return bar;
  }

  private buildStopBar(): HTMLElement {
    const s = this.state;
    const bar = document.createElement('div');
    const needsStop =
      s.automationState === 'waiting-delay' ||
      s.automationState === 'sending' ||
      s.automationState === 'generating' ||
      s.automationState === 'stopped' ||
      s.mode === 'auto';
    bar.className = `stopbar${needsStop ? ' visible' : ''}`;

    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent =
      s.automationState === 'stopped'
        ? 'ROSE is stopped. No automatic action will run.'
        : s.mode === 'auto'
          ? 'Auto mode is armed. Keep the stop button within reach.'
          : 'Automatic action in progress.';
    bar.appendChild(msg);

    const btn = document.createElement('button');
    btn.className = 'stop-btn';
    btn.textContent = s.automationState === 'stopped' ? 'STOPPED' : 'STOP';
    btn.title = 'Stop everything immediately';
    btn.disabled = s.automationState === 'stopped';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onStop();
    });
    bar.appendChild(btn);
    return bar;
  }

  private buildIncomingCard(): HTMLElement {
    const s = this.state;
    const card = document.createElement('div');
    card.className = 'card';

    const label = document.createElement('div');
    label.className = 'card-label';
    label.innerHTML = `Client message${
      s.conversationStatus ? ` <span class="badge">${escapeHtml(statusLabel(s.conversationStatus))}</span>` : ''
    }`;
    card.appendChild(label);

    const text = document.createElement('div');
    text.className = `incoming${s.incoming ? '' : ' empty'}`;
    text.textContent = s.incoming || 'No incoming message detected yet.';
    card.appendChild(text);

    if (s.incomingTranslation) {
      const tr = document.createElement('div');
      tr.className = 'translation';
      tr.textContent = `${flagFor(s.conversationLanguage ?? 'en')} ${s.incomingTranslation}`;
      card.appendChild(tr);
    }
    return card;
  }

  private buildSuggestions(): HTMLElement {
    const s = this.state;
    const wrap = document.createElement('div');
    wrap.className = 'suggestions';

    if (s.busy && s.suggestions.length === 0) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="card-label">Generating</div><div class="incoming"><span class="spinner"></span> Asking ROSE…</div>`;
      wrap.appendChild(card);
      return wrap;
    }

    if (s.suggestions.length === 0) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="card-label">Suggestions</div><div class="incoming empty">${
        s.error ? escapeHtml(s.error) : 'Press Generate to get reply suggestions.'
      }</div>`;
      wrap.appendChild(card);
      return wrap;
    }

    s.suggestions.forEach((sug, i) => {
      const issues = s.suggestionIssues[i] ?? [];
      const blocked = issues.some((x) => x.severity === 'block');
      const btn = document.createElement('button');
      btn.className = `suggestion${blocked ? ' blocked' : ''}`;
      btn.setAttribute('aria-selected', String(i === s.selectedIndex));
      btn.setAttribute('type', 'button');

      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = `${KIND_LABELS[sug.kind] ?? sug.kind}${sug.lang ? ` · ${flagFor(sug.lang)}` : ''}`;
      btn.appendChild(kind);

      const txt = document.createElement('span');
      txt.className = 'text';
      txt.textContent = sug.text;
      btn.appendChild(txt);

      for (const issue of issues.filter((x) => x.severity !== 'info')) {
        const w = document.createElement('span');
        w.className = 'warn';
        w.textContent = `⚠ ${issue.detail}`;
        btn.appendChild(w);
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onSelect(sug);
      });
      wrap.appendChild(btn);
    });

    return wrap;
  }

  private buildActions(): HTMLElement {
    const s = this.state;
    const bar = document.createElement('div');
    bar.className = 'actions';
    const hasSuggestion = s.suggestions.length > 0 && s.selectedIndex >= 0;

    const add = (
      label: string,
      title: string,
      fn: () => void,
      opts: { cls?: string; disabled?: boolean } = {},
    ) => {
      const b = document.createElement('button');
      b.className = `action ${opts.cls ?? ''}`;
      b.textContent = label;
      b.title = title;
      b.disabled = !!opts.disabled || s.busy;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      bar.appendChild(b);
    };

    add(s.suggestions.length ? '↻ Regenerate' : '✨ Generate', 'Ask ROSE for replies', () =>
      s.suggestions.length ? this.callbacks.onRegenerate() : this.callbacks.onGenerate(),
    { cls: 'primary' });

    add('Shorter', 'Make the selected reply shorter', () => this.callbacks.onAction('shorter'), {
      disabled: !hasSuggestion,
    });
    add('Longer', 'Make the selected reply longer', () => this.callbacks.onAction('longer'), {
      disabled: !hasSuggestion,
    });
    add('Translate', 'Translate the selected reply to your language', () => this.callbacks.onAction('translate'), {
      disabled: !hasSuggestion,
    });
    add('Copy', 'Copy to clipboard', () => this.callbacks.onAction('copy'), { disabled: !hasSuggestion });
    add('Insert', 'Put the reply in the message field', () => this.callbacks.onAction('insert'), {
      disabled: !hasSuggestion || s.mode === 'manual',
    });
    add('Send', 'Insert and send now', () => this.callbacks.onAction('send'), {
      disabled: !hasSuggestion || !s.canSend,
      cls: 'send',
    });

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    bar.appendChild(spacer);

    add(s.liveActive ? '⏹ Stop listening' : '🎧 Live assist', 'Speech-to-text suggestions during calls', () =>
      this.callbacks.onLiveToggle(),
    );
    add('📊', 'Open dashboard', () => this.callbacks.onOpenDashboard());
    return bar;
  }

  private buildStatusBar(): HTMLElement {
    const s = this.state;
    const bar = document.createElement('div');
    bar.className = 'status';

    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.dataset.state = s.automationState;
    pill.textContent = s.paused && s.automationState !== 'stopped' ? 'PAUSED' : STATE_LABELS[s.automationState];
    bar.appendChild(pill);

    if (s.statusNote) {
      const note = document.createElement('span');
      note.textContent = s.statusNote;
      bar.appendChild(note);
    }

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    bar.appendChild(spacer);

    const meter = document.createElement('span');
    meter.className = 'meter';
    meter.textContent = `${s.requestsToday} req · ${s.tokensUsed.toLocaleString()} tok · $${s.estimatedCostUsd.toFixed(4)}`;
    meter.title = 'Requests today · tokens used · estimated AI cost';
    bar.appendChild(meter);

    return bar;
  }

  private buildLiveBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'livebar';
    bar.innerHTML = `<span class="rec"></span><span class="txt">${escapeHtml(
      this.state.liveTranscript || 'Listening…',
    )}</span>`;
    return bar;
  }

  private buildDebug(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'card';
    const label = document.createElement('div');
    label.className = 'card-label';
    label.textContent = 'Diagnostics';
    wrap.appendChild(label);

    const box = document.createElement('div');
    box.className = 'debug';
    const logs = this.state.logs.slice(-60);
    box.textContent = logs.length
      ? logs.map((l) => `${time(l.at)} [${l.scope}] ${l.message}`).join('\n')
      : 'No log entries yet.';
    wrap.appendChild(box);
    // Keep the newest line visible.
    queueMicrotask(() => {
      box.scrollTop = box.scrollHeight;
    });
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Interaction: drag + resize
  // -------------------------------------------------------------------------

  private makeDraggable(handle: HTMLElement | null): void {
    if (!handle) return;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      // Ignore drags that start on a button inside the header.
      if ((e.target as HTMLElement)?.closest('button')) return;
      const pos = this.state.position;
      this.dragging = { startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      e.preventDefault();
    };

    const onMove = (e: MouseEvent) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.dragging.startX;
      const dy = e.clientY - this.dragging.startY;
      const w = this.state.collapsed ? this.launcher.offsetWidth : this.state.size.w;
      const h = this.state.collapsed ? this.launcher.offsetHeight : this.root.offsetHeight;

      const x = clamp(this.dragging.originX + dx, 0, Math.max(0, window.innerWidth - w));
      const y = clamp(this.dragging.originY + dy, 0, Math.max(0, window.innerHeight - Math.min(h, 80)));

      this.state.position = { x, y };
      this.root.style.left = `${x}px`;
      this.root.style.top = `${y}px`;
      this.launcher.style.left = `${x}px`;
      this.launcher.style.top = `${y}px`;
    };

    const onUp = () => {
      if (this.dragging) this.persistPosition();
      this.dragging = null;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    };

    handle.addEventListener('mousedown', onDown);
  }

  private makeResizable(handle: HTMLElement, panel: HTMLElement): void {
    const onDown = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      this.resizing = { startX: e.clientX, startY: e.clientY, w: this.state.size.w, h: this.state.size.h };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    };

    const onMove = (e: MouseEvent) => {
      if (!this.resizing) return;
      const w = clamp(this.resizing.w + (e.clientX - this.resizing.startX), 300, 620);
      const h = clamp(this.resizing.h + (e.clientY - this.resizing.startY), 320, 900);
      this.state.size = { w, h };
      panel.style.width = `${w}px`;
      panel.style.maxHeight = `${h}px`;
    };

    const onUp = () => {
      this.resizing = null;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      window.dispatchEvent(new CustomEvent('rose:overlay-geometry', { detail: this.state.size }));
    };

    handle.addEventListener('mousedown', onDown);
  }

  private persistPosition(): void {
    window.dispatchEvent(
      new CustomEvent('rose:overlay-position', { detail: { position: this.state.position, size: this.state.size } }),
    );
  }
}

// ---------------------------------------------------------------------------

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function time(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

function statusLabel(status: ConversationStatus): string {
  return { active: 'Active', waiting: 'Waiting', new: 'New', inactive: 'Inactive' }[status];
}
