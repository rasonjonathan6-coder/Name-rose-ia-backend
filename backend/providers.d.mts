/**
 * The backend is plain ESM JavaScript (no build step — it is not part of the
 * extension bundle), so the type surface is declared here for the test suite and
 * for anyone importing these modules from TypeScript.
 */

export interface ProviderDef {
  id: string;
  label: string;
  keyEnvs: string[];
  baseUrl: string | null;
  defaultModel: string;
  fastDefault: string;
}

export interface ResolvedProvider {
  id: string;
  label: string;
  configured: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  fastModel: string;
  keyEnvs: string[];
}

export interface ProviderSummary {
  id: string;
  label: string;
  configured: boolean;
  model: string;
  fastModel: string;
  requiredVars: string[];
}

export interface VerifyResult {
  id: string;
  available: boolean;
  reason?: string;
  status?: number;
  latencyMs?: number;
  model?: string;
  cached?: boolean;
}

export declare const PROVIDER_DEFS: ProviderDef[];
export declare const DEFAULT_ROLES: Record<string, string>;
export declare const DEFAULT_FALLBACK_ORDER: string[];

export declare function providerDef(id: string): ProviderDef | null;
export declare function baseUrlOf(def: ProviderDef, env?: NodeJS.ProcessEnv): string;
export declare function resolveProvider(id: string, env?: NodeJS.ProcessEnv): ResolvedProvider | null;
export declare function listProviders(env?: NodeJS.ProcessEnv): ProviderSummary[];
export declare function roleProviderId(role: string, env?: NodeJS.ProcessEnv): string;
export declare function chainFor(role: string, env?: NodeJS.ProcessEnv): ResolvedProvider[];
export declare function hasAnyProvider(env?: NodeJS.ProcessEnv): boolean;
export declare function verifyProvider(
  id: string,
  opts?: { env?: NodeJS.ProcessEnv; force?: boolean; timeoutMs?: number },
): Promise<VerifyResult>;
export declare function __resetVerifyCache(): void;
