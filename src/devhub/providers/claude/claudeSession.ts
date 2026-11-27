import { DevHubEvent, UsageInsights, UsageInsightWindow, UsageSnapshot } from '../../types';
import { DuplexProcess, ProcessRunner } from '../processRunner';
import { ClaudeEventParser, extractClaudeSessionId } from './claudeEventParser';

export interface PermissionRequest {
  requestId:string; toolName:string; displayName?:string; description?:string; input:any;
  /** CLI đánh dấu request phải có người trả lời (AskUserQuestion) — hạn chờ khác hẳn duyệt tool. */
  requiresUserInteraction?:boolean;
}
export type PermissionDecision={behavior:'allow';updatedInput?:any}|{behavior:'deny';message?:string};
export interface SessionOptions { model?:string; effort?:string; permissionMode?:string; appendSystemPrompt?:string; autoCompact?:string; strictMcpConfig?:boolean; artifacts?:boolean; promptCacheTtl?:'5m'|'1h'; }

/** `rate_limit_event` chỉ có ở chế độ stream-json hai chiều — thay hẳn cho việc gọi `/usage`. */
export function quotaFromRateLimit(info:any,now=Date.now()):UsageSnapshot{
  const w=info?.unifiedWindows; if(!w)return {};
  const out:UsageSnapshot={};
  const put=(win:any,pct:'quota5hUsedPercentage'|'quota7dUsedPercentage',at:'quota5hResetsAt'|'quota7dResetsAt',
             obs:'quota5hObservedAt'|'quota7dObservedAt',auth:'quota5hAuthoritative'|'quota7dAuthoritative')=>{
    if(!win||typeof win.utilization!=='number')return;
    out[pct]=Math.round(win.utilization*1000)/10;   // 0.02 -> 2
    out[obs]=now; out[auth]=true;
    if(typeof win.resetsAt==='number')out[at]=win.resetsAt*1000;  // epoch giây -> ms
  };
  put(w.five_hour,'quota5hUsedPercentage','quota5hResetsAt','quota5hObservedAt','quota5hAuthoritative');
  put(w.seven_day,'quota7dUsedPercentage','quota7dResetsAt','quota7dObservedAt','quota7dAuthoritative');
  // `unifiedWindows` là TOÀN BỘ trạng thái account ("windows absent from the account state are
  // absent here"): window vắng = account không có/đã reset. Mọi chỗ merge usage đều spread, nên
  // phải ghi `null` — bỏ trống thì 7d=100% của acc cũ dính mãi trên session đã đổi acc.
  if(Object.keys(out).length)for(const k of ['5h','7d'])if(out[`quota${k}ObservedAt`]===undefined)
    Object.assign(out,{[`quota${k}UsedPercentage`]:null,[`quota${k}ResetsAt`]:null,[`quota${k}Authoritative`]:null,[`quota${k}ObservedAt`]:now});
  return out;
}

/**
 * `get_usage` (control request của CLI, SDK gọi là `usage_EXPERIMENTAL_…`): phần `behaviors` là
 * đặc điểm usage 24h/7d mà extension chính thức vẽ thành "N% of your usage was while 4+ sessions
 * ran in parallel". Chỉ giữ thứ card cần — payload đủ còn kèm cả danh sách slash command.
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
/** Số liệu của cả tài khoản, không của session: mọi tab dùng chung một nhịp hỏi. */
const INSIGHTS_EVERY_MS=5*60_000;
let insightsAskedAt=0;
export function resetInsightsThrottle(){insightsAskedAt=0;}

type Sink=(e:DevHubEvent)=>void;

