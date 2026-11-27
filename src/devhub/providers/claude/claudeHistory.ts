const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
import { DevHubProject, DevHubSession, DevHubEvent } from '../../types';
import { boundedSet, collectFiles, HistoryScanCache, mapLimit, projectForCwd, readJsonLines, stampOf, timestampOf, truncateTitle } from '../historyUtils';
import { ClaudeEventParser, extractClaudeSessionId } from './claudeEventParser';

function userText(raw:any):string|undefined { const c=raw?.message?.content; if(typeof c==='string') return c; if(Array.isArray(c)) return c.filter((x:any)=>x?.type==='text').map((x:any)=>x.text).join(' '); }
export interface ClaudeFileFacts { cwd?:string; id?:string; title?:string; created:number; mtimeMs:number; }
export async function discoverClaudeHistory(projects:DevHubProject[], claudeRoot?:string, maxFiles=1500, transcriptIndex?:Map<string,string>, cache?:HistoryScanCache<ClaudeFileFacts>):Promise<DevHubSession[]> {
  const root=claudeRoot ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(),'.claude');
  // `maxFiles` cuts in NAME order, and Claude transcript names are UUIDs — so when the file count exceeds the cap,
  // the dropped set is random, not "the oldest". The cap is `devHub.history.maxFilesPerProvider`;
  // measured over 1,954 files, a 1,500 cap dropped no session of a registered project, and the full scan took only
  // ~500 ms vs ~440 ms. Picking by mtime instead is WORSE: the 1,500 newest files across all of ~/.claude
  // get filled by unregistered projects, giving 168 sessions instead of 189.
  const found=await mapLimit(await collectFiles(path.join(root,'projects'),n=>n.endsWith('.jsonl'),maxFiles,3),8,async file=>{
    if(file.includes(`${path.sep}subagents${path.sep}`)) return undefined;
    const stamp=await stampOf(file); if(!stamp) return undefined;
    let facts:ClaudeFileFacts|undefined; let known=false;
    if(cache){ const c=cache.get(file,stamp); if(c.hit){ facts=c.value; known=true; } }
    if(!known){
      let rows:any[]; try{rows=await readJsonLines(file,64*1024);}catch{ cache?.set(file,stamp,undefined); return undefined; }
      let cwd:string|undefined,id:string|undefined,title:string|undefined,created=0;
      for(const r of rows){cwd ||= r?.cwd || r?.message?.cwd;id ||= extractClaudeSessionId(r) || r?.sessionId;if(r?.type==='user'&&!title){const tx=userText(r);if(tx)title=truncateTitle(tx);}const ts=timestampOf(r,0);if(ts&&!created)created=ts;if(cwd&&id&&title&&created)break;}
      id ||= path.basename(file,'.jsonl');
      facts=cwd?{cwd,id,title,created,mtimeMs:stamp.mtimeMs}:undefined;
      cache?.set(file,stamp,facts);
    }
    if(!facts?.cwd||!facts.id) return undefined;
    const project=projectForCwd(projects,facts.cwd); if(!project) return undefined;
    if(transcriptIndex) boundedSet(transcriptIndex,facts.id,file);
    const mtime=facts.mtimeMs;
    return {provider:'claude',nativeSessionId:facts.id,workspaceId:project.workspaceId,projectId:project.id,cwd:project.rootPath,title:facts.title||'Claude chat',status:'imported',createdAt:facts.created||mtime,updatedAt:mtime} as DevHubSession;
  });
  return found.filter((s):s is DevHubSession=>!!s);
}
// For chats over 16 MiB, reading from the START loses exactly the newest part of the conversation — the UI also only
// takes the last 1,500 events, so read from the end of the file.
/**
 * NOT every `type:"user"` row is something the user typed. The CLI inserts user turns to talk to
 * the model: `<task-notification>…` when a background task finishes (`origin.kind`), and "Continue from where
 * you left off." when resuming a cut turn (`isMeta`). Drawing them as user bubbles invents words
 * the user never said — exactly what looks like "phantom rendering" when reopening a tab.
 * OLD rows have no `origin` at all, so only drop when kind is present AND not `human`.
 */
export function isInjectedUserTurn(raw:any):boolean{
  if(raw?.isMeta===true||raw?.isSidechain===true||raw?.parent_tool_use_id)return true;
  const kind=raw?.origin?.kind;
  return typeof kind==='string'&&kind!=='human';
}
export async function loadClaudeTranscript(file:string):Promise<DevHubEvent[]> { const rows=await readJsonLines(file,16*1024*1024,'end');const out:DevHubEvent[]=[]; const parser=new ClaudeEventParser(); for(const r of rows){ if(r?.type==='user'&&!isInjectedUserTurn(r)){const tx=userText(r); if(tx) out.push({type:'user_message',text:tx,timestamp:timestampOf(r,Date.now())});} out.push(...parser.parse(r)); } return out; }
export async function findClaudeTranscript(nativeSessionId:string, claudeRoot?:string,maxFiles=2000):Promise<string|undefined>{ const root=claudeRoot ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(),'.claude'); /* Accept ONLY the exact name being looked for: accepting every `.jsonl` then calling `find` means the cap cuts before searching,
   and the wanted file may be in the part that was cut — with 1,954 transcripts that is common. */
const files=await collectFiles(path.join(root,'projects'),n=>n===`${nativeSessionId}.jsonl`,maxFiles,3); return files[0]; }
