/**
 * Runs every browser validation phase against one freshly started server.
 *
 * The phases share a mock AI provider on 127.0.0.1:8788 and a control channel
 * for inspecting the requests ROSE made. Previously each phase assumed the
 * server was already running and `verify:browser` skipped phase 3 entirely, so
 * a full green run depended on someone having started the server by hand — and
 * a stale server silently served the old code.
 *
 * Build first (`npm run build`); this script only serves `dist/`.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer, startChatFrameServer, AI_PORT, CHAT_FRAME_PORT } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const HOST = '127.0.0.1:8788';

const PHASES = [
  'phase1-install.mjs',
  'phase2-generic.mjs',
  'phase3-demo.mjs',
  'phase6-iframe.mjs',
  'check-popup-flow.mjs',
];

async function serverIsUp() {
  try {
    await fetch(`http://${HOST}/__control/requests`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

/** Refuses to run against someone else's server: it may be serving stale code. */
async function assertPortFree() {
  if (await serverIsUp()) {
    throw new Error(
      `something is already listening on ${HOST}. Stop it first — a stale server serves the previous build and makes results meaningless.`,
    );
  }
}

function runPhase(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: 'inherit', cwd: root });
    child.on('close', (code) => resolve({ file, code: code ?? 1 }));
  });
}

let failed = 0;
let server = null;
let chatServer = null;
try {
  // Check for a stale server *before* binding, otherwise the check would always
  // see our own freshly started server and the guard would be meaningless.
  await assertPortFree();

  server = await startServer(AI_PORT);
  // Fixture G needs a second origin so its iframe is genuinely cross-origin.
  chatServer = await startChatFrameServer(CHAT_FRAME_PORT);

  const deadline = Date.now() + 10_000;
  while (!(await serverIsUp())) {
    if (Date.now() > deadline) throw new Error(`validation server did not start on ${HOST}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  for (const phase of PHASES) {
    const { code } = await runPhase(phase);
    if (code !== 0) failed++;
  }
} catch (err) {
  console.error(`\n[verify:browser] ${err.message}`);
  failed++;
} finally {
  server?.close();
  chatServer?.close();
}

if (failed) {
  console.error(`\n[verify:browser] ${failed} phase(s) failed`);
  process.exit(1);
}
console.log('\n[verify:browser] all phases passed');
