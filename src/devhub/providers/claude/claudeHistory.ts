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
  // `maxFiles` cắt theo thứ tự TÊN, mà tên transcript Claude là UUID — nên khi số file vượt trần,
  // tập bị bỏ là ngẫu nhiên, không phải "cũ nhất". Trần là `devHub.history.maxFilesPerProvider`;
  // đo trên 1.954 file thì cap 1.500 chưa bỏ session nào của project đã đăng ký, và quét hết chỉ
  // ~500 ms so với ~440 ms. Chọn lại theo mtime thì TỆ HƠN: 1.500 file mới nhất trên toàn ~/.claude
  // bị lấp bởi project chưa đăng ký, đo được 168 session thay vì 189.
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
// Chat dài vượt 16 MiB thì đọc từ ĐẦU là mất đúng phần hội thoại mới nhất — UI cũng chỉ
// lấy 1.500 event cuối, nên đọc từ cuối file.
/**
 * KHÔNG phải mọi hàng `type:"user"` đều là lời người dùng gõ. CLI tự chèn lượt user để nói với
 * model: `<task-notification>…` khi một task nền kết thúc (`origin.kind`), và "Continue from where
 * you left off." khi nối lại lượt bị cắt (`isMeta`). Vẽ chúng thành bong bóng user là bịa ra câu
 * người dùng chưa từng nói — đúng thứ trông như "render ảo" lúc mở lại tab.
 * Hàng CŨ không có `origin` nào cả, nên chỉ loại khi kind có mặt VÀ khác `human`.
 */
export function isInjectedUserTurn(raw:any):boolean{
  if(raw?.isMeta===true||raw?.isSidechain===true||raw?.parent_tool_use_id)return true;
  const kind=raw?.origin?.kind;
  return typeof kind==='string'&&kind!=='human';
}
export async function loadClaudeTranscript(file:string):Promise<DevHubEvent[]> { const rows=await readJsonLines(file,16*1024*1024,'end');const out:DevHubEvent[]=[]; const parser=new ClaudeEventParser(); for(const r of rows){ if(r?.type==='user'&&!isInjectedUserTurn(r)){const tx=userText(r); if(tx) out.push({type:'user_message',text:tx,timestamp:timestampOf(r,Date.now())});} out.push(...parser.parse(r)); } return out; }
export async function findClaudeTranscript(nativeSessionId:string, claudeRoot?:string,maxFiles=2000):Promise<string|undefined>{ const root=claudeRoot ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(),'.claude'); /* Chỉ nhận ĐÚNG tên cần tìm: nhận mọi `.jsonl` rồi `find` nghĩa là cap cắt trước khi tìm,
   và file cần tìm có thể nằm ngoài phần bị cắt — với 1.954 transcript thì đó là chuyện thường. */
const files=await collectFiles(path.join(root,'projects'),n=>n===`${nativeSessionId}.jsonl`,maxFiles,3); return files[0]; }
