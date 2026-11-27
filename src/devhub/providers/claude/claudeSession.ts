import { DevHubEvent, UsageInsights, UsageInsightWindow, UsageSnapshot } from '../../types';
import { DuplexProcess, ProcessRunner } from '../processRunner';
import { ClaudeEventParser, extractClaudeSessionId } from './claudeEventParser';

export interface PermissionRequest {
  requestId:string; toolName:string; displayName?:string; description?:string; input:any;
  /** The CLI flags requests that need a human to answer (AskUserQuestion) — a very different wait from a tool approval. */
  requiresUserInteraction?:boolean;
}
export type PermissionDecision={behavior:'allow';updatedInput?:any}|{behavior:'deny';message?:string};
export interface SessionOptions { model?:string; effort?:string; permissionMode?:string; appendSystemPrompt?:string; autoCompact?:string; strictMcpConfig?:boolean; artifacts?:boolean; promptCacheTtl?:'5m'|'1h'; }

/** `rate_limit_event` only exists in two-way stream-json mode — it fully replaces calling `/usage`. */
export function quotaFromRateLimit(info:any,now=Date.now()):UsageSnapshot{
  const w=info?.unifiedWindows; if(!w)return {};
  const out:UsageSnapshot={};
  const put=(win:any,pct:'quota5hUsedPercentage'|'quota7dUsedPercentage',at:'quota5hResetsAt'|'quota7dResetsAt',
             obs:'quota5hObservedAt'|'quota7dObservedAt',auth:'quota5hAuthoritative'|'quota7dAuthoritative')=>{
    if(!win||typeof win.utilization!=='number')return;
    out[pct]=Math.round(win.utilization*1000)/10;   // 0.02 -> 2
    out[obs]=now; out[auth]=true;
    if(typeof win.resetsAt==='number')out[at]=win.resetsAt*1000;  // epoch seconds -> ms
  };
  put(w.five_hour,'quota5hUsedPercentage','quota5hResetsAt','quota5hObservedAt','quota5hAuthoritative');
  put(w.seven_day,'quota7dUsedPercentage','quota7dResetsAt','quota7dObservedAt','quota7dAuthoritative');
  // `unifiedWindows` is the ENTIRE account state ("windows absent from the account state are
  // absent here"): a missing window = the account doesn't have it / it was reset. Every usage merge spreads, so
  // `null` must be written — leaving it out makes the old account's 7d=100% stick forever on a session that switched accounts.
  if(Object.keys(out).length)for(const k of ['5h','7d'])if(out[`quota${k}ObservedAt`]===undefined)
    Object.assign(out,{[`quota${k}UsedPercentage`]:null,[`quota${k}ResetsAt`]:null,[`quota${k}Authoritative`]:null,[`quota${k}ObservedAt`]:now});
  return out;
}

/**
 * `get_usage` (a CLI control request, the SDK calls it `usage_EXPERIMENTAL_…`): its `behaviors` are the
 * 24h/7d usage traits the official extension draws as "N% of your usage was while 4+ sessions
 * ran in parallel". Only keep what the card needs — the full payload also carries the slash command list.
 */
export function insightsFromUsage(resp:any,now=Date.now()):UsageInsights|undefined{
  const b=resp?.behaviors; if(!b||typeof b!=='object')return undefined;
  const win=(w:any):UsageInsightWindow|undefined=>{
    if(!w||typeof w!=='object')return undefined;
    const behaviors=(Array.isArray(w.behaviors)?w.behaviors:[]).filter((x:any)=>x&&typeof x.key==='string'&&typeof x.pct==='number')
      .map((x:any)=>({key:x.key,pct:x.pct}));
    const top:{group:string;name:string;pct:number}[]=[];
    for(const g of ['agents','skills','plugins','mcp_servers']){const first=Array.isArray(w[g])?w[g][0]:undefined;
      if(first&&typeof first.name==='string'&&typeof first.pct==='number')top.push({group:g,name:first.name,pct:first.pct});}
    return {requests:typeof w.request_count==='number'?w.request_count:undefined,sessions:typeof w.session_count==='number'?w.session_count:undefined,behaviors,top};
  };
  const day=win(b.day),week=win(b.week);
  return day||week?{observedAt:now,day,week}:undefined;
}
/** Account-wide numbers, not per session: every tab shares one polling rhythm. */
const INSIGHTS_EVERY_MS=5*60_000;
let insightsAskedAt=0;
export function resetInsightsThrottle(){insightsAskedAt=0;}

