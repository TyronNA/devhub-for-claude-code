import { DevHubEvent } from '../../types';
const nodePath=require('node:path');
const os=require('node:os');
const fsSync=require('node:fs');
const crypto=require('node:crypto');

function now(){return Date.now();}
function labelTool(name:string,input:any){ if(!input) return name;
  // Claude's sub-agent (`Agent`, formerly `Task`): its input has NO path/command/query, so
  // the label falls back to the tool name and the row reads "Agent (Agent)" — two different spawns look
  // identical. `description` + the agent type are what tell them apart.
  if(name==='Agent'||name==='Task'){
    const what=String(input.description||'').trim();
    const kind=String(input.subagent_type||'').trim();
    return [what,kind&&`(${kind})`].filter(Boolean).join(' ')||name;
  }
  return input.file_path || input.path || input.command || input.query || name; }
function resultText(content:any):string|undefined {
  if(typeof content==='string') return content.slice(0,65536);
  if(Array.isArray(content)){
    const text=content.map((x:any)=>typeof x==='string'?x:(x?.text ?? x?.content ?? '')).filter(Boolean).join('\n');
    return text ? text.slice(0,65536) : undefined;
  }
  if(content && typeof content==='object'){
    try{return JSON.stringify(content).slice(0,65536);}catch{return undefined;}
  }
}
/**
 * Images in a `tool_result` (a Playwright screenshot, Read on a PNG) arrive as base64 blocks; `resultText`
 * only picks up text, so images used to be dropped and the user saw nothing after the agent took a screenshot.
 *
 * Written to a file instead of kept as a data: URI. A data URI travels whole inside `sessionSelected` — a single SSE/
 * postMessage packet resent EVERY time a tab opens or reconnects: a playtest transcript measured 8–10 MB of
 * base64 in its 16 MB tail, and the phone downloaded and decoded all of it before drawing the first line. With a `path` the host
 * turns it into a URL (`asWebviewUri` / `/api/file`), `<img loading=lazy>` only loads visible images and
 * the browser can cache them. Name = sha1 of the content ⇒ re-reading the transcript writes no new files; if tmp is
 * cleaned, the next parse writes them again. On a write error fall back to a data: URI as before.
 */
const MAX_IMAGE_B64=12*1024*1024;
const IMAGE_EXT:Record<string,string>={'image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp'};
/** Must sit under `localMediaRoots()` (tmp) so both the panel and `/api/file` agree to serve it. */
export function toolImageDir(){return nodePath.join(os.tmpdir(),'devhub-tool-images');}
function spillImage(dir:string|null,mime:string,data:string):string|undefined{
  if(!dir)return undefined;
  try{
    const file=nodePath.join(dir,crypto.createHash('sha1').update(data).digest('hex')+IMAGE_EXT[mime]);
    if(!fsSync.existsSync(file)){
      fsSync.mkdirSync(dir,{recursive:true});
      // Write to a temp name then rename: two tabs parsing the same transcript never expose a half-written file to <img>.
      const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
      fsSync.writeFileSync(tmp,Buffer.from(data,'base64'));fsSync.renameSync(tmp,file);
    }
    return file;
  }catch{return undefined;}
}
function resultImages(content:any,dir:string|null):{src?:string;path?:string}[]{
  if(!Array.isArray(content))return [];
  return content.flatMap((x:any)=>{const src=x?.type==='image'?x.source:undefined;const mime=String(src?.media_type||'').toLowerCase();
    if(src?.type!=='base64'||!/^image\/(png|jpeg|gif|webp)$/.test(mime)||typeof src.data!=='string'||!src.data||src.data.length>MAX_IMAGE_B64||!/^[A-Za-z0-9+/=]+$/.test(src.data))return [];
    const path=spillImage(dir,mime,src.data);
    return [path?{path}:{src:`data:${mime};base64,${src.data}`}];});
}
function isShellTool(name:string){const n=name.toLowerCase();return n==='bash'||n.includes('shell');}
/** A Bash tool_result starts with "Exit code N" when the command fails; `is_error` is only yes/no. */
function exitCodeFrom(text:string|undefined):number{const m=/^Exit code (\d+)/m.exec(text||'');return m?Number(m[1]):1;}
function fileChangeForTool(name:string):'add'|'modify'|'delete'|undefined {
  const n=name.toLowerCase();
  if(n==='write' || n.includes('create')) return 'add';
  if(n==='edit' || n.includes('patch') || n.includes('replace')) return 'modify';
  if(n.includes('delete') || n.includes('remove')) return 'delete';
}
/**
 * Progress line of a background sub-agent. The child runs for minutes while its `tool_result`
 * came back in the first second, so this is the ONLY thing that moves on the `Agent` row while waiting.
 */
