const crypto = require('node:crypto');
import { AgentProvider, ProviderTurnHandle, StartSessionInput, ResumeSessionInput } from '../provider';
import { ProcessRunner } from '../processRunner';
import { DevHubEvent, DevHubProject, DevHubSession } from '../../types';
import { ClaudeEventParser, extractClaudeSessionId } from './claudeEventParser';
import { ClaudeFileFacts, discoverClaudeHistory, findClaudeTranscript, loadClaudeTranscript } from './claudeHistory';
import { HistoryScanCache } from '../historyUtils';
import { ClaudeSession, PermissionRequest, PermissionDecision } from './claudeSession';
import { isUnder } from './claudeAccount';

/** Claude không có cờ `--image` cho stream-json; nó đọc file bằng tool Read, nên đường dẫn
 *  đi kèm prompt là cách gắn ảnh khả dụng. */
export function withImages(prompt:string,images?:string[]){
  return images&&images.length?[...images,prompt].filter(Boolean).join('\n'):prompt;
}

/**
 * Hàm nghịch của `withImages`: transcript đọc lại chỉ còn mấy dòng path trần ở đầu prompt,
 * tách chúng về `images` để bong bóng vẽ lại ảnh. Ở cạnh `withImages` vì hai hàm phải đổi
 * cùng nhau — panel và trang mobile đều gọi hàm này, tự viết lại là một chỗ quên.
 * Không stat file: ảnh bị dọn theo TTL thì `alt` (tên file) là thứ đúng để hiện.
 */
export function recoverImages(event:any,attachmentRoot:string){
  if(event?.type!=='user_message'||event.images||typeof event.text!=='string')return event;
  const lines=event.text.split('\n');const images:string[]=[];
  while(lines.length&&lines[0].startsWith(attachmentRoot)&&/\.(png|jpe?g|gif|webp)$/i.test(lines[0]))images.push(lines.shift()!);
  return images.length?{...event,text:lines.join('\n'),images}:event;
}

