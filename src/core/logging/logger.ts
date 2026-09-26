/**
 * Developer logging.
 *
 * Logs are kept in a bounded ring buffer and never contain raw client messages
 * unless verbose mode is explicitly enabled — message content is redacted by
 * default so the diagnostic overlay is safe to share.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const MAX_ENTRIES = 400;
const buffer: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();

let enabled = false;
let verbose = false;

export function configureLogging(opts: { enabled?: boolean; verbose?: boolean }) {
  if (opts.enabled !== undefined) enabled = opts.enabled;
  if (opts.verbose !== undefined) verbose = opts.verbose;
}

export function isLoggingEnabled() {
  return enabled;
}

/** Redacts anything that looks like a secret or personal message body. */
function redact(data: unknown): unknown {
  if (data === undefined || data === null) return data;
  if (typeof data === 'string') return verbose ? data : redactText(data);
  if (Array.isArray(data)) return data.map(redact);
  if (typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (/key|token|secret|password|authorization|cookie/i.test(k)) out[k] = '***';
      else out[k] = redact(v);
    }
    return out;
  }
  return data;
}

function redactText(text: string): string {
  if (text.length <= 24) return `${text.length} chars`;
  return `${text.slice(0, 8)}… (${text.length} chars)`;
}

function push(level: LogLevel, scope: string, message: string, data?: unknown) {
  const entry: LogEntry = { at: Date.now(), level, scope, message, data: redact(data) };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  for (const l of listeners) {
    try {
      l(entry);
    } catch {
      /* a broken listener must never break logging */
    }
  }
  if (!enabled) return;
  const tag = `%c[ROSE]%c ${scope}`;
  const styles = ['background:#7c3aed;color:#fff;padding:1px 5px;border-radius:4px', 'color:#ec4899'];
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(tag, ...styles, message, entry.data ?? '');
}

export const log = {
  debug: (scope: string, message: string, data?: unknown) => push('debug', scope, message, data),
  info: (scope: string, message: string, data?: unknown) => push('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => push('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown) => push('error', scope, message, data),
};

export function getLogEntries(): LogEntry[] {
  return [...buffer];
}

export function clearLogs() {
  buffer.length = 0;
}

export function onLog(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
