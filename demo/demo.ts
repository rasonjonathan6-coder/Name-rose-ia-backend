/**
 * Local demo harness.
 *
 * Renders a chat that looks structurally like a real platform chat: a scrollable
 * message list with left/right bubbles, a composer, and a partner header. ROSE's
 * DemoAdapter keys off `#demo-messages`, `#demo-input`, `#demo-send` and
 * `data-dir`, so this page exercises the real detection and insertion paths —
 * not a mocked one.
 *
 * The self-checks at the bottom verify that the page itself is well-formed for
 * ROSE (all hooks present, DOM mutations observable). They are a smoke test for
 * the harness, not a substitute for the unit test suite.
 */

interface DemoClient {
  id: string;
  name: string;
  avatar: string;
  language: string;
  seed: Array<{ dir: 'in' | 'out'; text: string }>;
}

const CLIENTS: DemoClient[] = [
  {
    id: 'sophie-4821',
    name: 'Sophie',
    avatar: 'S',
    language: 'en',
    seed: [
      { dir: 'in', text: 'Hi! How are you?' },
      { dir: 'out', text: 'Hey! I am good, thanks. How about you?' },
      { dir: 'in', text: 'Pretty good! Where are you from?' },
    ],
  },
  {
    id: 'elena-9013',
    name: 'Elena',
    avatar: 'E',
    language: 'ru',
    seed: [
      { dir: 'in', text: 'Привет! Как дела?' },
      { dir: 'out', text: 'Привет! Всё хорошо, спасибо 😊' },
      { dir: 'in', text: 'Откуда ты?' },
    ],
  },
];

const INCOMING_POOL = [
  'What do you do for a living?',
  'Do you have any hobbies?',
  'Have you travelled anywhere nice lately?',
  'What kind of music do you listen to?',
  'Are you married?',
  'I really like talking to you 😊',
  'What are you doing right now?',
  'Do you prefer the beach or the mountains?',
  'Tell me something interesting about yourself',
  'How is the weather where you are?',
  'Do you like cats or dogs?',
  'What is your favourite food?',
];

const PERSONAL_POOL = [
  'I am 29 and I live in Berlin, I work as a nurse.',
  'My name is Marco, I am from Italy and I love cooking.',
  'I have two dogs and I work in a bakery in Lyon.',
  'I am learning Spanish because I want to move to Madrid.',
];

let clientIndex = 0;
let msgCounter = 0;
let quiet = false;

