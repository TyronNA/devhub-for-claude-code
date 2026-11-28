const nodePath=require('node:path');
import { DevHubEvent, UsageSnapshot } from '../../types';
import { timestampOf } from '../historyUtils';
import { codexAgentEvent, codexAgentItemKind, codexFileChangeEvents, codexImageEvent, codexMcpToolEvent } from './codexEventParser';

/**
 * Codex's rollout JSONL is NOTHING like the stdout of `codex exec --json`:
 *   stdout   -> {type:'item.completed', item:{type:'agent_message'}}
 *   rollout  -> {type:'event_msg', payload:{type:'item_completed', item:{type:'AgentMessage'}}}
 * Feed a rollout to the stdout parser and no branch matches, so a reopened transcript only keeps
 * the user's lines. This file parses the rollout form on its own.
 */

function textOf(content:any):string{
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return '';
  // UserMessage uses {type:'text'}, AgentMessage uses {type:'Text'} — accept both.
  return content.map((c:any)=>typeof c==='string'?c:(c?.text??c?.input_text??'')).filter(Boolean).join('');
}
/**
 * Images in `UserMessage`: `local_image` is a path (Dev Hub attaches with `-i`, so it lands here),
 * `image` is a ~1.7MB data URI pasted by another client — there is no copy on disk, so the data URI
 * is the ONLY copy; keep it like `assistant_image.src`. The cap matches the webview's paste path.
 */
const MAX_INLINE_IMAGE=12*1024*1024;
function userImagesOf(content:any):string[]{
  if(!Array.isArray(content))return [];
  const out:string[]=[];
  for(const c of content){
    if(!c||typeof c!=='object')continue;
    const ty=String(c.type||'').toLowerCase();
    if(ty==='local_image'||ty==='localimage'){
      // Old rollouts have `local_image` set to 'resume', the session id and '-': built before `-i`
      // came ahead of the positionals, so exec swallowed those args. Only an absolute path + image extension
      // is an image; anything else would draw a broken image tile (the /api/file route refuses it too).
      const p=typeof c.path==='string'?c.path.trim():'';
      if(p&&nodePath.isAbsolute(p)&&/\.(png|jpe?g|gif|webp)$/i.test(p))out.push(p);
    } else if(ty==='image'||ty==='input_image'){
      const src=String(c.image_url||c.url||c.data||'').trim();
      if(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(src)&&src.length<=MAX_INLINE_IMAGE)out.push(src);
    }
  }
  return out;
}
function commandOf(item:any):string{
  const c=item?.command;
  if(Array.isArray(c))return c.map((x:any)=>String(x)).join(' ');
  if(typeof c==='string')return c;
  const parsed=item?.parsed_cmd;
  if(Array.isArray(parsed)&&parsed.length&&typeof parsed[0]?.cmd==='string')return parsed[0].cmd;
  return '';
}
function outputOf(item:any):string{
  const raw=item?.aggregated_output??item?.stdout??item?.output??'';
  const err=item?.stderr;
  const text=String(raw)+(err&&typeof err==='string'&&err.trim()?`\n${err}`:'');
  return text.slice(0,65536);
}

export function isCodexHistoryItem(r:any):boolean{
  return r?.type==='event_msg'&&r?.payload?.type==='item_completed'&&!!r.payload.item;
}

