/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Zero dependencies: Node 24 ships a global `WebSocket`, so ROSE's validation
 * harness can drive a real Chromium without pulling in Playwright/Puppeteer.
 * That matters here because the point of these tests is to exercise the real
 * extension in a real browser, not a re-implementation of one.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
].filter(Boolean);

export function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('No Chromium/Chrome/Edge binary found. Set CHROME_PATH.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Picks an execution context out of the ones a target has announced.
 *
 * Chrome reports `auxData.isDefault` and `auxData.type` per context: the page's
 * own world is `default`, the extension content script's is `isolated`. Prefer
 * the newest match, and fall back to the newest context at all so a target that
 * reports no auxData still works.
 */
function pickContext(contexts, kind) {
  if (!contexts.length) return undefined;
  const matches = contexts.filter((c) =>
    kind === 'isolated' ? c.auxData?.type === 'isolated' : c.auxData?.isDefault === true,
  );
  const pool = matches.length ? matches : kind === 'default' ? contexts : [];
  return pool.length ? pool[pool.length - 1].id : undefined;
}

/** A CDP connection to one browser, with per-target session support. */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ''}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const key = `${msg.sessionId ?? ''}:${msg.method}`;
        for (const fn of this.listeners.get(key) ?? []) fn(msg.params, msg.sessionId);
        for (const fn of this.listeners.get(`*:${msg.method}`) ?? []) fn(msg.params, msg.sessionId);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed to open')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60_000);
    });
  }

  on(method, fn) {
    const key = `*:${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
    return () => this.listeners.get(key).delete(fn);
  }

  once(method, timeout = 20_000) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
        off();
        clearTimeout(t);
        resolve(params);
      });
      const t = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** A running browser with the extension loaded. */
export class Browser {
  constructor(child, cdp, userDataDir, port) {
    this.child = child;
    this.cdp = cdp;
    this.userDataDir = userDataDir;
    this.port = port;
    this.sessions = new Map();
  }

  /**
   * Launches Chromium with ROSE loaded as an unpacked extension and exposes
   * remote debugging on a private port.
   */
  static async launch({ extensionDir, headless = true, extraArgs = [], windowSize = '1280,900' } = {}) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-chrome-'));
    const binary = findChrome();
    const args = [
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--window-size=${windowSize}`,
      '--disable-features=DialMediaRouteProvider,AcceptCHFrame,MediaRouter,OptimizationHints',
      '--enable-features=NetworkService',
    ];
    if (headless) args.push('--headless=new');
    if (extensionDir) {
      args.push(`--load-extension=${extensionDir}`);
      args.push(`--disable-extensions-except=${extensionDir}`);
    }
    args.push(...extraArgs);

    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.stdout.on('data', () => {});

    // Chromium writes the actual port to DevToolsActivePort once it is listening.
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 300; i++) {
      if (fs.existsSync(portFile)) {
        const content = fs.readFileSync(portFile, 'utf8').split('\n');
        if (content[0]) {
          port = Number(content[0]);
          break;
        }
      }
      if (child.exitCode !== null) {
        throw new Error(`Chromium exited early (code ${child.exitCode}):\n${stderr}`);
      }
      await sleep(100);
    }
    if (!port) {
      child.kill('SIGKILL');
      throw new Error(`Chromium did not open a debugging port.\n${stderr}`);
    }

    // The browser-level websocket URL comes from /json/version.
    let browserWs = null;
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        const json = await res.json();
        if (json.webSocketDebuggerUrl) {
          browserWs = json.webSocketDebuggerUrl;
          break;
        }
      } catch {
        /* not ready */
      }
      await sleep(100);
    }
    if (!browserWs) {
      child.kill('SIGKILL');
      throw new Error('Could not reach the CDP /json/version endpoint.');
    }

    const cdp = await Cdp.connect(browserWs);
    return new Browser(child, cdp, userDataDir, port);
  }

  /** All targets the browser currently knows about. */
  async targets() {
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    return targetInfos;
  }

  /** Waits until a target matching `predicate` exists, then returns it. */
  async waitForTarget(predicate, { timeout = 30_000, label = 'target' } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = (await this.targets()).find(predicate);
      if (found) return found;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${label}. Targets: ${JSON.stringify(await this.targets())}`);
  }

  /** Waits for ROSE's MV3 service worker to register. */
  waitForServiceWorker(timeout = 30_000) {
    return this.waitForTarget(
      (t) => t.type === 'service_worker' && /background\.js/.test(t.url),
      { timeout, label: 'ROSE service worker (background.js)' },
    );
  }

  /** Attaches to a target and returns a session-wrapped sender. */
  async attach(targetInfo) {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', {
      targetId: targetInfo.targetId,
      flatten: true,
    });
    const send = (method, params) => this.cdp.send(method, params, sessionId);

    // Service worker targets have no "default" execution context, so
    // Runtime.evaluate without an explicit contextId resolves to nothing and
    // throws "chrome is not defined". Track contexts for the lifetime of the
    // session: page navigation destroys and recreates them, so the newest one
    // must be used rather than the one seen at attach time.
    const contexts = [];
    const off = this.cdp.on('Runtime.executionContextCreated', (params, sid) => {
      if (sid === sessionId) contexts.push(params.context);
    });
    await send('Runtime.enable').catch(() => {});
    await send('Page.enable').catch(() => {});
    for (let i = 0; i < 40 && contexts.length === 0; i++) await sleep(50);

    const session = {
      sessionId,
      targetInfo,
      send,
      contexts,
      /**
       * The newest *default* context.
       *
       * A page target announces two worlds: the page's own main world and the
       * extension's isolated world (where the content script runs). Both are
       * valid execution contexts, and the isolated world is usually announced
       * last — so "newest context" silently evaluates harness expressions inside
       * the content script, where the fixture's `window.__fixture` does not
       * exist. Filtering on `isDefault` keeps page assertions in the page.
       */
      get contextId() {
        return pickContext(contexts, 'default');
      },
      /** The content script's isolated world, where `window.ROSE_IA` lives. */
      get isolatedContextId() {
        return pickContext(contexts, 'isolated');
      },
      detach: off,
    };
    return session;
  }

  /**
   * Opens a page. Content scripts are injected by the browser from the
   * manifest's match patterns — nothing is injected manually here, which is the
   * whole point: this verifies the real registration path.
   */
  async newPage(url) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const info = await this.waitForTarget((t) => t.targetId === targetId, { label: 'new page' });
    const session = await this.attach(info);
    if (url) {
      await session.send('Page.navigate', { url });
      await this.waitForLoad(session);
    }
    return session;
  }

  /** Resolves when the page finishes loading. */
  waitForLoad(session, timeout = 30_000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        off();
        resolve();
      }, timeout);
      const off = this.cdp.on('Page.loadEventFired', () => {
        off();
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Evaluates an expression in a page and returns its JSON value. */
  async eval(session, expression, { awaitPromise = true, _attempt = 0, world = 'default' } = {}) {
    const contextId = world === 'isolated' ? session.isolatedContextId : session.contextId;
    let res;
    try {
      res = await session.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
        ...(contextId !== undefined ? { contextId } : {}),
      });
    } catch (err) {
      // A navigation can destroy the context between picking its id and using
      // it. Wait for the replacement context and try again.
      if (_attempt < 3 && /Cannot find context/i.test(err.message)) {
        await sleep(150);
        return this.eval(session, expression, { awaitPromise, _attempt: _attempt + 1, world });
      }
      throw err;
    }
    // An already-running service worker may answer the first evaluate from an
    // empty context, where `chrome` is undefined. Retry now that a real context
    // has been announced rather than reporting a spurious failure.
    if (
      _attempt < 3 &&
      res.exceptionDetails &&
      /chrome is not defined/.test(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? '')
    ) {
      await sleep(250);
      return this.eval(session, expression, { awaitPromise, _attempt: _attempt + 1, world });
    }
    if (res.exceptionDetails) {
      const e = res.exceptionDetails;
      throw new Error(`Page exception: ${e.exception?.description ?? e.text}`);
    }
    return res.result?.value;
  }

  /** Evaluates inside the extension content script's isolated world. */
  async evalIsolated(session, expression) {
    return this.eval(session, expression, { world: 'isolated' });
  }

  /** Waits for a page-side expression to become truthy. */
  async waitFor(session, expression, { timeout = 20_000, label = expression, world = 'default' } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(session, expression, { world });
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
  }

  /** Waits for an expression to become truthy inside the isolated world. */
  async waitForIsolated(session, expression, { timeout = 20_000, label = expression } = {}) {
    return this.waitFor(session, expression, { timeout, label, world: 'isolated' });
  }

  async close() {
    try {
      this.cdp.close();
    } catch {
      /* ignore */
    }
    this.child.kill('SIGKILL');
    await sleep(200);
    try {
      fs.rmSync(this.userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export { sleep };
