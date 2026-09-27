/**
 * Type surface for the model router (plain ESM JavaScript, no build step —
 * declared here for the TypeScript test suite).
 */

import type { ResolvedProvider } from './providers.mjs';

export interface AttemptEntry {
  provider: string;
  model: string;
  code: string;
  status: number | null;
  latencyMs: number;
  upstream: string | null;
}

export type RouteResult = {
  ok: boolean;
  provider?: string;
  model?: string;
  body?: string;
  latencyMs?: number;
  role?: string;
  tried: AttemptEntry[];
  error?: { code: string; message: string; lastStatus?: number | null };
};

export declare const MAX_PROVIDER_HOPS: number;
export declare const MAX_ATTEMPTS_PER_PROVIDER: number;

export declare function roleForTask(
  kind: string,
  meta?: { complex?: boolean; summary?: boolean },
): 'primary' | 'complex' | 'translation';
export declare function pickModelForRole(
  provider: Pick<ResolvedProvider, 'model' | 'fastModel'>,
  role: string,
  meta?: { complex?: boolean; summary?: boolean },
): string;
export declare function classifyFailure(input: { status?: number; error?: unknown }): {
  retryable: boolean;
  code: string;
};
export declare function orderChain<T>(chain: T[], now?: number): T[];
export declare function routeCompletion(input: {
  role: string;
  meta?: { complex?: boolean; summary?: boolean };
  attempt: (provider: ResolvedProvider, model: string) => Promise<{ body: string; model?: string }>;
  env?: NodeJS.ProcessEnv;
  attentionBudget?: number;
}): Promise<RouteResult>;
