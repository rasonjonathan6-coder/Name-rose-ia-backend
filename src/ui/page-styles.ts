/**
 * Shared stylesheet for the extension's own pages (popup, options, side panel,
 * dashboard). These run in extension context, so — unlike the content-script
 * overlay — they can use a normal document stylesheet.
 */
export const PAGE_CSS = `
:root {
  /* Brand ramp */
  --violet: #7c3aed;
  --violet-soft: #a78bfa;
  --rose: #ec4899;
  --cyan: #22d3ee;
  --accent: var(--violet);
  --accent-ink: #ffffff;

  /* Surfaces — dark first */
  --bg: #0b0a12;
  --bg-2: #121019;
  --bg-3: #171522;
  --surface: rgba(255, 255, 255, 0.042);
  --surface-2: rgba(255, 255, 255, 0.082);
  --surface-3: rgba(255, 255, 255, 0.12);
  --outline: rgba(255, 255, 255, 0.10);
  --outline-strong: rgba(255, 255, 255, 0.18);

  --text: #f5f3ff;
  --text-dim: rgba(245, 243, 255, 0.64);
  --text-faint: rgba(245, 243, 255, 0.40);

  --danger: #fb7185;
  --success: #34d399;
  --warning: #fbbf24;

  /* Radii, elevation, motion */
  --radius: 16px;
  --radius-sm: 11px;
  --radius-xs: 8px;
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.30);
  --shadow-2: 0 8px 24px rgba(0, 0, 0, 0.38);
  --shadow-3: 0 20px 48px rgba(0, 0, 0, 0.50);
  --shadow: var(--shadow-2);
  --ring: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
  --ease: cubic-bezier(.2, .8, .3, 1);
  --dur: .16s;

  --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}

:root[data-theme='light'] {
  --bg: #f6f4fc;
  --bg-2: #ffffff;
  --bg-3: #fbfaff;
  --surface: rgba(28, 18, 56, 0.035);
  --surface-2: rgba(28, 18, 56, 0.07);
  --surface-3: rgba(28, 18, 56, 0.11);
  --outline: rgba(28, 18, 56, 0.12);
  --outline-strong: rgba(28, 18, 56, 0.22);
  --text: #1a1330;
  --text-dim: rgba(26, 19, 48, 0.66);
  --text-faint: rgba(26, 19, 48, 0.44);
  --shadow-1: 0 1px 2px rgba(60, 30, 120, 0.08);
  --shadow-2: 0 8px 24px rgba(60, 30, 120, 0.12);
  --shadow-3: 0 20px 48px rgba(60, 30, 120, 0.18);
  --shadow: var(--shadow-2);
}

:root[data-accent='rose'] { --accent: var(--rose); }
:root[data-accent='cyan'] { --accent: var(--cyan); --accent-ink: #05202a; }

* { box-sizing: border-box; margin: 0; padding: 0; }

html { color-scheme: dark; }
:root[data-theme='light'] html, :root[data-theme='light'] { color-scheme: light; }

body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
}

::selection { background: color-mix(in srgb, var(--accent) 40%, transparent); }

a { color: var(--cyan); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

h1 { font-size: 19px; font-weight: 750; letter-spacing: -.3px; }
h2 { font-size: 14.5px; font-weight: 700; letter-spacing: -.15px; }
h3 {
  font-size: 11px; font-weight: 750; text-transform: uppercase;
  letter-spacing: .9px; color: var(--text-dim);
}

/* ---------- Layout ---------- */
.shell { display: flex; min-height: 100vh; }
.sidebar {
  width: 224px; flex: 0 0 auto;
  background: var(--bg-2);
  border-right: 1px solid var(--outline);
  padding: 16px 12px;
  display: flex; flex-direction: column; gap: 3px;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 18px; }
.brand .mark {
  width: 34px; height: 34px; border-radius: 12px;
  background: linear-gradient(135deg, var(--violet), var(--rose));
  display: grid; place-items: center; font-weight: 800; color: #fff; font-size: 15px;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--violet) 45%, transparent);
}
.brand .name { font-weight: 800; font-size: 15px; letter-spacing: .2px; }
.brand .ver { font-size: 10px; color: var(--text-faint); }
.nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border-radius: var(--radius-sm);
  color: var(--text-dim); cursor: pointer; font-weight: 600; font-size: 12.5px;
  border: 1px solid transparent; background: none; font-family: inherit;
  text-align: left; width: 100%;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.nav-item:hover { background: var(--surface); color: var(--text); }
.nav-item[aria-current='true'] {
  background: var(--surface-2); color: var(--text);
  border-color: var(--outline-strong);
  box-shadow: inset 2px 0 0 var(--accent);
}
.nav-item .ico { width: 16px; text-align: center; }

.main { flex: 1; padding: 24px 28px 64px; max-width: 960px; }
.panel-section { display: none; }
.panel-section.active { display: block; animation: fade .22s var(--ease); }
@keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* ---------- Cards ---------- */
.card {
  background: var(--surface);
  border: 1px solid var(--outline);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-bottom: 14px;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.card:hover { border-color: var(--outline-strong); }
.card > h2 { margin-bottom: 3px; }
.card .hint { font-size: 11.5px; color: var(--text-dim); margin-bottom: 14px; }
.card-label { font-size: 11px; font-weight: 750; text-transform: uppercase; letter-spacing: .9px; color: var(--text-dim); }

.row { display: flex; gap: 10px; align-items: center; }
.row.between { justify-content: space-between; }
.row.wrap { flex-wrap: wrap; }
.grid { display: grid; gap: 12px; }
.grid.two { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.grid.three { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.spacer { flex: 1; }

/* ---------- Form ---------- */
label.field { display: block; margin-bottom: 12px; }
label.field .lbl { display: block; font-size: 11.5px; font-weight: 650; color: var(--text-dim); margin-bottom: 6px; }
label.field .desc { display: block; font-size: 10.5px; color: var(--text-faint); margin-top: 5px; }

input[type='text'], input[type='password'], input[type='number'], select, textarea {
  width: 100%; font-family: inherit; font-size: 12.5px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--outline); border-radius: var(--radius-sm);
  padding: 9px 11px; outline: none;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease), background var(--dur) var(--ease);
}
input[type='text']:hover, input[type='password']:hover, input[type='number']:hover, select:hover, textarea:hover {
  border-color: var(--outline-strong);
}
input:focus, select:focus, textarea:focus {
  border-color: var(--accent);
  box-shadow: var(--ring);
}
textarea { resize: vertical; min-height: 70px; line-height: 1.55; }
select { cursor: pointer; appearance: none; padding-right: 30px;
  background-image: linear-gradient(45deg, transparent 50%, var(--text-dim) 50%), linear-gradient(135deg, var(--text-dim) 50%, transparent 50%);
  background-position: calc(100% - 15px) 50%, calc(100% - 10px) 50%;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
}

.switch { display: flex; align-items: center; gap: 11px; cursor: pointer; margin-bottom: 12px; }
.switch input {
  appearance: none; width: 40px; height: 22px; border-radius: 999px;
  background: var(--surface-3); position: relative; cursor: pointer;
  transition: background var(--dur) var(--ease); flex: 0 0 auto;
  border: 1px solid var(--outline);
}
.switch input::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff;
  box-shadow: var(--shadow-1);
  transition: transform var(--dur) var(--ease);
}
.switch input:checked { background: var(--accent); border-color: transparent; }
.switch input:checked::after { transform: translateX(18px); }
.switch input:focus-visible { box-shadow: var(--ring); }
.switch .txt { font-size: 12.5px; }
.switch .txt small { display: block; color: var(--text-faint); font-size: 10.5px; }

input[type='range'] { width: 100%; accent-color: var(--accent); cursor: pointer; }

/* ---------- Buttons ---------- */
button.btn {
  appearance: none; cursor: pointer; font-family: inherit;
  font-size: 12px; font-weight: 650; letter-spacing: .1px;
  padding: 9px 15px; border-radius: var(--radius-sm);
  border: 1px solid var(--outline); background: var(--surface-2); color: var(--text);
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
              transform .1s var(--ease), box-shadow var(--dur) var(--ease), filter var(--dur) var(--ease);
  white-space: nowrap;
}
button.btn:hover:not(:disabled) { background: var(--surface-3); border-color: var(--outline-strong); }
button.btn:active:not(:disabled) { transform: translateY(1px); }
button.btn:disabled { opacity: .42; cursor: not-allowed; }
button.btn.primary {
  background: var(--accent); border-color: transparent; color: var(--accent-ink);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 40%, transparent);
}
button.btn.primary:hover:not(:disabled) {
  filter: brightness(1.1);
  box-shadow: 0 6px 20px color-mix(in srgb, var(--accent) 52%, transparent);
}
button.btn.danger {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  color: var(--danger);
}
button.btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 26%, transparent);
  border-color: var(--danger);
}
button.btn.ghost { background: transparent; border-color: transparent; color: var(--text-dim); }
button.btn.ghost:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
button.btn.sm { padding: 6px 11px; font-size: 11px; border-radius: var(--radius-xs); }

/* Segmented control — used for the mode selector */
.segmented {
  display: flex; gap: 3px; padding: 3px;
  background: var(--surface); border: 1px solid var(--outline);
  border-radius: var(--radius-sm);
}
.segmented button {
  flex: 1; appearance: none; cursor: pointer; font-family: inherit;
  font-size: 11.5px; font-weight: 650; padding: 7px 10px;
  border: 1px solid transparent; border-radius: var(--radius-xs);
  background: transparent; color: var(--text-dim);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.segmented button:hover { color: var(--text); background: var(--surface-2); }
.segmented button[aria-pressed='true'] {
  background: var(--accent); color: var(--accent-ink);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--accent) 40%, transparent);
}

/* ---------- Stats ---------- */
.stat {
  background: var(--surface); border: 1px solid var(--outline);
  border-radius: var(--radius); padding: 15px 16px;
  transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.stat:hover { border-color: var(--outline-strong); transform: translateY(-1px); }
.stat .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .8px; color: var(--text-dim); font-weight: 700; }
.stat .v {
  font-size: 25px; font-weight: 800; margin-top: 5px;
  font-variant-numeric: tabular-nums; letter-spacing: -.6px;
}
.stat .sub { font-size: 10.5px; color: var(--text-faint); margin-top: 3px; }
.stat.accent .v {
  background: linear-gradient(120deg, var(--violet), var(--rose));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}

/* ---------- Tables / lists ---------- */
.list { display: flex; flex-direction: column; gap: 7px; }
.item {
  display: flex; align-items: center; gap: 12px;
  background: var(--surface); border: 1px solid var(--outline);
  border-radius: var(--radius-sm); padding: 11px 13px;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.item:hover { border-color: var(--outline-strong); background: var(--surface-2); }
.item .avatar {
  width: 36px; height: 36px; border-radius: 50%; flex: 0 0 auto;
  background: linear-gradient(135deg, var(--violet), var(--rose));
  display: grid; place-items: center; font-weight: 700; color: #fff; font-size: 13px;
  overflow: hidden; box-shadow: var(--shadow-1);
}
.item .avatar img { width: 100%; height: 100%; object-fit: cover; }
.item .meta { flex: 1; min-width: 0; }
.item .meta .n { font-weight: 700; font-size: 12.5px; display: flex; align-items: center; gap: 6px; }
.item .meta .m { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item .meta .t { font-size: 10px; color: var(--text-faint); }

.badge {
  font-size: 9.5px; font-weight: 800; letter-spacing: .5px; text-transform: uppercase;
  padding: 3px 8px; border-radius: 999px; background: var(--surface-3); color: var(--text-dim);
  white-space: nowrap;
}
.badge.active { background: color-mix(in srgb, var(--success) 20%, transparent); color: var(--success); }
.badge.waiting { background: color-mix(in srgb, var(--warning) 20%, transparent); color: var(--warning); }
.badge.new { background: color-mix(in srgb, var(--cyan) 20%, transparent); color: var(--cyan); }
.badge.inactive { background: var(--surface-3); color: var(--text-faint); }
.badge.error { background: color-mix(in srgb, var(--danger) 22%, transparent); color: var(--danger); }

table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 9px 11px; border-bottom: 1px solid var(--outline); }
th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .7px; color: var(--text-dim); font-weight: 700; }
tbody tr { transition: background var(--dur) var(--ease); }
tbody tr:hover { background: var(--surface); }

/* ---------- Feedback ---------- */
.notice {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 11px 13px; border-radius: var(--radius-sm);
  font-size: 11.5px; line-height: 1.55;
  border: 1px solid var(--outline); background: var(--surface);
  margin-bottom: 12px;
}
.notice.warn {
  border-color: color-mix(in srgb, var(--warning) 42%, transparent);
  background: color-mix(in srgb, var(--warning) 9%, transparent);
}
.notice.error {
  border-color: color-mix(in srgb, var(--danger) 42%, transparent);
  background: color-mix(in srgb, var(--danger) 9%, transparent);
}
.notice.success {
  border-color: color-mix(in srgb, var(--success) 42%, transparent);
  background: color-mix(in srgb, var(--success) 9%, transparent);
}
.notice .ico { flex: 0 0 auto; line-height: 1.4; }

.empty {
  text-align: center; padding: 34px 20px; color: var(--text-faint); font-size: 12px;
}

.mono { font-family: var(--font-mono); font-size: 11px; }

/* ---------- Toast ---------- */
.toast {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  background: var(--bg-3); border: 1px solid var(--outline-strong);
  border-radius: var(--radius-sm); padding: 10px 16px; font-size: 12px;
  box-shadow: var(--shadow-3); z-index: 999;
  animation: toast-in .22s var(--ease);
  max-width: 460px; text-align: center;
}
@keyframes toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
.toast.error { border-color: color-mix(in srgb, var(--danger) 55%, transparent); }
.toast.success { border-color: color-mix(in srgb, var(--success) 55%, transparent); }

/* ---------- Spinner ---------- */
.spinner {
  width: 14px; height: 14px; border-radius: 50%; display: inline-block;
  border: 2px solid var(--surface-3); border-top-color: var(--accent);
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- Popup sizing ---------- */
body.popup { width: 344px; }
body.sidepanel { width: 100%; }

/* ---------- Chart ---------- */
.chart { display: flex; align-items: flex-end; gap: 5px; height: 120px; padding-top: 8px; }
.chart .bar {
  flex: 1; border-radius: 6px 6px 3px 3px;
  background: linear-gradient(180deg, var(--violet), var(--rose));
  min-height: 3px; position: relative;
  transition: filter var(--dur) var(--ease);
}
.chart .bar:hover { filter: brightness(1.25); }
.chart .bar .tip {
  position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
  background: var(--bg-3); border: 1px solid var(--outline-strong); border-radius: 7px;
  padding: 4px 8px; font-size: 10px; white-space: nowrap; opacity: 0; pointer-events: none;
  transition: opacity var(--dur) var(--ease); box-shadow: var(--shadow-2);
}
.chart .bar:hover .tip { opacity: 1; }
.chart-labels { display: flex; gap: 5px; margin-top: 6px; }
.chart-labels span { flex: 1; text-align: center; font-size: 9.5px; color: var(--text-faint); }

/* ---------- Scrollbars ---------- */
* { scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--surface-3); border-radius: 999px;
  border: 3px solid transparent; background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover { background: var(--outline-strong); background-clip: content-box; }

/* ---------- Motion preferences ---------- */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
}

@media (max-width: 720px) {
  .sidebar { width: 64px; padding: 12px 6px; }
  .brand .name, .brand .ver, .nav-item span:not(.ico) { display: none; }
  .main { padding: 18px 15px 54px; }
}
`;