type Sink=(e:DevHubEvent)=>void;

/**
 * One `claude` process lives for the whole session. Later turns push JSON over stdin instead of respawning
 * (~1.2s per turn), which is also what allows `--permission-prompt-tool stdio`.
 */
export class ClaudeSession {
  private proc:DuplexProcess|undefined;
  private parser=new ClaudeEventParser();
  private nativeId:string|undefined;
  private sink:Sink|undefined;
  private turnDone:(()=>void)|undefined;
  private turnFail:((e:Error)=>void)|undefined;
  private pumping=false;
  /**
   * A turn opened by the CLI ITSELF after `result` was emitted: a background task finished, the CLI loads a
   * `<task-notification>` into its own queue and runs a report turn — measured on
   * 2.1.272 with exactly the flags used here (`task_updated` → `task_notification` → `init` → new turn).
   * The old turn's sink generator has already returned, so everything after `result` needs its own path;
   * without it, a real answer still reaches stdout, falls on the floor, and the tab sits still.
   */
  private idleSink:Sink|undefined;
  private inTurn=false;
  /**
   * Closing itself. Two VERY different intents; merging them into one flag is where turns die silently:
   * `interrupt` is the user pressing stop — the turn counts as ended and the manager writes `cancelled`.
   * `reclaim` is `close()`: idle expiry or extension shutdown reclaiming the process. A running turn
   * resolved here would land as `done` with NOT A SINGLE word — you send a message, see it finish,
   * and never learn why. It must fail with a reason.
   */
  private closing:''|'interrupt'|'reclaim'='';
  /** Only keep the tail for diagnosis when the process dies — stderr of a long turn can be huge. */
  private stderrTail:string[]=[];
  slashCommands:string[]=[];
  /** Number of background tasks the CLI holds, per `background_tasks_changed`. >0 means reports are still coming. */
  backgroundTasks=0;
  /**
   * A CLI self-opened turn is running — same definition as `SessionManager.ingestOutOfTurn` (an event
   * outside a turn opens it, `turn_done`/`error` closes it) so the two never drift. This turn is not
   * in the provider's `busy`: the idle timer must check this flag, or it closes the process mid-turn.
   */
  selfTurn=false;

  constructor(
    private newSessionId:string|undefined,
    private runner:ProcessRunner,
    private executable:string,
    readonly cwd:string,
    private opts:SessionOptions,
    private onPermission:(req:PermissionRequest)=>void,
    private onClosed:()=>void,
  ){}

  setIdleSink(fn:Sink|undefined){this.idleSink=fn;}
  private emit(e:DevHubEvent){
    if(!this.inTurn&&e.type!=='usage')this.selfTurn=e.type!=='turn_done'&&e.type!=='error';
    (this.inTurn?this.sink:this.idleSink)?.(e);}

  matchesOptions(opts:{model?:string;effort?:string}){return this.opts.model===opts.model&&this.opts.effort===opts.effort;}

  get id(){return this.nativeId;}
  get pid(){return this.proc?.alive()?this.proc.pid:undefined;}
  alive(){return !!this.proc?.alive();}

