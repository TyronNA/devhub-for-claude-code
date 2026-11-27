import { DevHubEvent, DevHubProject, DevHubSession, ProviderId } from '../types';
/** Model/effort chọn theo từng lượt; mỗi provider ánh xạ sang cờ CLI riêng của nó.
 *  `images`: đường dẫn ảnh đã lưu — Claude nối vào prompt. */
export interface TurnOptions { model?:string; effort?:string; images?:string[]; }
export interface StartSessionInput extends TurnOptions { workspaceId:string; projectId:string; cwd:string; prompt:string; }
export interface ResumeSessionInput extends TurnOptions { session:DevHubSession; prompt:string; }
export interface ProviderTurnHandle { events:AsyncIterable<DevHubEvent>; cancel():Promise<void>; getNativeSessionId():string|undefined; }
export interface AgentProvider {
  readonly id:ProviderId;
  isAvailable():Promise<boolean>;
  start(input:StartSessionInput):Promise<ProviderTurnHandle>;
  resume(input:ResumeSessionInput):Promise<ProviderTurnHandle>;
  discoverHistory(projects:DevHubProject[], signal?:any):Promise<DevHubSession[]>;
  loadTranscript(session:DevHubSession, signal?:any):Promise<DevHubEvent[]>;
  /** Huỷ một lượt do CHÍNH CLI mở: lượt đó không đi qua start/resume nên không có
   *  `ProviderTurnHandle` nào giữ `cancel`. Provider không tự mở lượt thì khỏi cài. */
  interruptOutOfTurn?(nativeId:string):Promise<boolean>;
}
