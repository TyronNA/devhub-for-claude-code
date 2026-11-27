import { DevHubEvent, DevHubProject, DevHubSession, ProviderId } from '../types';
/** Model/effort chosen per turn; each provider maps them to its own CLI flags.
 *  `images`: paths of saved images — Claude appends them to the prompt. */
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
  /** Cancels a turn the CLI ITSELF opened: that turn didn't go through start/resume so there is no
   *  `ProviderTurnHandle` holding `cancel`. Providers that never open turns themselves needn't implement it. */
  interruptOutOfTurn?(nativeId:string):Promise<boolean>;
}
