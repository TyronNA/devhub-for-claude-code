const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
import { DevHubProject, DevHubSession, DevHubEvent } from '../../types';
import { boundedSet, collectFiles, HistoryScanCache, mapLimit, projectForCwd, readJsonLines, stampOf, timestampOf, truncateTitle } from '../historyUtils';
import { codexImageRoot, parseCodexEvent } from './codexEventParser';
import { isCodexHistoryItem, parseCodexHistoryRecord, codexSnapshot } from './codexHistoryParser';
/**
 * Codex writes each turn twice: `event_msg/user_message` is what the user typed, while
 * `response_item` role=user is the copy sent to the model — with injected context (`<recommended_plugins>`…).
 * Taking both doubles every message and sprays noise on screen.
 */
export function isInjectedContext(t:string){
  return /^\s*<[a-z_]+>/i.test(t)||/^\s*<\/[a-z_]+>/i.test(t);
}
export function eventUserText(r:any):string|undefined{
  const p=r?.payload;
  if(r?.type!=='event_msg'||p?.type!=='user_message')return undefined;
  const t=typeof p.message==='string'?p.message:p.message?.text;
  return typeof t==='string'&&t.trim()?t:undefined;
}
export function itemUserText(r:any):string|undefined{
  const p=r?.payload;
  if(r?.type!=='response_item'||p?.role!=='user')return undefined;
  const t=(p?.content||[]).map((x:any)=>x?.text||x?.input_text).filter(Boolean).join(' ');
  return t&&!isInjectedContext(t)?t:undefined;
}
/** `event_msg/item_completed` item.type=UserMessage — the current CLI's rollout form. */
export function itemCompletedUserText(r:any):string|undefined{
  if(!isCodexHistoryItem(r)||r.payload.item.type!=='UserMessage')return undefined;
  const t=(r.payload.item.content||[]).map((x:any)=>x?.text||x?.input_text||'').filter(Boolean).join('');
  return typeof t==='string'&&t.trim()?t:undefined;
}
/** For the sidebar title: prefer the real sentence, fall back to the rendered copy. */
function userText(r:any):string|undefined{ return itemCompletedUserText(r)??eventUserText(r)??itemUserText(r); }
export interface CodexFileFacts { cwd?:string; id?:string; title?:string; created:number; mtimeMs:number; }
export async function discoverCodexHistory(projects:DevHubProject[], codexRoot?:string,maxFiles=1500, transcriptIndex?:Map<string,string>, cache?:HistoryScanCache<CodexFileFacts>):Promise<DevHubSession[]> {
  const root=codexRoot ?? process.env.CODEX_HOME ?? path.join(os.homedir(),'.codex');
  const files=await collectFiles(path.join(root,'sessions'),n=>n.startsWith('rollout-')&&n.endsWith('.jsonl'),maxFiles,6);
  const found=await mapLimit(files,8,async file=>{
    const stamp=await stampOf(file); if(!stamp) return undefined;
    let facts:CodexFileFacts|undefined; let known=false;
    if(cache){ const c=cache.get(file,stamp); if(c.hit){ facts=c.value; known=true; } }
    if(!known){
      let rows:any[];try{rows=await readJsonLines(file,64*1024);}catch{ cache?.set(file,stamp,undefined); return undefined; }
      let cwd:string|undefined,id:string|undefined,title:string|undefined,created=0;
      for(const r of rows){if(r?.type==='session_meta'){const p=r.payload||{};cwd ||= p.cwd;id ||= p.id||p.session_id||p.thread_id;}if(!title){const tx=userText(r);if(tx)title=truncateTitle(tx);}const ts=timestampOf(r,0);if(ts&&!created)created=ts;if(cwd&&id&&title&&created)break;}
      facts=(cwd&&id)?{cwd,id,title,created,mtimeMs:stamp.mtimeMs}:undefined;
      cache?.set(file,stamp,facts);
    }
    if(!facts?.cwd||!facts.id) return undefined;
    if(transcriptIndex) boundedSet(transcriptIndex,facts.id,file);
    const project=projectForCwd(projects,facts.cwd); if(!project) return undefined;
    const mtime=facts.mtimeMs;
    return {provider:'codex',nativeSessionId:facts.id,workspaceId:project.workspaceId,projectId:project.id,cwd:project.rootPath,title:facts.title||'Codex chat',status:'imported',createdAt:facts.created||mtime,updatedAt:mtime} as DevHubSession;
  });
  return found.filter((s):s is DevHubSession=>!!s);
}
export async function loadCodexTranscript(file:string):Promise<DevHubEvent[]>{
  // Read from the TAIL: when a transcript is past the limit, the newest part is the part to show.
  const rows=await readJsonLines(file,16*1024*1024,'end');
  // The current CLI writes `event_msg/item_completed` — user, assistant, command, file, all of it.
  if(rows.some(isCodexHistoryItem))return rows.flatMap(parseCodexHistoryRecord);
  // Old rollouts: `event_msg/user_message`, falling back to response_item only without it.
  const hasEventTurns=rows.some(r=>eventUserText(r)!==undefined);
  const out:DevHubEvent[]=[];
  for(const r of rows){
    const tx=hasEventTurns?eventUserText(r):itemUserText(r);
    if(tx)out.push({type:'user_message',text:tx,timestamp:timestampOf(r,Date.now())});
    out.push(...parseCodexEvent(r));
    out.push(...parseCodexHistoryRecord(r).filter(e=>e.type==='usage'));
  }
  return out;
}
export async function findCodexTranscript(nativeSessionId:string,codexRoot?:string,maxFiles=2000):Promise<string|undefined>{ const root=codexRoot ?? process.env.CODEX_HOME ?? path.join(os.homedir(),'.codex'); const files=await collectFiles(path.join(root,'sessions'),n=>n.startsWith('rollout-')&&n.endsWith('.jsonl'),maxFiles,6); for(const f of files){ try{const rows=await readJsonLines(f,64*1024); if(rows.some((r:any)=>r?.type==='session_meta'&&[r.payload?.id,r.payload?.session_id,r.payload?.thread_id].includes(nativeSessionId))) return f;}catch{} } }

/** Only the last context measurement is needed after exec; keep the tail read bounded. */
export async function loadCodexContext(file:string){
  const rows=await readJsonLines(file,512*1024,'end');
  const usage=codexSnapshot(rows.flatMap(parseCodexHistoryRecord));
  return Object.keys(usage).length?usage:undefined;
}

/**
 * `codex exec --json` (0.153.4) has no item for image_gen images — only the rollout records them,
 * and that rollout line weighs ~3MB of base64. So look straight at the thread's image folder: far cheaper, and
 * it is also the only root the webview may load (`codexImageRoot`).
 */
export async function listCodexImages(nativeSessionId:string,codexRoot?:string):Promise<{path:string;mtimeMs:number}[]>{
  const dir=path.join(codexImageRoot(codexRoot),nativeSessionId);
  let names:string[]; try{names=await fs.readdir(dir);}catch{return [];}
  const out=await mapLimit(names.filter((n:string)=>/\.(png|jpe?g|gif|webp)$/i.test(n)),8,async (n:string)=>{
    const file=path.join(dir,n);
    try{return {path:file,mtimeMs:(await fs.stat(file)).mtimeMs};}catch{return undefined;}
  });
  return out.filter((x:any):x is {path:string;mtimeMs:number}=>!!x).sort((a,b)=>a.mtimeMs-b.mtimeMs);
}