export function taskProgressSummary(raw:any):string|undefined{
  const u=raw?.usage||{};const bits:string[]=[];
  if(raw?.subagent_type)bits.push(String(raw.subagent_type));
  const n=Number(u.tool_uses); if(Number.isFinite(n)&&n>0)bits.push(`${n} tool call${n>1?'s':''}`);
  if(raw?.last_tool_name)bits.push(`last: ${raw.last_tool_name}`);
  const ms=Number(u.duration_ms); if(Number.isFinite(ms)&&ms>0)bits.push(`${Math.round(ms/1000)}s`);
  return bits.length?bits.join(' \u00b7 '):undefined;
}
interface PendingTool {name:string;label:string;command?:string;filePath?:string;change?:'add'|'modify'|'delete';}

export class ClaudeEventParser {
  /** `null` = keep data: URIs (tests don't touch disk). Not `undefined`: that re-triggers the default value. */
  constructor(private imageDir:string|null=toolImageDir()){}
  private pending=new Map<string,PendingTool>();
  private sawTextDelta=false;
  /** Tools whose row was built at `content_block_start`; the later `assistant` only fills in arguments. */
  private announced=new Set<string>();
  /**
   * `tool_use_id`s of calls pushed to the background (sub-agents). Their `tool_result` comes back
   * IMMEDIATELY with a scrap of internal metadata ("Async agent launched successfully…") rather than the
   * result — closing the row with it would claim "done" while the child has only just started. The real result arrives later
   * in `task_notification`.
   */
  private backgrounded=new Set<string>();
  /** Message ids already used to anchor the cache time: `assistant` repeats for every content block of the same message. */
  private cacheMsg:string|undefined;

  /**
   * Prompt cache anchor, computed the way the official extension does: a request that hits the cache (read or
   * write) refreshes the TTL, so the clock runs from when that request started — `message_start` is the earliest
   * signal we see. TTL comes from `cache_creation.ephemeral_1h/5m`; a turn that only reads the cache doesn't state
   * the TTL, so leave it empty and the merge keeps the old value.
   */
  private cacheMark(id:any,u:any,t:number,out:DevHubEvent[]){
    if(!u||typeof u!=='object')return;
    const key=id?String(id):undefined; if(key&&key===this.cacheMsg)return;
    const read=Number(u.cache_read_input_tokens)||0,write=Number(u.cache_creation_input_tokens)||0;
    if(read+write<=0)return;
    this.cacheMsg=key;
    const cc=u.cache_creation||{};
    const ttl=(Number(cc.ephemeral_1h_input_tokens)||0)>0?3600000:(Number(cc.ephemeral_5m_input_tokens)||0)>0?300000:undefined;
    // Don't send `undefined` keys: the webview merges with Object.assign, and an empty key would erase a known TTL.
    const usage:any={cacheAnchorAt:t,cacheTokens:(Number(u.input_tokens)||0)+read+write};if(ttl)usage.cacheTtlMs=ttl;
    out.push({type:'usage',usage,timestamp:t});
  }