const el = {
  messages: document.getElementById('demo-messages') as HTMLDivElement,
  input: document.getElementById('demo-input') as HTMLTextAreaElement,
  send: document.getElementById('demo-send') as HTMLButtonElement,
  name: document.getElementById('partner-name') as HTMLDivElement,
  avatar: document.getElementById('partner-avatar') as HTMLDivElement,
  status: document.getElementById('partner-status') as HTMLDivElement,
  langPill: document.getElementById('lang-pill') as HTMLDivElement,
  readout: document.getElementById('readout') as HTMLDivElement,
  testOut: document.getElementById('test-out') as HTMLDivElement,
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function currentClient(): DemoClient {
  return CLIENTS[clientIndex % CLIENTS.length]!;
}

function renderHeader(): void {
  const c = currentClient();
  el.name.textContent = c.name;
  el.avatar.textContent = c.avatar;
  el.langPill.textContent = c.language.toUpperCase();
  // The demo exposes the partner id the way a real site would, so the adapter's
  // identity resolution is exercised rather than name-hashed.
  el.name.parentElement!.parentElement!.setAttribute('data-partner-id', c.id);
}

function addMessage(dir: 'in' | 'out' | 'system', text: string, author?: string): HTMLElement {
  const div = document.createElement('div');
  div.className = `msg${dir === 'system' ? ' system' : ''}`;
  if (dir !== 'system') div.dataset.dir = dir;
  div.dataset.messageId = `demo-msg-${++msgCounter}`;
  div.dataset.timestamp = String(Date.now());

  if (dir !== 'system') {
    const a = document.createElement('span');
    a.className = 'author';
    a.textContent = author ?? (dir === 'in' ? currentClient().name : 'Me');
    div.appendChild(a);
  }

  div.appendChild(document.createTextNode(text));

  const t = document.createElement('span');
  t.className = 'time';
  t.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.appendChild(t);

  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
  updateReadout();
  return div;
}

function clearChat(): void {
  el.messages.innerHTML = '';
  msgCounter = 0;
  updateReadout();
}

function loadClient(index: number): void {
  clientIndex = index;
  renderHeader();
  clearChat();
  const c = currentClient();
  for (const m of c.seed) addMessage(m.dir, m.text);
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function simulateIncoming(text?: string): void {
  if (quiet) {
    addMessage('system', '— conversation is quiet —');
    quiet = false;
  }
  const body = text ?? INCOMING_POOL[Math.floor(Math.random() * INCOMING_POOL.length)]!;
  addMessage('in', body);
}

function sendFromComposer(): void {
  const text = el.input.value.trim();
  if (!text) return;
  addMessage('out', text);
  el.input.value = '';
  el.input.style.height = 'auto';
}

// ---------------------------------------------------------------------------
// Self-checks
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

async function runSelfChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  add('Message container present', !!document.getElementById('demo-messages'), '#demo-messages');
  add('Composer present', !!document.getElementById('demo-input'), '#demo-input');
  add('Send button present', !!document.getElementById('demo-send'), '#demo-send');

  const msgs = document.querySelectorAll('#demo-messages .msg');
  add('Messages rendered', msgs.length > 0, `${msgs.length} message node(s)`);

  const incoming = document.querySelectorAll('#demo-messages .msg[data-dir="in"]');
  const outgoing = document.querySelectorAll('#demo-messages .msg[data-dir="out"]');
  add('Direction attributes present', incoming.length > 0 && outgoing.length > 0, `${incoming.length} in / ${outgoing.length} out`);

  // Incoming bubbles must be left of outgoing bubbles (the generic adapter's
  // geometric fallback relies on this when no direction attribute exists).
  if (incoming.length && outgoing.length) {
    const inRect = incoming[0]!.getBoundingClientRect();
    const outRect = outgoing[0]!.getBoundingClientRect();
    add('Incoming left of outgoing', inRect.left < outRect.left, `${Math.round(inRect.left)}px < ${Math.round(outRect.left)}px`);
  }

  add('Partner id exposed', !!document.querySelector('[data-partner-id]'), document.querySelector('[data-partner-id]')?.getAttribute('data-partner-id') ?? 'missing');
  add('Message ids unique', new Set([...msgs].map((m) => (m as HTMLElement).dataset.messageId)).size === msgs.length, `${msgs.length} ids`);

  // The composer must not be detected as a message (the generic adapter filters
  // anything containing the input; this checks the DOM makes that possible).
  const composerInsideList = !!document.querySelector('#demo-messages #demo-input');
  add('Composer outside message list', !composerInsideList, composerInsideList ? 'input is nested inside #demo-messages' : 'ok');

  // MutationObserver actually fires on this container. Delivery is a microtask,
  // so the probe must be waited on — disconnecting immediately would cancel the
  // pending record and report a false negative.
  let fired = false;
  const obs = new MutationObserver(() => {
    fired = true;
  });
  obs.observe(el.messages, { childList: true, subtree: true });
  const probe = document.createElement('div');
  probe.style.display = 'none';
  el.messages.appendChild(probe);
  await Promise.resolve();
  obs.disconnect();
  probe.remove();
  add('DOM mutations observable', fired, 'MutationObserver fired on probe insert');

  // ROSE overlay presence (only when the extension is loaded).
  const roseHost = !!document.getElementById('rose-shadow-host');
  add('ROSE overlay detected', roseHost, roseHost ? 'extension is active on this page' : 'load the unpacked extension and reload');

  return checks;
}

async function paintChecks(): Promise<void> {
  const checks = await runSelfChecks();
  const passed = checks.filter((c) => c.pass).length;
  el.testOut.innerHTML = checks
    .map((c) => `<div class="${c.pass ? 'ok' : 'fail'}">${c.pass ? '✓' : '✕'} ${escapeHtml(c.name)} — ${escapeHtml(c.detail)}</div>`)
    .join('');
  const summary = document.createElement('div');
  summary.style.marginTop = '8px';
  summary.style.fontWeight = '700';
  summary.textContent = `${passed}/${checks.length} checks passed`;
  el.testOut.appendChild(summary);
  // Expose for automated E2E reads.
  (window as unknown as { __roseDemoChecks?: Check[] }).__roseDemoChecks = checks;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateReadout(): void {
  const msgs = document.querySelectorAll('#demo-messages .msg');
  const incoming = document.querySelectorAll('#demo-messages .msg[data-dir="in"]').length;
  const outgoing = document.querySelectorAll('#demo-messages .msg[data-dir="out"]').length;
  el.readout.textContent = [
    `client      ${currentClient().name} (${currentClient().id})`,
    `messages    ${msgs.length}`,
    `incoming    ${incoming}`,
    `outgoing    ${outgoing}`,
    `input value ${el.input.value ? `"${el.input.value.slice(0, 28)}"` : '(empty)'}`,
    `quiet       ${quiet}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.getElementById('sim-incoming')!.addEventListener('click', () => simulateIncoming());
document.getElementById('sim-greeting')!.addEventListener('click', () => simulateIncoming('Hey! 😊'));
document.getElementById('sim-question')!.addEventListener('click', () => simulateIncoming('Where are you from?'));
document.getElementById('sim-personal')!.addEventListener('click', () => simulateIncoming(PERSONAL_POOL[Math.floor(Math.random() * PERSONAL_POOL.length)]!));
document.getElementById('sim-french')!.addEventListener('click', () => simulateIncoming('Salut ! Comment vas-tu aujourd\'hui ?'));
document.getElementById('sim-repeat')!.addEventListener('click', () => {
  const last = [...document.querySelectorAll('#demo-messages .msg[data-dir="in"]')].pop() as HTMLElement | undefined;
  simulateIncoming(last?.textContent?.replace(/\d{2}:\d{2}$/, '').trim() ?? 'Hello again!');
});
document.getElementById('sim-inactive')!.addEventListener('click', () => {
  quiet = true;
  addMessage('system', '— chat went quiet, no new messages —');
  updateReadout();
});
document.getElementById('switch-client')!.addEventListener('click', () => loadClient(clientIndex + 1));
document.getElementById('clear-chat')!.addEventListener('click', () => clearChat());
document.getElementById('run-tests')!.addEventListener('click', () => void paintChecks());

el.send.addEventListener('click', sendFromComposer);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendFromComposer();
  }
});
el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(120, el.input.scrollHeight)}px`;
  updateReadout();
});

// Initial state
renderHeader();
loadClient(0);
void paintChecks();
updateReadout();

// Expose a programmatic API so E2E tests can drive the harness deterministically.
Object.defineProperty(window, 'ROSE_DEMO', {
  value: {
    addIncoming: (text: string) => simulateIncoming(text),
    addOutgoing: (text: string) => addMessage('out', text),
    clear: () => clearChat(),
    switchClient: () => loadClient(clientIndex + 1),
    setInput: (text: string) => {
      el.input.value = text;
      el.input.dispatchEvent(new Event('input', { bubbles: true }));
      updateReadout();
    },
    getInput: () => el.input.value,
    messages: () => [...document.querySelectorAll('#demo-messages .msg')].map((m) => ({
      dir: (m as HTMLElement).dataset.dir ?? 'system',
      text: m.textContent ?? '',
    })),
    checks: () => runSelfChecks(),
  },
  configurable: true,
});
