import type { Server } from 'node:http';

/**
 * The backend is plain ESM JavaScript (no build step — it is not part of the
 * extension bundle), so the type surface is declared here for the test suite.
 */
export function createRoseBackend(): Server;