  parse(raw:any):DevHubEvent[]{
    const out:DevHubEvent[]=[]; const t=now(); if(!raw||typeof raw!=='object') return out;
    /**
     * Background sub-agent: the CLI pours the child's ENTIRE stream onto the same stdout, marked only by
     * `parent_tool_use_id`. Mixing it straight into the main stream causes two bugs at once — the child's words read
     * as the parent's, and every tool row of the child SPLITS the parent bubble mid-stream
     * (deltas can only append while the bubble is still the last element). The child's progress goes through
     * `task_*` below, wrapped inside the SAME `Agent` row that spawned it.
     */
    if(raw.parent_tool_use_id) return out;
    /**
     * Turns the CLI inserts itself ("Continue from where you left off." when resuming a cut turn) are answered
     * with a `<synthetic>` "No response requested." row. 0.29.52 removed the user half; the remaining
     * assistant half was still drawn as the agent speaking — reopening the tab read like the message just sent had been blocked.
     * REAL errors are also `<synthetic>` (rate limit, 402, 529, network loss) but always carry
     * `isApiErrorMessage`, and those MUST show. Surveying all of `~/.claude/projects`:
     * 135 synthetic rows, the 116 without that flag were all exactly this sentence, no exceptions.
     * Must match the exact sentence: output of local commands (`/context`, `/usage`…) on stream-json is also
     * `<synthetic>` without the error flag — the transcript survey didn't see it because files don't record those rows.
     */
    if(raw.type==='assistant'&&raw.message?.model==='<synthetic>'&&!raw.isApiErrorMessage&&isNoResponseGhost(raw.message?.content)) return out;
    if(raw.type==='assistant'){
      this.cacheMark(raw.message?.id,raw.message?.usage,t,out);
      const c=raw.message?.content;
      if(Array.isArray(c)) for(const part of c){
        /**
         * Since Opus 5.5 (like Fable 5.1), the progress sentence between tool calls — the very sentence
         * `appendSystemPrompt` asks for — arrives as `thinking` WITH text, not as `text`. Skipping it
         * as before leaves the turn silent between tool rows. Real reasoning is still redacted by the API (empty string),
         * so text present = a sentence written for the reader. It always stands alone in its own `assistant` row, no delta.
         */
        if(part?.type==='thinking'&&typeof part.thinking==='string'&&part.thinking.trim()){
          out.push({type:'assistant_message',text:part.thinking.trim(),timestamp:t});
        }
        if(part?.type==='text'&&part.text){
          if(!this.sawTextDelta) out.push({type:'assistant_message',text:String(part.text),timestamp:t});
        }
        if(part?.type==='tool_use'){
          const name=String(part.name||'tool'); const label=String(labelTool(name,part.input)); const id=String(part.id||part.tool_use_id||'');
          const pending:PendingTool={name,label,command:part.input?.command,filePath:part.input?.file_path||part.input?.path,change:fileChangeForTool(name)};
          if(id) this.pending.set(id,pending);
          if(isShellTool(name)) out.push({type:'command_started',command:String(pending.command||label),callId:id||undefined,timestamp:t});
          else out.push({type:'tool_started',tool:name,label,callId:id||undefined,timestamp:t});
        }
      }
      this.sawTextDelta=false;
    } else if(raw.type==='stream_event'){
      const event=raw.event||{}; const delta=event.delta;
      if(event.type==='message_start')this.cacheMark(event.message?.id,event.message?.usage,t,out);
      if(delta?.type==='text_delta'&&delta.text){ this.sawTextDelta=true; out.push({type:'assistant_delta',text:String(delta.text),timestamp:t}); }
      // Tool arguments stream token by token, so `assistant` arrives AFTER the model finishes writing the command
      // (measured 1.2s for a short command, longer for a heredoc). Build the row right at block_start;
      // `assistant` re-emits the same callId to fill the arguments into that row.
      const cb=event.type==='content_block_start'?event.content_block:undefined;
      if(cb?.type==='tool_use'&&cb.id&&!this.announced.has(String(cb.id))){
        const id=String(cb.id); const name=String(cb.name||'tool'); this.announced.add(id);
        if(isShellTool(name)) out.push({type:'command_started',command:'',callId:id,timestamp:t});
        else out.push({type:'tool_started',tool:name,label:'',callId:id,timestamp:t});
      }
    } else if(raw.type==='user'){
      const content=raw.message?.content;
      if(Array.isArray(content)) for(const part of content){
        if(part?.type!=='tool_result') continue;
        const id=String(part.tool_use_id||part.id||'');
        if(id&&this.backgrounded.has(id))continue;   // keep it pending for `task_notification`
        const pending=id?this.pending.get(id):undefined; const summary=resultText(part.content); const isError=part.is_error===true;
        if(pending?.command){
          out.push({type:'command_completed',command:pending.command,output:summary,exitCode:isError?exitCodeFrom(summary):undefined,callId:id||undefined,timestamp:t});
        } else {
          out.push({type:'tool_completed',tool:pending?.name||'tool',label:pending?.label||'Tool result',summary,callId:id||undefined,timestamp:t});
          if(pending?.filePath && pending.change && !isError) out.push({type:'file_changed',path:pending.filePath,change:pending.change,timestamp:t});
        }
        for(const img of resultImages(part.content,this.imageDir))out.push({type:'assistant_image',...img,alt:pending?.label||pending?.name||'Tool image',timestamp:t});
        if(id){ this.pending.delete(id); this.announced.delete(id); }
      }
    } else if(raw.type==='system'&&raw.subtype==='init'){
      if(typeof raw.model==='string'&&raw.model)out.push({type:'usage',usage:{model:raw.model},timestamp:t});
    } else if(raw.type==='system'&&raw.subtype==='thinking_tokens'){
      // Opus thinking content is redacted (empty string + signature); the estimated token count is
      // the ONLY sign of life while the model thinks. The value is absolute, not cumulative.
      const n=Number(raw.estimated_tokens);
      if(Number.isFinite(n)&&n>0) out.push({type:'thinking',tokens:n,timestamp:t});
    } else if(raw.type==='system'&&raw.subtype==='status'){
      // `/compact` only reports through here; ignoring it leaves the user seeing nothing after clicking.
      if(raw.status==='compacting')out.push({type:'tool_started',tool:'Compact',label:'compacting the conversation\u2026',timestamp:t} as DevHubEvent);
      else if(raw.compact_result==='failed')out.push({type:'error',message:`Compact failed: ${String(raw.compact_error||'unknown reason')}`,timestamp:t});
      else if(raw.compact_result){out.push({type:'tool_completed',tool:'Compact',label:String(raw.compact_result),
        summary:raw.pre_tokens&&raw.post_tokens?`${raw.pre_tokens} \u2192 ${raw.post_tokens} tokens`:undefined,timestamp:t} as DevHubEvent);
        // The prefix changed outright: the old cache no longer matches even before it expires; the next turn rewrites from scratch.
        if(raw.compact_result==='success'){this.cacheMsg=undefined;out.push({type:'usage',usage:{cacheAnchorAt:0},timestamp:t});}}
    } else if(raw.type==='system'&&(raw.subtype==='task_started'||raw.subtype==='task_progress'||raw.subtype==='task_notification')){
      // A background call is the ONLY path with output: its `tool_result` is just a receipt.
      const id=String(raw.tool_use_id||'');
      // Only accept tasks of THIS process. A `task_notification` left over from a previous session
      // (the CLI re-reports it on resume) has no row to attach to: building a new row for it cuts
      // into the middle of the streaming text — the very bug just fixed — and the label could only be guessed as 'Agent'.
      if(!id||!(this.pending.has(id)||this.backgrounded.has(id)))return out;
      const pending=this.pending.get(id);
      const tool=pending?.name||(raw.task_type==='local_agent'?'Agent':'Task');
      const label=String(raw.description||pending?.label||tool);
      if(raw.subtype==='task_notification'){
        this.backgrounded.delete(id);this.pending.delete(id);this.announced.delete(id);
        const status=String(raw.status||'');
        const parts=[status&&status!=='completed'?`[${status}]`:'',String(raw.summary||'').trim(),
                     raw.output_file?`(full output: ${raw.output_file})`:''].filter(Boolean);
        out.push({type:'tool_completed',tool,label,summary:parts.join('\n\n')||undefined,callId:id,timestamp:t});
        return out;
      }
      this.backgrounded.add(id);
      out.push({type:'tool_started',tool,label,summary:taskProgressSummary(raw),callId:id,timestamp:t});
    } else if(raw.type==='result'){
      this.announced.clear();
      const usage=raw.usage || raw.message?.usage;
      if(usage || raw.total_cost_usd!==undefined) out.push({type:'usage',usage:{
        inputTokens:usage?.input_tokens,
        outputTokens:usage?.output_tokens,
        cachedInputTokens:usage?.cached_input_tokens ?? usage?.cache_read_input_tokens,
        cacheWriteInputTokens:usage?.cache_write_input_tokens ?? usage?.cache_creation_input_tokens,
        reasoningOutputTokens:usage?.reasoning_output_tokens,
        contextUsedTokens:usage?.context_used_tokens ?? deriveContext(raw).used,
        contextWindowTokens:usage?.context_window_tokens ?? deriveContext(raw).window,
        costUsd:raw.total_cost_usd
      },timestamp:t});
      if(raw.is_error || raw.subtype==='error') out.push({type:'error',message:String(raw.error||raw.result||'Claude turn failed'),timestamp:t}); else out.push({type:'turn_done',timestamp:t});
    } else if(raw.type==='error') out.push({type:'error',message:String(raw.error?.message||raw.message||'Claude error'),timestamp:t});
    return out;
  }
}