/**
 * Một process `claude` sống suốt phiên. Lượt sau đẩy JSON qua stdin thay vì spawn lại
 * (~1,2s mỗi lượt), và nhờ đó gắn được `--permission-prompt-tool stdio`.
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
   * Lượt do CHÍNH CLI mở sau khi `result` đã phát: task nền chạy xong, CLI nạp một
   * `<task-notification>` vào hàng chờ của nó rồi chạy tiếp một lượt báo cáo — đo được trên
   * 2.1.272 với đúng bộ cờ ở đây (`task_updated` → `task_notification` → `init` → lượt mới).
   * Sink của lượt cũ thì generator đã return, nên mọi thứ sau `result` phải đi đường riêng;
   * không có nó, câu trả lời có thật vẫn tới stdout rồi rơi xuống sàn và tab đứng im.
   */
  private idleSink:Sink|undefined;
  private inTurn=false;
  /**
   * Đang tự đóng. Hai ý định KHÁC hẳn nhau, gộp một cờ là chỗ lượt chết im lặng:
   * `interrupt` là người dùng bấm dừng — lượt coi như kết thúc, manager ghi `cancelled`.
   * `reclaim` là `close()`: hết hạn idle hoặc tắt extension thu hồi process. Lượt đang chạy
   * mà resolve ở đây thì nó về `done` với ĐÚNG KHÔNG một chữ nào — nhắn xong thấy báo xong
   * mà chẳng biết vì sao. Nó phải fail kèm lý do.
   */
  private closing:''|'interrupt'|'reclaim'='';
  /** Chỉ giữ đuôi để chẩn đoán khi process chết — stderr của lượt dài có thể rất lớn. */
  private stderrTail:string[]=[];
  slashCommands:string[]=[];
  /** Số task nền CLI đang giữ, theo `background_tasks_changed`. Còn >0 là còn báo cáo sẽ tới. */
  backgroundTasks=0;
  /**
   * Lượt CLI tự mở đang chạy — cùng định nghĩa với `SessionManager.ingestOutOfTurn` (event
   * ngoài lượt mở, `turn_done`/`error` đóng) để hai bên không lệch nhau. Lượt này không nằm
   * trong `busy` của provider: idle timer phải hỏi cờ này, không thì nó đóng process giữa lượt.
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
    // CLI cũ: `--append-system-prompt` tự tắt prompt snapshot, tức mọi chat cũ đổi system prompt
    // ngay ở lần resume kế. `--help` của 2.1.283 ghi `on` là mặc định kể cả khi có append — cờ thừa
    // ở bản mới nhưng giữ cho CLI cũ. Chat mới ghi snapshot ĐÃ gồm phần append, chat cũ gửi nguyên
    // bản ghi sẵn có (append chỉ vào sau khi nén).
    if(this.opts.appendSystemPrompt)args.push('--append-system-prompt',this.opts.appendSystemPrompt,'--system-prompt-snapshot','on');
    if(this.opts.autoCompact)args.push('--autocompact',this.opts.autoCompact);
    // Mỗi process claude tự dựng cây MCP riêng (playwright-mcp = 2 process node cho MỖI tab).
    // Cờ này chỉ nạp server từ `--mcp-config`, mà ta không truyền cái nào — tức không nạp gì.
    if(this.opts.strictMcpConfig)args.push('--strict-mcp-config');
    /**
     * CLI tự tắt Artifact khi thấy mình chạy dưới SDK — mà Dev Hub spawn đúng kiểu đó
     * (`--input-format stream-json`), nên chat ở đây không publish được trang nào trong khi
     * cùng cái CLI ở terminal thì publish bình thường. `CLAUDE_CODE_ARTIFACT` truthy là
     * đường opt-in ngược lại mặc định đó; để trống thì giữ nguyên hành vi mặc định của CLI.
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

  /** Không consume stderr thì hàng chờ phình theo log của process sống lâu. */
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
        // `result` của lượt CLI tự mở không kết thúc lượt nào của ta — resolve ở đó là báo
        // xong cho một lượt đã xong từ lâu, hoặc cho lượt kế vừa gửi.
        if(raw?.type==='result'&&this.inTurn){this.inTurn=false;const done=this.turnDone;this.turnDone=undefined;this.turnFail=undefined;done?.();this.askInsights();}
      }
    }finally{
      this.pumping=false;this.inTurn=false;
      // stdout đóng mà chưa có `result` = process chết giữa lượt. Resolve ở đây sẽ
      // báo done cho một lượt chưa hề chạy xong; phải cho nó fail.
      const fail=this.turnFail,done=this.turnDone;
      this.turnFail=undefined;this.turnDone=undefined;
      if(this.closing==='reclaim'&&fail)fail(new Error('Claude process was closed while the turn was still running (idle timeout or Dev Hub shutting down) — the turn did not finish.'));
      else if(this.closing)done?.();
      else if(fail)fail(new Error(`Claude process exited before finishing the turn${this.stderrTail.length?`: ${this.stderrTail.join('\n').slice(-2000)}`:''}`));
      else done?.();
      // Process chết giữa lượt CLI tự mở: không event nào đóng lượt thì manager giữ session
      // `running` mãi, `isBusy()` true, hàng chờ không flush — tab đứng hẳn. Stop thì
      // `cancelOutOfTurn` đã tự ghi `cancelled`, không báo thêm.
      if(this.selfTurn&&this.closing!=='interrupt')
        this.emit({type:'error',message:this.closing==='reclaim'
          ?'Claude process was closed while a turn it started on its own (background task report) was still running (idle timeout or Dev Hub shutting down) — that turn did not finish.'
          :`Claude process exited during a turn it started on its own${this.stderrTail.length?`: ${this.stderrTail.join('\n').slice(-2000)}`:''}`,timestamp:Date.now()} as DevHubEvent);
      this.selfTurn=false;
      this.onClosed();
    }
  }

  /** Hỏi SAU `result`: câu trả lời mất ~1,5s (CLI gọi server), chờ nó trong lượt là kéo dài lượt. */
  private usageReq:string|undefined;
  private askInsights(){
    const now=Date.now(); if(this.usageReq||now-insightsAskedAt<INSIGHTS_EVERY_MS||!this.proc?.alive())return;
    insightsAskedAt=now; this.usageReq='devhub-usage-'+now;
    this.proc.write(JSON.stringify({type:'control_request',request_id:this.usageReq,request:{subtype:'get_usage'}}));
  }

  respond(requestId:string,decision:PermissionDecision){
    this.proc?.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:requestId,response:decision}}));
  }

  /** Chạy một lượt; resolve khi CLI phát `result`. Sự kiện đi qua `sink`. */
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
