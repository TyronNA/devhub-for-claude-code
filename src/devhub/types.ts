export type ProviderId = 'claude' | 'codex' | 'planner';
export type SessionStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'imported' | 'unavailable';

export interface DevHubWorkspace { id:string; name:string; createdAt:number; updatedAt:number; }
export interface DevHubProject { id:string; workspaceId:string; name:string; rootPath:string; gitRoot?:string; createdAt:number; updatedAt:number; }
export interface UsageSnapshot {
  inputTokens?:number; outputTokens?:number; cachedInputTokens?:number; cacheWriteInputTokens?:number; reasoningOutputTokens?:number; contextUsedTokens?:number; contextWindowTokens?:number;
  quota5hUsedPercentage?:number; quota5hResetsAt?:number; quota5hObservedAt?:number; quota5hAuthoritative?:boolean; quota7dUsedPercentage?:number; quota7dResetsAt?:number; quota7dObservedAt?:number; quota7dAuthoritative?:boolean; costUsd?:number;
  /** The CLI id actually running (`opus` → `claude-opus-5-5`); the alias in settings doesn't say which build. */
  model?:string;
  /**
   * Prompt cache of the main conversation: when the last request hit the cache (read or write) and its TTL.
   * `cacheAnchorAt:0` = just compacted, the old cache no longer matches. `cacheTokens` = what the next turn has to
   * rewrite if the cache went cold. Sub-agents have their own cache, so they don't count.
   */
  cacheAnchorAt?:number; cacheTtlMs?:number; cacheTokens?:number;
  /** The CLI's `get_usage`: 24h/7d usage traits of the whole account on this machine (not per session). */
  usageInsights?:UsageInsights;
}
export interface UsageInsightWindow { requests?:number; sessions?:number; behaviors:{key:string;pct:number}[]; top:{group:string;name:string;pct:number}[]; }
export interface UsageInsights { observedAt:number; day?:UsageInsightWindow; week?:UsageInsightWindow; }
export interface DevHubSession {
  provider:ProviderId; nativeSessionId:string; workspaceId:string; projectId:string; cwd:string; title:string; status:SessionStatus;
  createdAt:number; updatedAt:number; usage?:UsageSnapshot;
  /** Model/effort chosen for this session; closing and reopening the tab must reuse them, not fall back to the settings default. */
  model?:string; effort?:string;
  /** A name set by hand (rename in the tree); `title` stays the first prompt and isn't overwritten. */
  name?:string;
  /** Planner endpoint; the internal ID is scoped per daemon, HTTP uses the original conversation. */
  plannerEndpoint?:string;
}
export type DevHubEvent =
  // `images` = paths of attached files (the host turns them into webview URIs when sending, like assistant_image).
  | { type:'user_message'; text:string; images?:string[]; timestamp:number }
  | { type:'assistant_delta'; text:string; timestamp:number }
  | { type:'assistant_message'; text:string; timestamp:number }
  /**
   * REPLACE, not append: `text` is the ENTIRE answer so far. The planner emits this
   * because its daemon edits one message in place (Slack-style) rather than sending deltas — appending two
   * frames like `assistant_delta` gives a garbage string. Anything that streams deltas must not use this.
   */
  | { type:'assistant_view'; text:string; timestamp:number }
  // `path` = a file on disk (the host turns it into a webview URI when sending); `src` = a data: URI, the fallback.
  | { type:'assistant_image'; src?:string; path?:string; alt:string; timestamp:number }
  // callId: matches *_started with *_completed so the UI updates that exact row instead of printing it twice.
  // `summary` only exists on long-running rows (background sub-agent progress); normal tool rows don't carry it.
  | { type:'tool_started'; tool:string; label:string; summary?:string; callId?:string; timestamp:number }
  | { type:'tool_completed'; tool:string; label:string; summary?:string; callId?:string; timestamp:number }
  | { type:'command_started'; command:string; callId?:string; timestamp:number }
  | { type:'command_completed'; command:string; exitCode?:number; output?:string; callId?:string; timestamp:number }
  | { type:'file_changed'; path:string; change:'add'|'modify'|'delete'; timestamp:number }
  // Only a progress signal while the model thinks; NOT saved to the transcript, only drawn on the running indicator.
  | { type:'thinking'; tokens:number; timestamp:number }
  | { type:'usage'; usage:UsageSnapshot; timestamp:number }
  | { type:'warning'; message:string; timestamp:number }
  | { type:'error'; message:string; timestamp:number }
  | { type:'turn_done'; timestamp:number };
