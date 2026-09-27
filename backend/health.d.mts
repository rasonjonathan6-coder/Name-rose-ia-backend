/**
 * Type surface for the provider health module (plain ESM JavaScript, no build
 * step — declared here for the TypeScript test suite).
 */

export interface ProviderHealthMetrics {
  lastSuccess: number | null;
  lastFailure: number | null;
  latencyMs: number | null;
  timeoutCount: number;
  rateLimitCount: number;
  serverErrorCount: number;
  authError: boolean;
  consecutiveFailures: number;
  degradedUntil: number;
  state: 'HEALTHY' | 'DEGRADED' | 'AUTH_FAILED' | 'UNKNOWN';
}

export declare const DEGRADE_AFTER: number;
export declare const DEGRADED_TTL_MS: number;
export declare const AUTH_DEGRADED_TTL_MS: number;

export declare function recordSuccess(id: string, latencyMs?: number | null): void;
export declare function recordFailure(id: string, code: string): ProviderHealthMetrics;
export declare function isDegraded(id: string, now?: number): boolean;
export declare function statusOf(id: string): ProviderHealthMetrics;
export declare function snapshot(): Record<string, ProviderHealthMetrics>;
export declare function __resetHealth(): void;
