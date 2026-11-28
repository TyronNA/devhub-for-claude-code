import { DevHubEvent } from '../../types';
function now(){return Date.now();}
/** The CLI nests errors several levels deep; pick the human-readable sentence instead of dumping the whole JSON. */
export function codexErrorText(raw:any):string{
  const e=raw?.error;
  const msg=e?.message||e?.error?.message||raw?.message;
  if(typeof msg==='string'&&msg.trim())return msg.trim();
  if(typeof e==='string'){
    try{const j=JSON.parse(e);const m=j?.error?.message||j?.message;if(m)return String(m);}catch{}
    return e;
  }
  return 'Codex turn failed';
}

const IMAGE_MIMES=['image/png','image/jpeg','image/gif','image/webp'] as const;
// Matches the cap of the paste-an-image path (webviewProtocol) — the same bytes cross postMessage, so
// there is no reason for two different numbers. Measured: the largest Codex image was 3MB.
const MAX_IMAGE_B64=12*1024*1024;

function imageMime(item:any):string{
  const explicit=String(item?.mime_type||item?.mime||item?.content_type||'').toLowerCase();
  if((IMAGE_MIMES as readonly string[]).includes(explicit))return explicit;
  const title=String(item?.title||item?.name||'').toLowerCase();
  if(/\.jpe?g$/.test(title))return 'image/jpeg';
  if(/\.gif$/.test(title))return 'image/gif';
  if(/\.webp$/.test(title))return 'image/webp';
  return 'image/png';
}

const os=require('node:os');
const nodePath=require('node:path');
/** `~/.codex/generated_images`. Also the ONLY root the webview may load image files from. */
export function codexImageRoot(codexRoot?:string):string{
  return nodePath.join(codexRoot ?? process.env.CODEX_HOME ?? nodePath.join(os.homedir(),'.codex'),'generated_images');
}
/** Codex images already sit on disk; only accept paths inside that exact folder. */
function savedImagePath(item:any,codexRoot?:string):string|undefined{
  const p=typeof item?.savedPath==='string'?item.savedPath.trim():'';
  if(!p||!nodePath.isAbsolute(p))return;
  if(!/\.(png|jpe?g|gif|webp)$/i.test(p))return;
  const root=codexImageRoot(codexRoot)+nodePath.sep;
  return nodePath.resolve(p).startsWith(root)?nodePath.resolve(p):undefined;
}

/**
 * Images measured a median 1.7MB of base64 each. Put into the event, it lives in the host cache,
 * in the webview's `state.events` and crosses postMessage — for a file that is already on disk.
 * So prefer `savedPath`; the host turns it into a webview URI when sending. Base64 is only the fallback.
 */
export function codexImageEvent(item:any,t=now(),codexRoot?:string):DevHubEvent|undefined{
  const alt0=String(item?.title||item?.name||'Generated image').trim().slice(0,200)||'Generated image';
  const saved=savedImagePath(item,codexRoot);
  if(saved)return {type:'assistant_image',path:saved,alt:alt0,timestamp:t};
  const raw=typeof item?.result==='string'?item.result.trim():'';
  if(!raw||raw.length>MAX_IMAGE_B64)return;
  const dataUri=/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(raw);
  const encoded=dataUri?dataUri[2]:raw;
  if(!/^[A-Za-z0-9+/=]+$/.test(encoded))return;
  const src=dataUri?`data:${dataUri[1].toLowerCase()};base64,${encoded}`:`data:${imageMime(item)};base64,${encoded}`;
  return {type:'assistant_image',src,alt:alt0,timestamp:t};
}

/**
 * A real FileChange carries `changes` as a MAP `path -> {type:'add'|'update'|'delete'}` (measured over
 * 157 rollout records: 100% map form, several files per record). The flat `path`+`kind` form only
 * exists in old fixtures, so it is still accepted. Shared by the live and rollout parsers — two places
 * reading it themselves is one place returning an empty path.
 */
export function codexFileChangeEvents(item:any,t=now()):DevHubEvent[]{
  const change=(raw:string):'add'|'modify'|'delete'=>{
    const s=raw.toLowerCase();
    if(s.includes('add')||s.includes('create'))return 'add';
    if(s.includes('delete')||s.includes('remove'))return 'delete';
    return 'modify';
  };
  const ch=item?.changes;
  if(ch&&!Array.isArray(ch)&&typeof ch==='object')
    return Object.keys(ch).map(path=>({type:'file_changed' as const,path:String(path),
      change:change(String(ch[path]?.type||ch[path]?.kind||ch[path]?.change||'')),timestamp:t}));
  return (Array.isArray(ch)?ch:[item]).map((c:any)=>({type:'file_changed' as const,
    path:String(c?.path||c?.file_path||''),change:change(String(c?.kind||c?.change||'')),timestamp:t}));
}

/** MCP tool: `result.content[].text` is what is worth showing; `isError` is the error, `status` is not. */
export function codexMcpToolEvent(item:any,t=now(),callId?:string):DevHubEvent{
  const parts=item?.result?.content;
  const body=Array.isArray(parts)?parts.map((c:any)=>String(c?.text||'')).filter(Boolean).join('\n'):String(item?.result||'');
  const failed=item?.result?.isError===true||item?.status==='failed';
  const summary=((failed?String(item?.error||'')||body||'failed':body).trim()).slice(0,65536);
  return {type:'tool_completed',tool:String(item?.server||'mcp'),label:String(item?.tool||item?.name||''),
    ...(summary?{summary}:{}),...(callId?{callId}:{}),timestamp:t};
}