export class ClaudeProvider implements AgentProvider {
  readonly id='claude' as const; private availableCache:{at:number;value:boolean}|undefined; private transcriptIndex=new Map<string,string>(); private scanCache=new HistoryScanCache<ClaudeFileFacts>();
  constructor(private runner:ProcessRunner, private executable='claude', private maxHistory=1500,private historyRoot?:string, private permissionMode?:string, private appendSystemPrompt?:string, private idleTtlMs=30*60*1000, private autoCompact?:string, private strictMcpConfig?:boolean, private artifacts?:boolean, private promptCacheTtl?:'5m'|'1h'){}
  async isAvailable(){ if(this.availableCache&&Date.now()-this.availableCache.at<60000)return this.availableCache.value; const value=await this.runner.isAvailable(this.executable); this.availableCache=value?{at:Date.now(),value}:undefined; return value; } // không cache false: một lần hụt không được chặn mọi lượt trong 60s
  async start(input:StartSessionInput){ const id=crypto.randomUUID(); return this.launch(input.cwd,withImages(input.prompt,input.images),id,undefined,input); }
  async resume(input:ResumeSessionInput){ return this.launch(input.session.cwd,withImages(input.prompt,input.images),input.session.nativeSessionId,input.session.nativeSessionId,input); }
  /** Một ClaudeSession cho mỗi nativeSessionId; process sống tới khi đóng. */
  private sessions=new Map<string,ClaudeSession>();
  private idleTimers=new Map<string,any>();
  /** Session đang chạy một lượt. Giữ theo object nên rekey (`draft` -> id thật) không mất dấu. */
  private busy=new Set<ClaudeSession>();
  /**
   * Mỗi session giữ một process `claude` (đo được 120-270MB, trung bình ~200MB). Không cap
   * số tab, nhưng phải thu hồi khi bỏ không.
   * "Idle" tính từ lúc lượt KẾT THÚC — hẹn giờ trong lúc đang chạy sẽ kill process giữa lượt
   * khi lượt dài hơn TTL (mặc định 30 phút).
   */
  private touch(key:string){
    const old=this.idleTimers.get(key); if(old)clearTimeout(old);
    this.idleTimers.delete(key);
    if(this.idleTtlMs<=0)return;
    const live=this.sessions.get(key);
    if(live&&this.busy.has(live))return;
    const t:any=setTimeout(()=>{this.idleTimers.delete(key);
      // Task nền còn chạy: thu hồi process lúc này là vứt luôn lượt báo cáo CLI sẽ tự mở khi
      // nó xong. Job dựng ảnh chạy cả tiếng vượt TTL rất dễ, nên hẹn lại chứ không đóng.
      // Task xong thì `backgroundTasks` về 0 NGAY lúc CLI mở lượt báo cáo — lượt đó không có
      // trong `busy`, nên phải hỏi thêm `selfTurn`: transcript thật có lượt bị giết đúng 1800s/3600s.
      const s=this.sessions.get(key);
      if(s&&s.alive()&&(s.backgroundTasks>0||s.selfTurn)){this.touch(key);return;}
      this.closeSession(key);},this.idleTtlMs);
    t.unref?.();  // đừng giữ event loop sống chỉ vì một timer nhàn rỗi
    this.idleTimers.set(key,t);
  }
  dispose(){for(const t of this.idleTimers.values())clearTimeout(t);this.idleTimers.clear();this.busy.clear();
    for(const s of this.sessions.values())void s.close(); this.sessions.clear();}
  private permissionSink?:(p:PermissionRequest&{sessionId:string})=>void;
  setPermissionSink(fn:(p:PermissionRequest&{sessionId:string})=>void){this.permissionSink=fn;}
  /**
   * Sự kiện tới NGOÀI lượt: CLI tự mở lượt báo cáo khi một task nền xong. Lúc đó không còn
   * `ProviderTurnHandle` nào sống để nhận, nên nó phải đi thẳng lên manager kèm session id.
   */
  private idleEventSink?:(sessionId:string,event:DevHubEvent)=>void;
  setIdleEventSink(fn:(sessionId:string,event:DevHubEvent)=>void){this.idleEventSink=fn;}
  answerPermission(sessionId:string,requestId:string,decision:PermissionDecision){
    this.sessions.get(sessionId)?.respond(requestId,decision);
  }
  /** Slash command là cấu hình của người dùng, không thuộc riêng session nào — nhớ lại
   *  lần đầu bất kỳ session nào khai báo, để tab đã đóng/khôi phục vẫn dùng được. */
  private knownSlash:string[]=[];
  /** Lưu qua Reload Window: sau reload `sessions` rỗng nên cache RAM mất, `/` chết cho tới lượt kế. */
  private persistSlash?:(v:string[])=>void;
  setSlashStore(load:()=>string[],save:(v:string[])=>void){
    if(!this.knownSlash.length)this.knownSlash=load()||[];
    this.persistSlash=save;
  }
  slashCommands(id?:string):string[]{
    const live=id?this.sessions.get(id)?.slashCommands:undefined;
    let found=live&&live.length?live:undefined;
    if(!found)for(const s of this.sessions.values())if(s.slashCommands.length){found=s.slashCommands;break;}
    if(found&&found.join('\u0000')!==this.knownSlash.join('\u0000')){this.knownSlash=found;this.persistSlash?.(found);}
    return this.knownSlash;
  }
  /** pid của mọi session còn giữ process — cây hỏi cái này để cộng RAM. */
  livePids():number[]{const out:number[]=[];for(const s of this.sessions.values()){const pid=s.pid;if(pid)out.push(pid);}return out;}
  /**
   * Đổi acc của một project: process đang sống vẫn giữ token lúc spawn. Không đóng ngay — có thể
   * đang giữa lượt (kể cả lượt tự mở) — mà đánh dấu, lượt kế đóng rồi spawn lại qua wrapper
   * với `--resume`, y như đổi model.
   */
  private retired=new WeakSet<ClaudeSession>();
  retireUnder(root:string){let n=0;for(const s of this.sessions.values())if(isUnder(s.cwd,root)){this.retired.add(s);n++;}return n;}
  closeSession(id:string){const t=this.idleTimers.get(id);if(t)clearTimeout(t);this.idleTimers.delete(id);const s=this.sessions.get(id);this.sessions.delete(id);if(s)this.busy.delete(s);void s?.close();}

