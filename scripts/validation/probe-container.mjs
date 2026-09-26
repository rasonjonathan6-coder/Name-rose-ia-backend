/** One-off probe: what container does the generic adapter choose? */
import { Browser, sleep } from '../cdp.mjs';
import { fixtureUrl, configureRose, setApiKey, waitForOverlay, clearAllRoseData } from './helpers.mjs';

const file = process.argv[2];
const browser = await Browser.launch({ extensionDir: '/workspace/project/dist' });
await browser.waitForServiceWorker(30_000);
await clearAllRoseData();
await configureRose(browser, {
  ai: { activeProvider: 'openai', providers: [{ id: 'openai', baseUrl: 'http://127.0.0.1:8788/v1', model: 'mock-model' }] },
  automation: { mode: 'manual', globalEnabled: true },
  debug: { enabled: true, verbose: true, showOverlay: true },
});
await setApiKey(browser, 'openai', 'k');
const page = await browser.newPage(fixtureUrl(file));
await sleep(3000);
await waitForOverlay(browser, page, 20_000);

const out = await browser.evalIsolated(
  page,
  `(() => {
     const c = window.ROSE_IA.controller;
     const el = c.adapter.getMessageContainer(document);
     const desc = (n) => n ? n.tagName + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).split(/\\s+/).join('.') : '') : null;
     const msgs = c.adapter.getMessages(document);
     return {
       container: desc(el),
       parent: el ? desc(el.parentElement) : null,
       children: el ? Array.from(el.children).map(desc) : [],
       messages: msgs.map((m) => m.text),
       messagesInsideContainer: msgs.map((m) => (el ? el.contains(document.querySelector('[data-message-id="' + (m.nativeId ?? '') + '"]')) : null)),
       candidates: Array.from(document.querySelectorAll('div,section,ul,ol,main,aside,table'))
         .map((n) => ({ d: desc(n), kids: n.children.length, txt: (n.textContent || '').trim().slice(0, 40) }))
         .filter((x) => x.kids > 0),
     };
   })()`,
);
console.log(JSON.stringify(out, null, 2));
await browser.close();