export function parseCodexEvent(raw:any):DevHubEvent[]{
  const out:DevHubEvent[]=[]; const t=now(); if(!raw||typeof raw!=='object') return out;
  const item=raw.item;
  const callId=item&&(item.id||item.item_id)?String(item.id||item.item_id):undefined;
  // Sub-agent items arrive in both `item.started` and `item.completed`; the event itself decides
  // started vs completed row, not the raw.type name.
  if(item&&codexAgentItemKind(item)&&/^item\./.test(String(raw.type||''))){
    const agent=codexAgentEvent(item,t); if(agent)out.push(agent); return out;
  }
  if(raw.type==='item.started' && item?.type==='command_execution') out.push({type:'command_started',command:String(item.command||item.cmd||''),callId,timestamp:t});
  else if(raw.type==='item.started' && item?.type==='mcp_tool_call') out.push({type:'tool_started',tool:String(item.server||'mcp'),label:String(item.tool||item.name||''),callId,timestamp:t});
  else if(raw.type==='item.completed' && item){
    if(item.type==='agent_message') out.push({type:'assistant_message',text:String(item.text||item.message||''),timestamp:t});
    else if(String(item.type||'').toLowerCase()==='extension'){
      const image=codexImageEvent(item,t); if(image)out.push(image);
    }
    else if(item.type==='command_execution') out.push({type:'command_completed',command:String(item.command||item.cmd||''),exitCode:item.exit_code ?? item.exitCode,output:String(item.aggregated_output||item.output||'').slice(0,65536),callId,timestamp:t});
    else if(item.type==='file_change') out.push(...codexFileChangeEvents(item,t));
    else if(item.type==='mcp_tool_call') out.push(codexMcpToolEvent(item,t,callId));
  } else if(raw.type==='turn.completed'){
    const u=raw.usage||{};
    // exec reports totals across model calls in this turn, not the active context.
    // The provider reads last_token_usage from the rollout after the process exits.
    out.push({type:'usage',usage:{inputTokens:u.input_tokens,outputTokens:u.output_tokens,cachedInputTokens:u.cached_input_tokens,cacheWriteInputTokens:u.cache_write_input_tokens,reasoningOutputTokens:u.reasoning_output_tokens},timestamp:t}); out.push({type:'turn_done',timestamp:t});
  } else if(raw.type==='turn.failed' || raw.type==='error') out.push({type:'error',message:codexErrorText(raw),timestamp:t});
  return out;
}
export function extractCodexSessionId(raw:any):string|undefined { return raw?.type==='thread.started' ? raw.thread_id : undefined; }

/**
 * A Codex sub-agent (namespace `collaboration`) is a FORKED thread inside the same `codex exec`
 * process, not a child process — when the turn ends the process exits and the child gets
 * `turn_aborted: interrupted`. These two items used to match no branch in either the live parser
 * or the rollout parser, so there was no row at spawn, no row when the child died, and for the whole
 * `wait_agent` (measured: 22 minutes) the UI was completely silent. The lifecycle can't be fixed here, but
 * at least it must be VISIBLE.
 *
 * Item names differ per read path: the rollout writes `SubAgentActivity`/`CollabAgentToolCall`,
 * the exec enum also has the short form `collab_tool_call`. Normalise instead of listing every string.
 */
export function codexAgentItemKind(item:any):'subagent'|'collab'|undefined{
  const k=String(item?.type||'').toLowerCase().replace(/_/g,'');
  if(k==='subagentactivity')return 'subagent';
  if(k==='collabagenttoolcall'||k==='collabtoolcall')return 'collab';
  return undefined;
}
const AGENT_RUNNING=new Set(['started','starting','running','in_progress','inprogress','pending']);
const AGENT_DONE=new Set(['completed','failed','terminated','aborted','cancelled','canceled','yielded']);
/** One sub-agent item -> 1 DevHubEvent, or undefined if it isn't a sub-agent item. */
export function codexAgentEvent(item:any,t=now()):DevHubEvent|undefined{
  const kind=codexAgentItemKind(item); if(!kind)return;
  if(kind==='subagent'){
    const thread=String(item?.agent_thread_id||item?.agentThreadId||'');
    const state=String(item?.kind||'').toLowerCase();
    const label=String(item?.agent_path||item?.agentPath||thread||'sub-agent');
    // `started` and `completed` carry DIFFERENT `id`s (`call_…` then `subagent-completed-…`),
    // so pair the two rows by thread id — by item id they come out as two separate rows. Only pair the
    // lifecycle milestones: an `interacted` sharing the id would overwrite the `completed` row already drawn.
    const callId=thread&&(AGENT_RUNNING.has(state)||AGENT_DONE.has(state))?`subagent:${thread}`:undefined;
    // The child's thread id is a separate Codex session with its own rollout: that is what tracing needs.
    const summary=[state||'activity',thread].filter(Boolean).join(' · ');
    return AGENT_RUNNING.has(state)
      ? {type:'tool_started',tool:'Agent',label,...(callId?{callId}:{}),timestamp:t}
      : {type:'tool_completed',tool:'Agent',label,summary,...(callId?{callId}:{}),timestamp:t};
  }
  const tool=String(item?.tool||item?.name||'collab');
  const status=String(item?.status||'').toLowerCase();
  const callId=item?.id?String(item.id):undefined;
  const targets=[...(Array.isArray(item?.receiver_agents)?item.receiver_agents:[]),
    ...(Array.isArray(item?.receiver_thread_ids)?item.receiver_thread_ids:[])]
    .map((x:any)=>typeof x==='string'?x:String(x?.agent_path||x?.thread_id||'')).filter(Boolean);
  const label=[tool,...targets].join(' ');
  return AGENT_RUNNING.has(status)||!status
    ? {type:'tool_started',tool:'Agent',label,...(callId?{callId}:{}),timestamp:t}
    : {type:'tool_completed',tool:'Agent',label,summary:status,...(callId?{callId}:{}),timestamp:t};
}