function isNoResponseGhost(c:any):boolean{
  const parts=Array.isArray(c)?c:[{type:'text',text:c}];
  return parts.every((x:any)=>x?.type==='text'&&String(x.text||'').trim()==='No response requested.');
}

/**
 * `result` has no context_used/window. `modelUsage` has a `contextWindow` per model —
 * take the model with the largest window (the main model, not the helper haiku) and add the prompt
 * sent to estimate usage. It is an APPROXIMATION, not a number the CLI publishes.
 */
export function deriveContext(raw:any):{used?:number;window?:number}{
  const mu=raw?.modelUsage; if(!mu||typeof mu!=='object')return {};
  let best:any,window=0;
  for(const m of Object.values<any>(mu)){const w=Number(m?.contextWindow)||0;if(w>window){window=w;best=m;}}
  if(!best||!window)return {};
  // One turn can call the API several rounds; SUMMING the rounds overshoots the window (283% was seen).
  // The real context is the LAST round's prompt, so prefer `usage.iterations`.
  const it=raw?.usage?.iterations;
  const last=Array.isArray(it)&&it.length?it[it.length-1]:undefined;
  const src=last?{i:last.input_tokens,r:last.cache_read_input_tokens,c:last.cache_creation_input_tokens}
                :{i:best.inputTokens,r:best.cacheReadInputTokens,c:best.cacheCreationInputTokens};
  let used=(Number(src.i)||0)+(Number(src.r)||0)+(Number(src.c)||0);
  if(used>window)used=window;   // clamp: showing >100% is meaningless
  return {used:used||undefined,window};
}

export function parseClaudeEvent(raw:any):DevHubEvent[]{ return new ClaudeEventParser().parse(raw); }
export function extractClaudeSessionId(raw:any):string|undefined { return raw?.session_id || raw?.sessionId || raw?.message?.session_id || (raw?.type==='system'&&raw?.subtype==='init'?raw?.session_id:undefined); }
