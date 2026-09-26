/**
 * Shared type contracts for ROSE IA.
 *
 * Everything that crosses a module boundary (content script ↔ service worker ↔
 * UI ↔ platform adapters) is typed here so the layers stay decoupled.
 */

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export const MSG = {
  // content -> background
  DETECTION_REPORT: 'rose/detection/report',
  /**
   * Sent from a frame that is being torn down (navigation, removal). Without it
   * the overlay arbiter would keep believing a departed chat frame still owns
   * the UI, and the tab would be left with no visible overlay at all.
   */
  FRAME_GONE: 'rose/frame/gone',
  /**
   * Overlay mirroring. On a platform whose chat lives in a child frame, the
   * frame that holds the chat owns the *data* but must not draw the panel: a
   * `position: fixed` panel inside an iframe is clipped to that iframe and could
   * not be moved over the rest of the page. So the chat frame publishes its
   * state and the top frame renders it. These three messages are the bridge;
   * the service worker is the only channel that spans origins.
   */
  OVERLAY_SYNC: 'rose/overlay/sync',
  OVERLAY_INTENT: 'rose/overlay/intent',
  OVERLAY_MIRROR_READY: 'rose/overlay/mirror-ready',
  MESSAGE_DETECTED: 'rose/message/detected',
  CONVERSATION_ACTIVATED: 'rose/conversation/activated',
  REQUEST_SUGGESTIONS: 'rose/ai/suggestions',
  RECORD_OUTGOING: 'rose/message/outgoing',
  REQUEST_TRANSLATION: 'rose/translate',
  LOG: 'rose/log',
  STATS_EVENT: 'rose/stats/event',
  ACTIVATE_SITE: 'rose/site/activate',
  // background -> content
  STATE_UPDATED: 'rose/state/updated',
  SUGGESTIONS_READY: 'rose/ai/suggestions/ready',
  COMMAND: 'rose/command',
  // any -> any
  PING: 'rose/ping',
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export interface Envelope<T = unknown> {
  type: MessageType;
  requestId?: string;
  payload?: T;
}

export interface MessageResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export type PlatformId = 'generic' | 'coomeet' | 'flirtify' | 'demo' | 'unknown';

export interface DetectionReport {
  platform: PlatformId;
  confidence: number;
  url: string;
  hostname: string;
  /** Selectors the adapter resolved, surfaced in the debug panel. */
  resolved: Record<string, string | null>;
  notes: string[];
  detectedAt: number;
}

/**
 * Identity of the frame a report came from.
 *
 * A platform may host its chat in a child frame (CooMeet serves the shell on
 * www.coomeet.com and the chat on iframe.coomeet.com), so a report without frame
 * identity cannot be attributed to the document that actually holds the
 * conversation. `frameId` 0 is the top frame, per the extension platform.
 */
export interface FrameIdentity {
  tabId: number | null;
  frameId: number;
  url: string;
  /** `tabId:frameId:url` — stable per frame, changes when the frame navigates. */
  key: string;
}

/** What a frame is allowed to do — mirrors content/frame-role. */
export type FrameRoleName = 'top' | 'chat' | 'ignored';

export interface RawMessage {
  /** Stable-ish key so the same DOM node is never processed twice. */
  key: string;
  text: string;
  direction: 'incoming' | 'outgoing' | 'system';
  author: string | null;
  timestamp: number;
  /** Platform-native message id when the DOM exposes one. */
  nativeId?: string | null;
}

export interface ConversationRef {
  /** Deterministic id: `${platform}:${clientId}` — never shared across clients. */
  id: string;
  platform: PlatformId;
  clientId: string;
  displayName: string;
  conversationId: string;
  url: string;
  avatarUrl?: string | null;
  language?: string | null;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface StoredMessage {
  role: 'client' | 'assistant';
  text: string;
  at: number;
  lang?: string | null;
}

export interface ImportantFact {
  key: string;
  value: string;
  at: number;
  /** Higher = more likely to be kept during compression. */
  weight: number;
}

export interface ClientMemory {
  id: string;
  platform: PlatformId;
  clientId: string;
  displayName: string;
  language: string | null;
  conversationId: string;
  summary: string;
  recentMessages: StoredMessage[];
  importantFacts: ImportantFact[];
  preferences: Record<string, string>;
  topics: string[];
  lastInteraction: number;
  createdAt: number;
  metadata: {
    messageCount: number;
    platformsSeen: PlatformId[];
    tokensSaved: number;
    version: number;
  };
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export type ResponseStyle =
  | 'natural'
  | 'friendly'
  | 'warm'
  | 'flirty'
  | 'playful'
  | 'direct'
  | 'custom';

export type ResponseLength = 'short' | 'medium' | 'long';

export type SuggestionKind = 'natural' | 'warm' | 'engaging';

export interface Suggestion {
  kind: SuggestionKind;
  text: string;
  /** Language the text is written in (ISO-639-1). */
  lang: string;
  tokens?: number;
  cached?: boolean;
}

export interface GenerationRequest {
  conversation: ConversationRef;
  memory: ClientMemory;
  incoming: string;
  history: StoredMessage[];
  style: ResponseStyle;
  customStyle?: string;
  length: ResponseLength;
  count: number;
  /** Language to answer in; 'auto' mirrors the client's language. */
  targetLanguage: string;
}

export interface GenerationResult {
  suggestions: Suggestion[];
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  cached: boolean;
}

export interface AIProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Model used for cheap tasks (summaries, language detection). */
  fastModel: string;
  temperature: number;
  maxTokens: number;
  enabled: boolean;
  /** true when baseUrl points at a ROSE backend acting as a secure proxy. */
  viaProxy: boolean;
  /**
   * false for endpoints that genuinely need no credential (a local model, or a
   * keyless test endpoint). Absent means true: every preset shipped before this
   * flag existed did require a key, so the default must stay strict.
   */
  requiresKey?: boolean;
}

/** AI configuration block: which provider is active and the guard rails. */
export interface AISettings {
  activeProvider: string;
  providers: AIProviderConfig[];
  maxResponseChars: number;
  allowNSFW: boolean;
  /** Consent gate: AI features stay off until the user acknowledges the policy. */
  acknowledgedPolicy: boolean;
}

// ---------------------------------------------------------------------------
// Quality guard
// ---------------------------------------------------------------------------

export interface QualityIssue {
  code:
    | 'duplicate'
    | 'too-long'
    | 'wrong-language'
    | 'ignored-question'
    | 'contradiction'
    | 'empty'
    | 'off-context'
    | 'banned-content';
  severity: 'info' | 'warn' | 'block';
  detail: string;
}

export interface QualityReport {
  ok: boolean;
  issues: QualityIssue[];
  score: number;
}

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

export type AutomationMode = 'manual' | 'assisted' | 'auto';

/**
 * Lifecycle of a single message as ROSE handles it.
 *
 * Lives here (rather than only in the state machine) because the overlay, the
 * content controller and the popup all render it; keeping one definition avoids
 * the UI drifting from the machine's actual states.
 */
export type AutomationState =
  | 'idle'
  | 'generating'
  | 'ready'
  | 'inserting'
  | 'awaiting-confirm'
  | 'waiting-delay'
  | 'sending'
  | 'sent'
  | 'paused'
  | 'stopped'
  | 'error';

export type ConversationStatus = 'active' | 'waiting' | 'new' | 'inactive';

export interface AutomationConfig {
  mode: AutomationMode;
  globalEnabled: boolean;
  globalPaused: boolean;
  pausedPlatforms: PlatformId[];
  pausedConversations: string[];
  /** Minimum delay before an auto reply, in ms. */
  replyDelayMs: number;
  /** Hard ceiling on auto replies per rolling hour, per conversation. */
  maxAutoMessagesPerHour: number;
  /** Minutes of silence before a conversation is flagged inactive. */
  inactivityMinutes: number;
  followUpsEnabled: boolean;
  maxFollowUps: number;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface DailyStats {
  date: string;
  conversations: number;
  messagesReceived: number;
  responsesGenerated: number;
  responsesSent: number;
  totalResponseMs: number;
  tokensPrompt: number;
  tokensCompletion: number;
  requests: number;
  costUsd: number;
}

export interface StatsEvent {
  kind: 'conversation' | 'message-received' | 'response-generated' | 'response-sent' | 'ai-request';
  conversationId?: string;
  responseMs?: number;
  tokensPrompt?: number;
  tokensCompletion?: number;
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * User-supplied site configuration for platforms ROSE does not ship an adapter
 * for. Mirrors the adapter `SiteConfig` shape without importing platform code
 * into the shared layer.
 */
export interface SiteConfigLike {
  hosts: string[];
  messageContainer?: string[];
  incomingMessage?: string[];
  outgoingMessage?: string[];
  author?: string[];
  input?: string[];
  sendButton?: string[];
  conversationRoot?: string[];
  idAttribute?: string;
  sendWithEnter?: boolean;
}

export interface RoseSettings {
  ai: AISettings;
  conversation: {
    style: ResponseStyle;
    customStyle: string;
    length: ResponseLength;
    suggestionCount: number;
    targetLanguage: string;
    autoDetectLanguage: boolean;
  };
  automation: AutomationConfig;
  memory: {
    enabled: boolean;
    retentionDays: number;
    maxRecentMessages: number;
    autoSummarizeAfter: number;
  };
  translation: {
    enabled: boolean;
    autoTranslateIncoming: boolean;
    myLanguage: string;
    showFlagBadges: boolean;
  };
  appearance: {
    theme: 'dark' | 'light' | 'system';
    opacity: number;
    scale: number;
    position: { x: number; y: number } | null;
    collapsed: boolean;
    accent: 'violet' | 'rose' | 'cyan';
  };
  notifications: {
    enabled: boolean;
    onNewMessage: boolean;
    onReplyReady: boolean;
    onError: boolean;
    onCreditsLow: boolean;
    minIntervalMs: number;
  };
  liveCall: {
    enabled: boolean;
    autoStart: boolean;
    language: string;
    showInterim: boolean;
  };
  debug: {
    enabled: boolean;
    verbose: boolean;
    showOverlay: boolean;
  };
  /** User-supplied site configurations, applied before built-in heuristics. */
  platforms: SiteConfigLike[];
}

// ---------------------------------------------------------------------------
// Commands (background/UI -> content script)
// ---------------------------------------------------------------------------

export type Command =
  | { action: 'insert'; text: string; send: boolean; conversationId: string }
  | { action: 'stop-all' }
  | { action: 'set-mode'; mode: AutomationMode }
  | { action: 'pause-conversation'; conversationId: string; paused: boolean }
  | { action: 'rescan' }
  | { action: 'toggle-overlay' }
  | { action: 'open-conversation'; conversationId: string }
  // Overlay arbitration across frames: the background decides which frame draws
  // the panel (see background/frame-arbiter) and tells it to mount, and any
  // previous renderer to stand down. `mirrorFor` names the frame holding the
  // chat data when that is a different frame, so the panel renders another
  // frame's state instead of its own.
  | { action: 'mount-overlay'; mirrorFor: number | null }
  | { action: 'unmount-overlay' }
  // Panel mirroring between frames (see ui/remote-overlay for why).
  | { action: 'mirror-state'; fromFrameId: number; state: Record<string, unknown>; mounted: boolean }
  | { action: 'republish-overlay' }
  | { action: 'overlay-intent'; intent: OverlayIntent };

/**
 * What the top frame may ask the chat frame to do.
 *
 * The overlay lives in the top frame because only there can a floating panel
 * cover the whole window; the chat, the composer and the memory live in the chat
 * frame. The two cannot touch each other directly (different origins), so the
 * top frame forwards the operator's intent and the chat frame executes it.
 */
export type OverlayIntent =
  | { action: 'generate'; force: boolean }
  | { action: 'select'; index: number }
  | { action: 'action'; kind: 'shorter' | 'longer' | 'translate' | 'copy' | 'insert' | 'send' }
  | { action: 'set-mode'; mode: AutomationMode }
  | { action: 'stop-all' }
  | { action: 'pause-toggle' }
  | { action: 'live-toggle' };
