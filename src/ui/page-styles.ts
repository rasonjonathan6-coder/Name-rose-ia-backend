/**
 * Shared stylesheet for the extension's own pages (popup, options, side panel,
 * dashboard). These run in extension context, so — unlike the content-script
 * overlay — they can use a normal document stylesheet.
 */
export const PAGE_CSS = `
:root {
  --violet: #7c3aed;
  --rose: #ec4899;
  --cyan: #22d3ee;
  --accent: var(--violet);
  --bg: #0f0d17;
  --bg-2: #15131f;
  --surface: rgba(255, 255, 255, 0.045);
  --surface-2: rgba(255, 255, 255, 0.085);
  --surface-3: rgba(255, 255, 255, 0.12);
  --outline: rgba(255, 255, 255, 0.13);
  --text: #f4f2ff;
  --text-dim: rgba(244, 242, 255, 0.6);
  --text-faint: rgba(244, 242, 255, 0.38);
  --danger: #f43f5e;
  --success: #34d399;
  --warning: #fbbf24;
  --radius: 14px;
  --radius-sm: 10px;
  --shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
}
:root[data-theme='light'] {
  --bg: #f7f5ff;
  --bg-2: #ffffff;
  --surface: rgba(20, 10, 40, 0.04);
  --surface-2: rgba(20, 10, 40, 0.075);
  --surface-3: rgba(20, 10, 40, 0.11);
  --outline: rgba(20, 10, 40, 0.13);
  --text: #1b1430;
  --text-dim: rgba(27, 20, 48, 0.62);
  --text-faint: rgba(27, 20, 48, 0.42);
  --shadow: 0 14px 40px rgba(60, 30, 120, 0.16);
}
:root[data-accent='rose'] { --accent: var(--rose); }
:root[data-accent='cyan'] { --accent: var(--cyan); }

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--cyan); text-decoration: none; }
a:hover { text-decoration: underline; }

h1 { font-size: 20px; font-weight: 700; letter-spacing: -.2px; }
h2 { font-size: 15px; font-weight: 700; }
h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: var(--text-dim); }

/* ---------- Layout ---------- */
.shell { display: flex; min-height: 100vh; }
.sidebar {
  width: 216px; flex: 0 0 auto;
  background: var(--bg-2);
  border-right: 1px solid var(--outline);
  padding: 16px 12px;
  display: flex; flex-direction: column; gap: 3px;
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 16px; }
.brand .mark {
  width: 32px; height: 32px; border-radius: 11px;
  background: linear-gradient(135deg, var(--violet), var(--rose));
  display: grid; place-items: center; font-weight: 800; color: #fff; font-size: 14px;
  box-shadow: 0 6px 18px rgba(124, 58, 237, .45);
}
.brand .name { font-weight: 800; font-size: 15px; letter-spacing: .2px; }
.brand .ver { font-size: 10px; color: var(--text-faint); }
.nav-item {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 11px; border-radius: var(--radius-sm);
  color: var(--text-dim); cursor: pointer; font-weight: 600; font-size: 12.5px;
  border: 1px solid transparent; background: none; font-family: inherit; text-align: left; width: 100%;
  transition: all .14s ease;
}
.nav-item:hover { background: var(--surface); color: var(--text); }
.nav-item[aria-current='true'] {
  background: var(--surface-2); color: var(--text); border-color: var(--outline);
}
.nav-item .ico { width: 16px; text-align: center; }

.main { flex: 1; padding: 22px 26px 60px; max-width: 940px; }
.panel-section { display: none; }
.panel-section.active { display: block; animation: fade .2s ease; }
@keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* ---------- Cards ---------- */
.card {
  background: var(--surface);
  border: 1px solid var(--outline);
  border-radius: var(--radius);
  padding: 15px 16px;
  margin-bottom: 14px;
}
.card > h2 { margin-bottom: 3px; }
.card .hint { font-size: 11.5px; color: var(--text-dim); margin-bottom: 13px; }

.row { display: flex; gap: 10px; align-items: center; }
.row.between { justify-content: space-between; }
.row.wrap { flex-wrap: wrap; }
.grid { display: grid; gap: 12px; }
.grid.two { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.grid.three { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.spacer { flex: 1; }

/* ---------- Form ---------- */
label.field { display: block; margin-bottom: 11px; }
label.field .lbl { display: block; font-size: 11.5px; font-weight: 600; color: var(--text-dim); margin-bottom: 5px; }
label.field .desc { display: block; font-size: 10.5px; color: var(--text-faint); margin-top: 4px; }

input[type='text'], input[type='password'], input[type='number'], select, textarea {
  width: 100%; font-family: inherit; font-size: 12.5px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--outline); border-radius: var(--radius-sm);
  padding: 8px 10px; outline: none;
  transition: border-color .14s ease, box-shadow .14s ease;
}
input:focus, select:focus, textarea:focus {
  border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}
textarea { resize: vertical; min-height: 66px; }
select { cursor: pointer; }

.switch { display: flex; align-items: center; gap: 10px; cursor: pointer; margin-bottom: 11px; }
.switch input { appearance: none; width: 38px; height: 21px; border-radius: 999px; background: var(--surface-3); position: relative; cursor: pointer; transition: background .18s ease; flex: 0 0 auto; }
.switch input::after {
  content: ''; position: absolute; top: 2.5px; left: 2.5px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; transition: transform .18s cubic-bezier(.2,.8,.3,1);
}
.switch input:checked { background: var(--accent); }
.switch input:checked::after { transform: translateX(17px); }
.switch .txt { font-size: 12.5px; }
.switch .txt small { display: block; color: var(--text-faint); font-size: 10.5px; }

input[type='range'] { width: 100%; accent-color: var(--accent); }

/* ---------- Buttons ---------- */
button.btn {
  appearance: none; cursor: pointer; font-family: inherit;
  font-size: 12px; font-weight: 700;
  padding: 8px 14px; border-radius: var(--radius-sm);
  border: 1px solid var(--outline); background: var(--surface-2); color: var(--text);
  transition: all .14s ease;
}
button.btn:hover:not(:disabled) { background: var(--surface-3); border-color: var(--accent); }
button.btn:disabled { opacity: .45; cursor: not-allowed; }
button.btn.primary {
  background: var(--accent); border-color: transparent; color: #fff;
  box-shadow: 0 5px 16px color-mix(in srgb, var(--accent) 45%, transparent);
}
button.btn.primary:hover:not(:disabled) { filter: brightness(1.12); }
button.btn.danger { background: var(--danger); border-color: transparent; color: #fff; }
button.btn.ghost { background: transparent; }
button.btn.sm { padding: 5px 10px; font-size: 11px; }

/* ---------- Stats ---------- */
.stat {
  background: var(--surface); border: 1px solid var(--outline);
  border-radius: var(--radius); padding: 14px 15px;
}
.stat .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .7px; color: var(--text-dim); font-weight: 700; }
.stat .v { font-size: 24px; font-weight: 800; margin-top: 4px; font-variant-numeric: tabular-nums; letter-spacing: -.5px; }
.stat .sub { font-size: 10.5px; color: var(--text-faint); margin-top: 2px; }
.stat.accent .v { background: linear-gradient(120deg, var(--violet), var(--rose)); -webkit-background-clip: text; background-clip: text; color: transparent; }

/* ---------- Tables / lists ---------- */
.list { display: flex; flex-direction: column; gap: 7px; }
.item {
  display: flex; align-items: center; gap: 11px;
  background: var(--surface); border: 1px solid var(--outline);
  border-radius: var(--radius-sm); padding: 10px 12px;
}
.item .avatar {
  width: 34px; height: 34px; border-radius: 50%; flex: 0 0 auto;
  background: linear-gradient(135deg, var(--violet), var(--rose));
  display: grid; place-items: center; font-weight: 700; color: #fff; font-size: 13px;
  overflow: hidden;
}
.item .avatar img { width: 100%; height: 100%; object-fit: cover; }
.item .meta { flex: 1; min-width: 0; }
.item .meta .n { font-weight: 700; font-size: 12.5px; display: flex; align-items: center; gap: 6px; }
.item .meta .m { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item .meta .t { font-size: 10px; color: var(--text-faint); }

.badge {
  font-size: 9.5px; font-weight: 800; letter-spacing: .5px; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; background: var(--surface-3); color: var(--text-dim);
  white-space: nowrap;
}
.badge.active { background: color-mix(in srgb, var(--success) 22%, transparent); color: #b9f5dd; }
.badge.waiting { background: color-mix(in srgb, var(--warning) 22%, transparent); color: #ffe9b0; }
.badge.new { background: color-mix(in srgb, var(--cyan) 22%, transparent); color: #c8f6ff; }
.badge.inactive { background: var(--surface-3); color: var(--text-faint); }
.badge.error { background: color-mix(in srgb, var(--danger) 24%, transparent); color: #ffd9e0; }

table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--outline); }
th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .6px; color: var(--text-dim); font-weight: 700; }
tbody tr:hover { background: var(--surface); }

/* ---------- Feedback ---------- */
.notice {
  display: flex; gap: 9px; align-items: flex-start;
  padding: 10px 12px; border-radius: var(--radius-sm);
  font-size: 11.5px; border: 1px solid var(--outline); background: var(--surface);
  margin-bottom: 12px;
}
.notice.warn { border-color: color-mix(in srgb, var(--warning) 45%, transparent); background: color-mix(in srgb, var(--warning) 10%, transparent); }
.notice.error { border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.notice.success { border-color: color-mix(in srgb, var(--success) 45%, transparent); background: color-mix(in srgb, var(--success) 10%, transparent); }
.notice .ico { flex: 0 0 auto; }

.empty { text-align: center; padding: 30px 20px; color: var(--text-faint); font-size: 12px; }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

.toast {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  background: var(--bg-2); border: 1px solid var(--outline);
  border-radius: var(--radius-sm); padding: 9px 15px; font-size: 12px;
  box-shadow: var(--shadow); z-index: 999; animation: fade .18s ease;
  max-width: 460px; text-align: center;
}
.toast.error { border-color: color-mix(in srgb, var(--danger) 55%, transparent); }
.toast.success { border-color: color-mix(in srgb, var(--success) 55%, transparent); }

/* ---------- Popup sizing ---------- */
body.popup { width: 340px; }
body.sidepanel { width: 100%; }

/* ---------- Chart ---------- */
.chart { display: flex; align-items: flex-end; gap: 5px; height: 118px; padding-top: 8px; }
.chart .bar { flex: 1; border-radius: 5px 5px 2px 2px; background: linear-gradient(180deg, var(--violet), var(--rose)); min-height: 3px; position: relative; transition: filter .14s ease; }
.chart .bar:hover { filter: brightness(1.25); }
.chart .bar .tip {
  position: absolute; bottom: calc(100% + 5px); left: 50%; transform: translateX(-50%);
  background: var(--bg-2); border: 1px solid var(--outline); border-radius: 6px;
  padding: 3px 7px; font-size: 10px; white-space: nowrap; opacity: 0; pointer-events: none;
  transition: opacity .14s ease;
}
.chart .bar:hover .tip { opacity: 1; }
.chart-labels { display: flex; gap: 5px; margin-top: 5px; }
.chart-labels span { flex: 1; text-align: center; font-size: 9.5px; color: var(--text-faint); }

@media (max-width: 720px) {
  .sidebar { width: 62px; padding: 12px 6px; }
  .brand .name, .brand .ver, .nav-item span:not(.ico) { display: none; }
  .main { padding: 16px 14px 50px; }
}
`;