  private start(resumeId?:string,newId?:string){
    const args=['--print','--output-format','stream-json','--input-format','stream-json','--verbose',
                '--include-partial-messages','--replay-user-messages','--permission-prompt-tool','stdio'];
    if(resumeId)args.push('--resume',resumeId); else if(newId)args.push('--session-id',newId);
    if(this.opts.permissionMode)args.push('--permission-mode',this.opts.permissionMode);
    if(this.opts.model)args.push('--model',this.opts.model);
    if(this.opts.effort)args.push('--effort',this.opts.effort);
    // Old CLIs: `--append-system-prompt` disables the prompt snapshot, meaning every old chat changes its system prompt
    // on the next resume. `--help` of 2.1.283 says `on` is the default even with append — the flag is redundant
    // on new builds but kept for old CLIs. New chats snapshot WITH the appended part, old chats send their
    // existing record as is (the append only enters after a compaction).
    if(this.opts.appendSystemPrompt)args.push('--append-system-prompt',this.opts.appendSystemPrompt,'--system-prompt-snapshot','on');
    if(this.opts.autoCompact)args.push('--autocompact',this.opts.autoCompact);
    // Every claude process builds its own MCP tree (playwright-mcp = 2 node processes for EACH tab).
    // This flag only loads servers from `--mcp-config`, and we pass none — i.e. nothing is loaded.
    if(this.opts.strictMcpConfig)args.push('--strict-mcp-config');
    /**
     * The CLI disables Artifact when it sees it is running under the SDK — and Dev Hub spawns it exactly that way
     * (`--input-format stream-json`), so chats here couldn't publish a page while
     * the same CLI in a terminal publishes normally. A truthy `CLAUDE_CODE_ARTIFACT` is
     * the opt-in that reverses that default; leaving it empty keeps the CLI's default behaviour.
     */
    const envOverrides:any={};
    if(this.opts.artifacts)envOverrides.CLAUDE_CODE_ARTIFACT='1';
    if(this.opts.promptCacheTtl)envOverrides.CLAUDE_CODE_PROMPT_CACHE_TTL=this.opts.promptCacheTtl;
    const env=Object.keys(envOverrides).length?{...process.env,...envOverrides}:undefined;
    this.proc=this.runner.spawnDuplex({command:this.executable,args,cwd:this.cwd,env});
    this.nativeId=resumeId??newId??this.nativeId;
    this.stderrTail=[];
    void this.drainStderr(this.proc);
    void this.pump();
  }

  /** Without consuming stderr the buffer grows with the logs of a long-lived process. */
  private async drainStderr(p:DuplexProcess){
    try{ for await(const line of p.stderrLines){ this.stderrTail.push(line); if(this.stderrTail.length>50)this.stderrTail.shift(); } }catch{}
  }

