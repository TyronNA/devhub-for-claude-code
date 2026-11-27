import { DevHubSession } from '../types';

export const DEFAULT_PLANNER_ENDPOINT='http://127.0.0.1:7341';
const PREFIX='planner:';
/** ID nội bộ chứa daemon; chỉ conversation gốc được gửi qua HTTP. */
export function plannerSessionId(endpoint:string,conversationId:string){
  return PREFIX+JSON.stringify([endpoint.replace(/\/+$/,''),plannerConversationId(conversationId)]);
}
function parts(id:string):string[]|undefined{
  if(id.startsWith(PREFIX))try{const value=JSON.parse(id.slice(PREFIX.length));if(Array.isArray(value)&&value.length===2&&value.every(x=>typeof x==='string'))return value;}catch{}
}
export function plannerConversationId(id:string):string{return parts(id)?.[1]??id;}
export function plannerEndpoint(id:string):string|undefined{return parts(id)?.[0];}
export function scopedPlannerSession(session:DevHubSession):DevHubSession{
  if(session.provider!=='planner'||plannerConversationId(session.nativeSessionId)!==session.nativeSessionId)return session;
  const nativeSessionId=plannerSessionId(session.plannerEndpoint||DEFAULT_PLANNER_ENDPOINT,session.nativeSessionId);
  return nativeSessionId===session.nativeSessionId?session:{...session,nativeSessionId};
}
