export type ProviderId = 'claude' | 'planner';
export type SessionStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'imported' | 'unavailable';

export interface DevHubWorkspace { id:string; name:string; createdAt:number; updatedAt:number; }
export interface DevHubProject { id:string; workspaceId:string; name:string; rootPath:string; gitRoot?:string; createdAt:number; updatedAt:number; }
export interface UsageSnapshot {
  inputTokens?:number; outputTokens?:number; cachedInputTokens?:number; cacheWriteInputTokens?:number; reasoningOutputTokens?:number; contextUsedTokens?:number; contextWindowTokens?:number;
  quota5hUsedPercentage?:number; quota5hResetsAt?:number; quota5hObservedAt?:number; quota5hAuthoritative?:boolean; quota7dUsedPercentage?:number; quota7dResetsAt?:number; quota7dObservedAt?:number; quota7dAuthoritative?:boolean; costUsd?:number;
  /** Id CLI thật sự chạy (`opus` → `claude-opus-5-5`); alias trong setting không nói lên bản nào. */
  model?:string;
  /**
   * Prompt cache của hội thoại chính: lúc request cuối chạm cache (đọc hoặc ghi) và TTL của nó.
   * `cacheAnchorAt:0` = vừa compact, cache cũ không còn khớp. `cacheTokens` = phần lượt kế phải
   * ghi lại nếu cache đã nguội. Sub-agent có cache riêng nên không tính.
   */
  cacheAnchorAt?:number; cacheTtlMs?:number; cacheTokens?:number;
  /** `get_usage` của CLI: đặc điểm usage 24h/7d của cả tài khoản trên máy này (không phải session). */
  usageInsights?:UsageInsights;
}
export interface UsageInsightWindow { requests?:number; sessions?:number; behaviors:{key:string;pct:number}[]; top:{group:string;name:string;pct:number}[]; }
export interface UsageInsights { observedAt:number; day?:UsageInsightWindow; week?:UsageInsightWindow; }
export interface DevHubSession {
  provider:ProviderId; nativeSessionId:string; workspaceId:string; projectId:string; cwd:string; title:string; status:SessionStatus;
  createdAt:number; updatedAt:number; usage?:UsageSnapshot;
  /** Model/effort đã chọn cho session này; đóng tab mở lại phải dùng lại, không rơi về setting mặc định. */
  model?:string; effort?:string;
  /** Tên người đặt tay (rename trên cây); `title` vẫn là prompt đầu, không bị đè. */
  name?:string;
  /** Endpoint planner; ID nội bộ được scope theo daemon, HTTP dùng conversation gốc. */
  plannerEndpoint?:string;
}
export type DevHubEvent =
  // `images` = đường dẫn file đính kèm (host đổi sang webview URI lúc gửi, như assistant_image).
  | { type:'user_message'; text:string; images?:string[]; timestamp:number }
  | { type:'assistant_delta'; text:string; timestamp:number }
  | { type:'assistant_message'; text:string; timestamp:number }
  /**
   * THAY THẾ, không nối: `text` là TOÀN BỘ phần trả lời tới lúc này. Planner phát kiểu này
   * vì daemon của nó sửa một message tại chỗ (Slack-style) chứ không gửi delta — nối hai
   * frame như `assistant_delta` sẽ ra chuỗi rác. Ai stream bằng delta thì đừng dùng cái này.
   */
  | { type:'assistant_view'; text:string; timestamp:number }
  // `path` = file trên đĩa (host đổi sang webview URI lúc gửi); `src` = data: URI, đường lùi.
  | { type:'assistant_image'; src?:string; path?:string; alt:string; timestamp:number }
  // callId: khớp *_started với *_completed để UI cập nhật đúng dòng đó, khỏi in hai lần.
  // `summary` chỉ có ở dòng đang chạy dài (tiến trình sub-agent nền); dòng tool thường không mang.
  | { type:'tool_started'; tool:string; label:string; summary?:string; callId?:string; timestamp:number }
  | { type:'tool_completed'; tool:string; label:string; summary?:string; callId?:string; timestamp:number }
  | { type:'command_started'; command:string; callId?:string; timestamp:number }
  | { type:'command_completed'; command:string; exitCode?:number; output?:string; callId?:string; timestamp:number }
  | { type:'file_changed'; path:string; change:'add'|'modify'|'delete'; timestamp:number }
  // Chỉ báo tiến trình lúc model đang nghĩ; KHÔNG lưu vào transcript, chỉ vẽ ở chỉ báo chạy.
  | { type:'thinking'; tokens:number; timestamp:number }
  | { type:'usage'; usage:UsageSnapshot; timestamp:number }
  | { type:'warning'; message:string; timestamp:number }
  | { type:'error'; message:string; timestamp:number }
  | { type:'turn_done'; timestamp:number };
