import { Browser } from '../cdp.mjs';

const extensionDir = process.argv[2] ?? '/workspace/project/dist';
const browser = await Browser.launch({ extensionDir });
console.log('launched on port', browser.port);

const targets = await browser.targets();
console.log('targets:');
for (const t of targets) console.log('  ', t.type, t.url);

try {
  const sw = await browser.waitForServiceWorker(20_000);
  console.log('SERVICE WORKER OK:', sw.url);
} catch (e) {
  console.log('SW ERROR:', e.message);
}

await browser.close();
