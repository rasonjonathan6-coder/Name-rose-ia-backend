import { Browser, sleep } from '../cdp.mjs';

const browser = await Browser.launch({ extensionDir: '/workspace/project/dist' });
const sw = await browser.waitForServiceWorker(20_000);
const extId = sw.url.split('/')[2];

const session = await browser.newPage('about:blank');

// Install the trap before any page script runs, so a rejection thrown during
// bootstrap is captured instead of being lost.
await session.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    globalThis.__roseErrors = [];
    addEventListener('unhandledrejection', (e) => {
      globalThis.__roseErrors.push('REJECTION: ' + (e.reason && (e.reason.stack || e.reason.message) || String(e.reason)));
    });
    addEventListener('error', (e) => {
      globalThis.__roseErrors.push('ERROR: ' + (e.error && e.error.stack || e.message));
    });
  `,
});

await session.send('Page.navigate', { url: `chrome-extension://${extId}/options/options.html` });
await sleep(3500);

const errors = await browser.eval(session, 'globalThis.__roseErrors');
console.log('captured errors:', JSON.stringify(errors, null, 2));

await browser.close();