  /** Nút dừng trên một lượt CLI tự mở: manager không có handle nào để gọi, phải với thẳng
   *  vào session đang giữ process. Không có cái này thì `cancel()` return im lặng. */
  async interruptOutOfTurn(nativeId:string){
    // Tra cả theo `s.id`: rekey chỉ chạy ở `result` của lượt đầu, id thật CLI khai sau đó
    // là id manager biết mà map vẫn còn giữ key cũ.
    let key=nativeId,s=this.sessions.get(key);
    if(!s)for(const [k,v] of this.sessions)if(v.id===nativeId){key=k;s=v;break;}
    if(!s||!s.alive())return false;
    const t=this.idleTimers.get(key); if(t)clearTimeout(t); this.idleTimers.delete(key);
    this.busy.delete(s); await s.interrupt(); return true;
  }

  private async launch(cwd:string,prompt:string,knownId:string,resumeId?:string,opts:{model?:string;effort?:string}={}):Promise<ProviderTurnHandle>{
    const key=resumeId??knownId;
    let session=this.sessions.get(key);
    if(session&&(!session.matchesOptions(opts)||this.retired.has(session))){
      if(this.busy.has(session))throw new Error("Cannot change options during a running turn");
      this.retired.delete(session);await session.close();
      session=undefined;
    }
    if(!session||!session.alive()){
      session=new ClaudeSession(resumeId?undefined:knownId,this.runner,this.executable,cwd,
        {model:opts.model,effort:opts.effort,permissionMode:this.permissionMode,appendSystemPrompt:this.appendSystemPrompt,autoCompact:this.autoCompact,strictMcpConfig:this.strictMcpConfig,artifacts:this.artifacts,promptCacheTtl:this.promptCacheTtl},
        req=>this.permissionSink?.({...req,sessionId:session!.id??key}),
        ()=>{ if(session&&this.sessions.get(key)===session&&!session.alive())this.sessions.delete(key); });
      // Đọc `s.id` lúc phát chứ không chụp trước: lượt đầu rekey từ `pending:` sang id thật.
      const s=session; s.setIdleSink(e=>this.idleEventSink?.(s.id??key,e));
      this.sessions.set(key,session);
    }
    const live=session; this.busy.add(live); this.touch(key);
    const queue:DevHubEvent[]=[]; let waiter:(()=>void)|undefined; let ended=false;
    const push=(e:DevHubEvent)=>{queue.push(e);const w=waiter;waiter=undefined;w?.();};
    const run=live.send(prompt,push,resumeId).catch((e:any)=>{
      push({type:'error',message:`Claude failed: ${e?.message||e}`,timestamp:Date.now()} as DevHubEvent);
    }).finally(()=>{ended=true;this.busy.delete(live);
      // touch theo KEY, không theo id thật: lúc này map chưa rekey, nên `touch(live.id)` sẽ
      // hẹn giờ trên session KHÁC đang giữ id đó. `run.then` bên dưới touch lại sau khi rekey.
      this.touch(key);const w=waiter;waiter=undefined;w?.();});

    const events=(async function*(){
      while(true){
        while(queue.length)yield queue.shift() as DevHubEvent;
        if(ended){while(queue.length)yield queue.shift() as DevHubEvent;return;}
        await new Promise<void>(r=>{waiter=r;});
      }
    })();
    // Rekey khi CLI cấp session id thật cho lượt đầu.
    void run.then(()=>{const real=live.id;
      if(real&&real!==key&&!this.sessions.has(real)){
        this.sessions.delete(key);this.sessions.set(real,live);
        // Dời luôn hẹn giờ, nếu không nó fire trên key đã chết và session mới sống vô hạn.
        const t=this.idleTimers.get(key);if(t)clearTimeout(t);this.idleTimers.delete(key);
        this.touch(real);
      }});
    return {events,cancel:async()=>{await live.interrupt();},getNativeSessionId:()=>live.id??key};
  }
  discoverHistory(projects:DevHubProject[]){return discoverClaudeHistory(projects,this.historyRoot,this.maxHistory,this.transcriptIndex,this.scanCache);}
  async loadTranscript(session:DevHubSession){let f=this.transcriptIndex.get(session.nativeSessionId);if(!f){f=await findClaudeTranscript(session.nativeSessionId,this.historyRoot,this.maxHistory);if(f)this.transcriptIndex.set(session.nativeSessionId,f);} if(!f) throw new Error('Claude transcript not found'); return loadClaudeTranscript(f);}
}
