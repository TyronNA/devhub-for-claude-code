import { DevHubSession, ProviderId } from '../types';
export interface SessionSelectionKey { provider:ProviderId; nativeSessionId:string; }
export function findRestorableSession(sessions:DevHubSession[],key:SessionSelectionKey|undefined){if(!key)return sessions.filter(s=>s.status!=='unavailable').reduce<DevHubSession|undefined>((latest,s)=>!latest||s.updatedAt>latest.updatedAt?s:latest,undefined);return sessions.find(s=>s.provider===key.provider&&s.nativeSessionId===key.nativeSessionId);}