/** One rollout record -> 0..n DevHubEvent. */
export function parseCodexHistoryRecord(r:any):DevHubEvent[]{
  const out:DevHubEvent[]=[];
  const p=r?.payload; if(!p)return out;
  const t=timestampOf(r,Date.now());

  if(p.type==='item_completed'&&p.item){
    const item=p.item; const kind=String(item.type||'');
    if(codexAgentItemKind(item)){
      const agent=codexAgentEvent(item,t); if(agent)out.push(agent); return out;
    }
    if(kind==='UserMessage'){
      const text=textOf(item.content);
      const images=userImagesOf(item.content);
      // An image-only message used to be dropped entirely by `text.trim()` — reopening the transcript left no trace.
      if(text.trim()||images.length)out.push({type:'user_message',text,...(images.length?{images}:{}),timestamp:t});
    } else if(kind==='AgentMessage'){
      const text=textOf(item.content);
      if(text.trim())out.push({type:'assistant_message',text,timestamp:t});
    } else if(kind==='CommandExecution'){
      out.push({type:'command_completed',command:commandOf(item),
        exitCode:item.exit_code??item.exitCode,output:outputOf(item),timestamp:t});
    } else if(kind==='FileChange'){
      out.push(...codexFileChangeEvents(item,t));
    } else if(kind.toLowerCase()==='extension'){
      const image=codexImageEvent(item,t);
      if(image)out.push(image);
      else out.push({type:'tool_completed',tool:String(item.kind||'extension'),
        label:String(item.query||item.action?.query||''),timestamp:t});
    } else if(kind==='McpToolCall'){
      out.push(codexMcpToolEvent(item,t,item.id?String(item.id):undefined));
    } else if(kind==='Error'){
      out.push({type:'error',message:String(item.message||'Codex error'),timestamp:t});
    }
    // Reasoning/ContextCompaction/TodoList… nothing worth showing in the transcript.
    return out;
  }

  if(p.type==='token_count'){
    const info=p.info||{};
    // Use the latest model call; total_token_usage accumulates repeated input across calls.
    const used=info.last_token_usage?.total_tokens;
    const win=info.model_context_window;
    const usage:any={};
    const total=info.total_token_usage||{};
    for(const [source,target] of [['input_tokens','inputTokens'],['cached_input_tokens','cachedInputTokens'],['cache_write_input_tokens','cacheWriteInputTokens'],['output_tokens','outputTokens'],['reasoning_output_tokens','reasoningOutputTokens']] as const){
      if(Number.isFinite(total[source]))usage[target]=total[source];
    }
    // The quota window may change with the plan: don't assume primary is 5 hours.
    const limits=p.rate_limits;
    if(limits&&(!limits.limit_id||limits.limit_id==='codex'))for(const w of [limits.primary,limits.secondary]){
      const key=w?.window_minutes===300?'quota5h':w?.window_minutes===10080?'quota7d':undefined;
      if(!key||typeof w.used_percent!=='number'||!Number.isFinite(w.used_percent)||w.used_percent<0||w.used_percent>100)continue;
      usage[key+'UsedPercentage']=w.used_percent;
      usage[key+'ObservedAt']=timestampOf(r,0);
      usage[key+'Authoritative']=true;
      if(typeof w.resets_at==='number'&&Number.isFinite(w.resets_at)&&w.resets_at>0)usage[key+'ResetsAt']=w.resets_at*1000;
    }
    // 0 is a REAL value right after compaction; dropping it would empty the context ring for no reason.
    if(Number.isFinite(used)&&used>=0)usage.contextUsedTokens=used;
    if(Number.isFinite(win)&&win>0)usage.contextWindowTokens=win;
    if(Object.keys(usage).length)out.push({type:'usage',usage,timestamp:t});
    return out;
  }

  if(p.type==='task_complete')out.push({type:'turn_done',timestamp:t});
  else if(p.type==='error')out.push({type:'error',message:String(p.message||p.error||'Codex error'),timestamp:t});
  return out;
}

/** Restore only the gauges; don't add billing counters again when opening history. */
export function codexSnapshot(events:DevHubEvent[]):UsageSnapshot{
  const usage:UsageSnapshot={};
  for(const event of events)if(event.type==='usage')for(const [key,value] of Object.entries(event.usage))
    if(value!==undefined&&(key.startsWith('context')||key.startsWith('quota')))(usage as any)[key]=value;
  return usage;
}

/** Restore counters accumulated in the rollout without adding them again to the usage Dev Hub stored. */
export function codexHistorySnapshot(events:DevHubEvent[]):UsageSnapshot{
  const usage:UsageSnapshot={...codexSnapshot(events)};
  const keys=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'] as const;
  for(const event of events)if(event.type==='usage')for(const key of keys)if(event.usage[key]!==undefined)(usage as any)[key]=event.usage[key];
  return usage;
}
