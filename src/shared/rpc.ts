import type {
  ClientMemory,
  ConversationRef,
  DetectionReport,
  Envelope,
  FrameIdentity,
  FrameRoleName,
  GenerationResult,
  MessageResponse,
  OverlayIntent,
  PlatformId,
  ResponseLength,
  ResponseStyle,
  StatsEvent,
  Suggestion,
} from './types';
import { MSG } from './types';

/**
 * Typed RPC over chrome.runtime messaging.
 *
 * Why the AI work lives behind this boundary: in Manifest V3 a content script's
 * `fetch` is subject to the *host page's* CORS policy, so calling an AI endpoint
 * from the content script fails on most sites. The service worker has the
 * extension's host permissions and is not CORS-constrained, so every outbound
 * API call is routed there. This also gives us a single writer for memory and
 * stats, which removes cross-tab races.
 */

export interface SuggestionsRequest {
  conversation: ConversationRef;
  incoming: string;
  style: ResponseStyle;
  customStyle: string;
  length: ResponseLength;
  targetLanguage: string;
  count: number;
  force?: boolean;
}

export interface SuggestionsResponse {
  suggestions: Suggestion[];
  result: Omit<GenerationResult, 'suggestions'>;
  memory: MemorySummary;
}

export interface MemorySummary {
  id: string;
  displayName: string;
  language: string | null;
  summary: string;
  messageCount: number;
  topics: string[];
  factCount: number;
  recentMessages: Array<{ role: 'client' | 'assistant'; text: string; at: number }>;
}

export interface TranslateRequest {
  text: string;
  targetLanguage: string;
  tone: string;
}

export interface RecordOutgoingRequest {
  conversation: ConversationRef;
  text: string;
  language: string | null;
  sent: boolean;
}

export interface ReportDetectionRequest {
  report: DetectionReport;
  /** Which frame produced this report (top frame vs chat frame). */
  role?: FrameRoleName;
  /** Frame identity, so the background can attribute the report. */
  frame?: FrameIdentity;
}

export interface RpcMap {
  [MSG.PING]: { req: void; res: { ok: true; version: string } };
  [MSG.DETECTION_REPORT]: {
    req: ReportDetectionRequest;
    res: { accepted: boolean; render: boolean; mirrorFor: number | null; dataOwner: boolean };
  };
  [MSG.MESSAGE_DETECTED]: {
    req: { conversation: ConversationRef; text: string; language: string | null };
    res: { memory: MemorySummary; shouldCallAI: boolean; reason: string };
  };
  [MSG.REQUEST_SUGGESTIONS]: { req: SuggestionsRequest; res: SuggestionsResponse };
  [MSG.RECORD_OUTGOING]: { req: RecordOutgoingRequest; res: { memory: MemorySummary } };
  [MSG.REQUEST_TRANSLATION]: { req: TranslateRequest; res: { text: string | null } };
  [MSG.STATS_EVENT]: { req: StatsEvent; res: { ok: true } };
  [MSG.CONVERSATION_ACTIVATED]: { req: { conversation: ConversationRef }; res: { memory: MemorySummary | null } };
  [MSG.ACTIVATE_SITE]: { req: { host: string }; res: { host: string; origin: string } };
  [MSG.FRAME_GONE]: { req: Record<string, never>; res: { accepted: boolean } };
  [MSG.OVERLAY_SYNC]: {
    req: { state: Record<string, unknown>; mounted: boolean };
    res: { delivered: boolean };
  };
  [MSG.OVERLAY_INTENT]: { req: { intent: OverlayIntent }; res: { delivered: boolean } };
  [MSG.OVERLAY_MIRROR_READY]: { req: Record<string, never>; res: { mirrored: boolean } };
}

/**
 * Sends a request and unwraps the response. Never throws for a business-level
 * failure: callers get `{ ok: false, error }` so a UI can show a message instead
 * of an unhandled rejection.
 */
export async function rpc<K extends keyof RpcMap>(
  type: K,
  payload: RpcMap[K]['req'],
): Promise<MessageResponse<RpcMap[K]['res']>> {
  const g = globalThis as unknown as { chrome?: typeof chrome };
  if (!g.chrome?.runtime?.sendMessage) {
    return { ok: false, error: 'Extension runtime unavailable (running outside the extension?).' };
  }

  const envelope: Envelope<RpcMap[K]['req']> = { type, payload, requestId: makeId() };

  try {
    const res = (await g.chrome.runtime.sendMessage(envelope)) as MessageResponse<RpcMap[K]['res']> | undefined;
    if (!res) {
      // Happens when the service worker was torn down mid-flight and did not reply.
      return { ok: false, error: 'No response from the ROSE background service. Try again.' };
    }
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Extension context invalidated/i.test(message)) {
      return { ok: false, error: 'The extension was reloaded. Refresh the page to reconnect ROSE.' };
    }
    return { ok: false, error: message };
  }
}

export function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Converts a full memory record into the compact form sent to the UI. */
export function toMemorySummary(memory: ClientMemory): MemorySummary {
  return {
    id: memory.id,
    displayName: memory.displayName,
    language: memory.language,
    summary: memory.summary,
    messageCount: memory.metadata.messageCount,
    topics: memory.topics,
    factCount: memory.importantFacts.length,
    recentMessages: memory.recentMessages.map((m) => ({ role: m.role, text: m.text, at: m.at })),
  };
}

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  generic: 'Generic chat',
  coomeet: 'CooMeet',
  flirtify: 'Flirtify',
  demo: 'Local demo',
  unknown: 'Unknown',
};
