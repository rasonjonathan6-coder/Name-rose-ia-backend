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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const HOST = '127.0.0.1:8788';

const PHASES = ['phase1-install.mjs', 'phase2-generic.mjs', 'phase3-demo.mjs', 'check-popup-flow.mjs'];

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

const server = spawn(process.execPath, [join(here, 'server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const shutdown = () => {
  if (!server.killed) server.kill('SIGTERM');
};
process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

let failed = 0;
try {
  await assertPortFree();

  const deadline = Date.now() + 10_000;
  while (!(await serverIsUp())) {
    if (Date.now() > deadline) throw new Error(`validation server did not start.\n${serverLog}`);
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
  shutdown();
}

if (failed) {
  console.error(`\n[verify:browser] ${failed} phase(s) failed`);
  process.exit(1);
}
console.log('\n[verify:browser] all phases passed');
