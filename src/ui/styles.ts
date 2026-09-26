/**
 * ROSE IA overlay styles.
 *
 * Injected into a shadow root so the host page's CSS can never restyle the
 * assistant, and ROSE's CSS can never leak into the page. Material 3 surface
 * tokens with glassmorphism, dark-first.
 */
export const OVERLAY_CSS = `
:host {
  all: initial;
  --rose-violet: #7c3aed;
  --rose-rose: #ec4899;
  --rose-cyan: #22d3ee;
  --rose-accent: var(--rose-violet);
  --rose-bg: rgba(18, 16, 30, 0.82);
  --rose-bg-solid: #15131f;
  --rose-surface: rgba(255, 255, 255, 0.06);
  --rose-surface-2: rgba(255, 255, 255, 0.10);
  --rose-outline: rgba(255, 255, 255, 0.14);
  --rose-text: #f4f2ff;
  --rose-text-dim: rgba(244, 242, 255, 0.62);
  --rose-danger: #f43f5e;
  --rose-success: #34d399;
  --rose-warning: #fbbf24;
  --rose-radius: 18px;
  --rose-radius-sm: 12px;
  --rose-shadow: 0 18px 48px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35);
  --rose-blur: blur(22px) saturate(1.5);
  --rose-font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --rose-scale: 1;
  --rose-opacity: 0.97;
  font-family: var(--rose-font);
  font-size: 13px;
  line-height: 1.45;
  color: var(--rose-text);
  -webkit-font-smoothing: antialiased;
}

:host([data-theme='light']) {
  --rose-bg: rgba(255, 255, 255, 0.88);
  --rose-bg-solid: #ffffff;
  --rose-surface: rgba(20, 10, 40, 0.05);
  --rose-surface-2: rgba(20, 10, 40, 0.09);
  --rose-outline: rgba(20, 10, 40, 0.14);
  --rose-text: #1b1430;
  --rose-text-dim: rgba(27, 20, 48, 0.62);
  --rose-shadow: 0 18px 48px rgba(60, 30, 120, 0.20), 0 2px 8px rgba(60, 30, 120, 0.10);
}

:host([data-accent='rose']) { --rose-accent: var(--rose-rose); }
:host([data-accent='cyan']) { --rose-accent: var(--rose-cyan); }

* { box-sizing: border-box; margin: 0; padding: 0; }

.root {
  position: fixed;
  z-index: 2147483600;
  top: 0; left: 0;
  transform-origin: top left;
  opacity: var(--rose-opacity);
  transition: opacity .18s ease;
}
.root.hidden { display: none; }

/* ---------- Launcher (collapsed pill) ---------- */
.launcher {
  position: fixed;
  z-index: 2147483600;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px 9px 10px;
  border-radius: 999px;
  background: var(--rose-bg);
  backdrop-filter: var(--rose-blur);
  -webkit-backdrop-filter: var(--rose-blur);
  border: 1px solid var(--rose-outline);
  box-shadow: var(--rose-shadow);
  cursor: grab;
  user-select: none;
  transition: transform .16s cubic-bezier(.2,.8,.3,1), box-shadow .16s ease;
}
.launcher:hover { transform: translateY(-2px); box-shadow: 0 22px 56px rgba(0,0,0,.6); }
.launcher:active { cursor: grabbing; }
.launcher .mark {
  width: 26px; height: 26px; border-radius: 9px; flex: 0 0 auto;
  background: linear-gradient(135deg, var(--rose-violet), var(--rose-rose));
  display: grid; place-items: center;
  font-weight: 700; font-size: 12px; color: #fff;
  box-shadow: 0 4px 12px rgba(124,58,237,.5);
}
.launcher .label { font-weight: 600; letter-spacing: .2px; }
.launcher .dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--rose-text-dim);
  box-shadow: 0 0 0 0 rgba(52,211,153,.6);
}
.launcher[data-state='ready'] .dot { background: var(--rose-cyan); animation: pulse 1.8s infinite; }
.launcher[data-state='generating'] .dot { background: var(--rose-warning); animation: pulse 1s infinite; }
.launcher[data-state='sending'] .dot { background: var(--rose-violet); animation: pulse 1s infinite; }
.launcher[data-state='error'] .dot { background: var(--rose-danger); }
.launcher[data-state='stopped'] .dot { background: var(--rose-danger); }
.launcher[data-state='paused'] .dot { background: var(--rose-warning); }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
  70% { box-shadow: 0 0 0 7px transparent; opacity: .75; }
  100% { box-shadow: 0 0 0 0 transparent; opacity: 1; }
}

/* ---------- Panel ---------- */
.panel {
  width: 372px;
  max-width: min(372px, calc(100vw - 24px));
  max-height: min(74vh, 720px);
  display: flex;
  flex-direction: column;
  border-radius: var(--rose-radius);
  background: var(--rose-bg);
  backdrop-filter: var(--rose-blur);
  -webkit-backdrop-filter: var(--rose-blur);
  border: 1px solid var(--rose-outline);
  box-shadow: var(--rose-shadow);
  overflow: hidden;
  animation: rise .2s cubic-bezier(.2,.8,.3,1);
}
@keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }

.panel.dragging { animation: none; }

/* ---------- Header ---------- */
.header {
  display: flex; align-items: center; gap: 9px;
  padding: 11px 12px;
  background: linear-gradient(120deg, rgba(124,58,237,.28), rgba(236,72,153,.18));
  border-bottom: 1px solid var(--rose-outline);
  cursor: grab;
}
.header:active { cursor: grabbing; }
.header .mark {
  width: 28px; height: 28px; border-radius: 10px; flex: 0 0 auto;
  background: linear-gradient(135deg, var(--rose-violet), var(--rose-rose));
  display: grid; place-items: center; font-weight: 700; font-size: 12px; color: #fff;
}
.header .titles { flex: 1; min-width: 0; }
.header .title { font-weight: 700; font-size: 13px; letter-spacing: .2px; }
.header .sub {
  font-size: 11px; color: var(--rose-text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.icon-btn {
  appearance: none; border: 1px solid transparent; background: transparent;
  color: var(--rose-text-dim); cursor: pointer;
  width: 26px; height: 26px; border-radius: 8px;
  display: grid; place-items: center; font-size: 13px; line-height: 1;
  transition: background .14s ease, color .14s ease;
}
.icon-btn:hover { background: var(--rose-surface-2); color: var(--rose-text); }
.icon-btn.danger:hover { background: rgba(244,63,94,.22); color: #fff; }

/* ---------- Mode bar ---------- */
.modes {
  display: flex; gap: 4px; padding: 9px 10px;
  border-bottom: 1px solid var(--rose-outline);
}
.mode {
  flex: 1; appearance: none; cursor: pointer;
  border: 1px solid var(--rose-outline);
  background: var(--rose-surface);
  color: var(--rose-text-dim);
  border-radius: 999px; padding: 6px 8px;
  font-size: 11px; font-weight: 600; font-family: inherit;
  transition: all .15s ease;
}
.mode:hover { color: var(--rose-text); background: var(--rose-surface-2); }
.mode[aria-pressed='true'] {
  background: var(--rose-accent); border-color: transparent; color: #fff;
  box-shadow: 0 4px 14px rgba(124,58,237,.42);
}
.mode[data-mode='auto'][aria-pressed='true'] {
  background: linear-gradient(135deg, var(--rose-rose), var(--rose-violet));
}

/* ---------- Stop bar ---------- */
.stopbar {
  display: none; align-items: center; gap: 8px;
  padding: 8px 10px;
  background: rgba(244,63,94,.14);
  border-bottom: 1px solid rgba(244,63,94,.35);
}
.stopbar.visible { display: flex; }
.stopbar .msg { flex: 1; font-size: 11px; color: #ffd9e0; }
.stop-btn {
  appearance: none; cursor: pointer; border: none;
  background: var(--rose-danger); color: #fff;
  padding: 7px 14px; border-radius: 999px;
  font-weight: 800; font-size: 11px; letter-spacing: .5px; font-family: inherit;
  box-shadow: 0 4px 16px rgba(244,63,94,.5);
  animation: breathe 2.4s ease-in-out infinite;
}
@keyframes breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.045); } }

/* ---------- Body ---------- */
.body { padding: 10px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 9px; }
.body::-webkit-scrollbar { width: 8px; }
.body::-webkit-scrollbar-thumb { background: var(--rose-surface-2); border-radius: 4px; }

.card {
  background: var(--rose-surface);
  border: 1px solid var(--rose-outline);
  border-radius: var(--rose-radius-sm);
  padding: 9px 10px;
}
.card-label {
  font-size: 10px; font-weight: 700; letter-spacing: .7px; text-transform: uppercase;
  color: var(--rose-text-dim); margin-bottom: 6px; display: flex; align-items: center; gap: 6px;
}
.card-label .badge {
  font-size: 9px; padding: 1px 6px; border-radius: 999px;
  background: var(--rose-surface-2); letter-spacing: .3px; text-transform: none;
}

.incoming { font-size: 12.5px; color: var(--rose-text); white-space: pre-wrap; word-break: break-word; }
.incoming.empty { color: var(--rose-text-dim); font-style: italic; }
.translation {
  margin-top: 6px; padding-top: 6px; font-size: 12px; color: var(--rose-cyan);
  border-top: 1px dashed var(--rose-outline);
}

/* ---------- Suggestions ---------- */
.suggestions { display: flex; flex-direction: column; gap: 7px; }
.suggestion {
  text-align: left; appearance: none; cursor: pointer; font-family: inherit;
  background: var(--rose-surface);
  border: 1px solid var(--rose-outline);
  border-radius: var(--rose-radius-sm);
  padding: 9px 10px; color: var(--rose-text);
  transition: all .15s ease; position: relative;
}
.suggestion:hover { background: var(--rose-surface-2); border-color: var(--rose-accent); transform: translateX(2px); }
.suggestion[aria-selected='true'] {
  border-color: var(--rose-accent);
  background: color-mix(in srgb, var(--rose-accent) 18%, transparent);
  box-shadow: 0 0 0 1px var(--rose-accent) inset;
}
.suggestion .kind {
  font-size: 9.5px; font-weight: 800; letter-spacing: .8px; text-transform: uppercase;
  color: var(--rose-accent); display: block; margin-bottom: 3px;
}
.suggestion .text { font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.suggestion .warn {
  margin-top: 5px; font-size: 10.5px; color: var(--rose-warning);
  display: flex; gap: 4px; align-items: flex-start;
}
.suggestion.blocked { border-color: rgba(244,63,94,.5); opacity: .75; }
.suggestion.blocked .kind { color: var(--rose-danger); }

/* ---------- Actions ---------- */
.actions { display: flex; flex-wrap: wrap; gap: 5px; }
.action {
  appearance: none; cursor: pointer; font-family: inherit;
  background: var(--rose-surface); border: 1px solid var(--rose-outline);
  color: var(--rose-text-dim); border-radius: 8px;
  padding: 5px 9px; font-size: 11px; font-weight: 600;
  transition: all .14s ease;
}
.action:hover:not(:disabled) { background: var(--rose-surface-2); color: var(--rose-text); border-color: var(--rose-accent); }
.action:disabled { opacity: .4; cursor: not-allowed; }
.action.primary {
  background: var(--rose-accent); border-color: transparent; color: #fff;
  box-shadow: 0 3px 12px rgba(124,58,237,.4);
}
.action.primary:hover:not(:disabled) { filter: brightness(1.1); }
.action.send { background: linear-gradient(135deg, var(--rose-cyan), #3b82f6); border-color: transparent; color: #04121a; }
.action.blocked { opacity: .5; }

/* ---------- Status ---------- */
.status {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 10px; font-size: 11px; color: var(--rose-text-dim);
  border-top: 1px solid var(--rose-outline);
  background: rgba(0,0,0,.14);
}
.status .pill {
  padding: 2px 8px; border-radius: 999px; font-weight: 700; font-size: 10px;
  background: var(--rose-surface-2); color: var(--rose-text);
  white-space: nowrap;
}
.status .pill[data-state='error'], .status .pill[data-state='stopped'] { background: rgba(244,63,94,.25); color: #ffd9e0; }
.status .pill[data-state='paused'], .status .pill[data-state='waiting-delay'] { background: rgba(251,191,36,.22); color: #ffe9b0; }
.status .pill[data-state='ready'] { background: rgba(34,211,238,.22); color: #c8f6ff; }
.status .pill[data-state='sending'], .status .pill[data-state='generating'] { background: rgba(124,58,237,.3); color: #e9dcff; }
.status .spacer { flex: 1; }
.status .meter { font-variant-numeric: tabular-nums; }

/* ---------- Debug ---------- */
.debug {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; line-height: 1.5; color: var(--rose-text-dim);
  max-height: 132px; overflow-y: auto;
  background: rgba(0,0,0,.28); border-radius: 8px; padding: 7px 8px;
}
.debug .lvl { font-weight: 700; }
.debug .lvl-warn { color: var(--rose-warning); }
.debug .lvl-error { color: var(--rose-danger); }
.debug .lvl-info { color: var(--rose-cyan); }

/* ---------- Live call ---------- */
.livebar {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 10px; font-size: 11px;
  background: rgba(34,211,238,.12);
  border-top: 1px solid rgba(34,211,238,.3);
}
.livebar .rec { width: 8px; height: 8px; border-radius: 50%; background: var(--rose-danger); animation: pulse 1.4s infinite; }
.livebar .txt { flex: 1; color: var(--rose-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- Resize ---------- */
.resizer {
  position: absolute; right: 2px; bottom: 2px; width: 16px; height: 16px;
  cursor: nwse-resize; opacity: .5;
}
.resizer::after {
  content: ''; position: absolute; right: 3px; bottom: 3px;
  width: 8px; height: 8px;
  border-right: 2px solid var(--rose-text-dim);
  border-bottom: 2px solid var(--rose-text-dim);
  border-radius: 0 0 3px 0;
}

/* ---------- Spinner ---------- */
.spinner {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid var(--rose-surface-2); border-top-color: var(--rose-accent);
  animation: spin .7s linear infinite; display: inline-block; vertical-align: -2px;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- Toast ---------- */
.toast {
  position: fixed; z-index: 2147483601;
  bottom: 20px; left: 50%; transform: translateX(-50%);
  background: var(--rose-bg-solid); color: var(--rose-text);
  border: 1px solid var(--rose-outline); border-radius: 12px;
  padding: 9px 15px; font-size: 12px;
  box-shadow: var(--rose-shadow); backdrop-filter: var(--rose-blur);
  animation: rise .2s ease; max-width: 420px; text-align: center;
}
.toast[data-kind='error'] { border-color: rgba(244,63,94,.6); }
.toast[data-kind='success'] { border-color: rgba(52,211,153,.6); }

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
`;