  private async pump(){
    if(this.pumping||!this.proc)return; this.pumping=true;
    const p=this.proc;
    try{
      for await(const line of p.stdoutLines){
        let raw:any; try{raw=JSON.parse(line);}catch{continue;}
        this.nativeId=extractClaudeSessionId(raw)||this.nativeId;
        if(raw?.type==='system'&&raw.subtype==='init'&&Array.isArray(raw.slash_commands))
          this.slashCommands=raw.slash_commands.filter((x:any)=>typeof x==='string');
        if(raw?.type==='control_request'&&raw.request?.subtype==='can_use_tool'){
          this.onPermission({requestId:String(raw.request_id),toolName:String(raw.request.tool_name||'tool'),
            displayName:raw.request.display_name,description:raw.request.description,input:raw.request.input,
            requiresUserInteraction:!!raw.request.requires_user_interaction});
          continue;
        }
        if(raw?.type==='system'&&raw.subtype==='background_tasks_changed')
          this.backgroundTasks=Array.isArray(raw.tasks)?raw.tasks.length:0;
        if(raw?.type==='control_response'&&raw.response?.request_id===this.usageReq){
          this.usageReq=undefined;
          const ins=raw.response.subtype==='success'?insightsFromUsage(raw.response.response):undefined;
          if(ins)this.emit({type:'usage',usage:{usageInsights:ins},timestamp:Date.now()});
          continue;
        }
        if(raw?.type==='rate_limit_event'){
          const q=quotaFromRateLimit(raw.rate_limit_info);
          if(Object.keys(q).length)this.emit({type:'usage',usage:q,timestamp:Date.now()} as DevHubEvent);
          continue;
        }
        for(const ev of this.parser.parse(raw))this.emit(ev);
        // The `result` of a CLI self-opened turn ends none of our turns — resolving there would report
        // done for a turn that finished long ago, or for the next turn just sent.
        if(raw?.type==='result'&&this.inTurn){this.inTurn=false;const done=this.turnDone;this.turnDone=undefined;this.turnFail=undefined;done?.();this.askInsights();}
      }
    }finally{
      this.pumping=false;this.inTurn=false;
      // stdout closed with no `result` = the process died mid-turn. Resolving here would
      // report done for a turn that never finished; it has to fail.
      const fail=this.turnFail,done=this.turnDone;
      this.turnFail=undefined;this.turnDone=undefined;
      if(this.closing==='reclaim'&&fail)fail(new Error('Claude process was closed while the turn was still running (idle timeout or Dev Hub shutting down) — the turn did not finish.'));
      else if(this.closing)done?.();
      else if(fail)fail(new Error(`Claude process exited before finishing the turn${this.stderrTail.length?`: ${this.stderrTail.join('\n').slice(-2000)}`:''}`));
      else done?.();
      // The process died during a CLI self-opened turn: with no event closing the turn the manager keeps the session
      // `running` forever, `isBusy()` stays true and the queue never flushes — the tab freezes. On Stop,
      // `cancelOutOfTurn` already wrote `cancelled`, so report nothing more.
      if(this.selfTurn&&this.closing!=='interrupt')
        this.emit({type:'error',message:this.closing==='reclaim'
          ?'Claude process was closed while a turn it started on its own (background task report) was still running (idle timeout or Dev Hub shutting down) — that turn did not finish.'
          :`Claude process exited during a turn it started on its own${this.stderrTail.length?`: ${this.stderrTail.join('\n').slice(-2000)}`:''}`,timestamp:Date.now()} as DevHubEvent);
      this.selfTurn=false;
      this.onClosed();
    }
  }

  /** Asked AFTER `result`: the answer takes ~1.5s (the CLI calls the server); waiting for it inside the turn would lengthen the turn. */
  private usageReq:string|undefined;
  private askInsights(){
    const now=Date.now(); if(this.usageReq||now-insightsAskedAt<INSIGHTS_EVERY_MS||!this.proc?.alive())return;
    insightsAskedAt=now; this.usageReq='devhub-usage-'+now;
    this.proc.write(JSON.stringify({type:'control_request',request_id:this.usageReq,request:{subtype:'get_usage'}}));
  }

  respond(requestId:string,decision:PermissionDecision){
    this.proc?.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:requestId,response:decision}}));
  }

  /** Runs one turn; resolves when the CLI emits `result`. Events go through `sink`. */
  async send(prompt:string,sink:Sink,resumeId?:string):Promise<void>{
    if(!this.proc?.alive()){this.closing='';this.start(resumeId??this.nativeId,this.newSessionId);}
    this.sink=sink;
    const finished=new Promise<void>((resolve,reject)=>{this.turnDone=resolve;this.turnFail=reject;});
    this.inTurn=true;
    const ok=this.proc!.write(JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:prompt}]}}));
    if(!ok){this.inTurn=false;this.turnDone=undefined;this.turnFail=undefined;throw new Error('Claude session is not accepting input');}
    await finished;
  }

  async interrupt(){this.closing='interrupt';await this.proc?.cancel();}
  async close(){this.closing='reclaim';await this.proc?.cancel();this.proc=undefined;}
}
