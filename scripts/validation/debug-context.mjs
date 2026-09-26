import { Browser, sleep } from '../cdp.mjs';

const browser = await Browser.launch({ extensionDir: '/workspace/project/dist' });
const sw = await browser.waitForServiceWorker(20_000);
console.log('SW target:', sw.url, sw.targetId);

const contexts = [];
const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
browser.cdp.on('Runtime.executionContextCreated', (p, sid) => {
  if (sid === sessionId) contexts.push({ id: p.context.id, name: p.context.name, origin: p.context.origin, auxData: p.context.auxData });
});

await browser.cdp.send('Runtime.enable', {}, sessionId);
await sleep(800);
console.log('contexts:', JSON.stringify(contexts, null, 2));

for (const c of contexts) {
  try {
    const r = await browser.cdp.send('Runtime.evaluate', { expression: 'typeof chrome', contextId: c.id, returnByValue: true }, sessionId);
    console.log(`ctx ${c.id} (${c.name}): typeof chrome =`, r.result?.value, r.exceptionDetails?.text ?? '');
  } catch (e) {
    console.log(`ctx ${c.id}: error`, e.message);
  }
}

await browser.close();
