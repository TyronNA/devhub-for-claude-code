import { DevHubEvent } from '../../types';
import { ProcessRunner } from '../processRunner';

/**
 * `codex exec` has no context-compaction action — sending the string "/compact" as a prompt just
 * hands the model a meaningless sentence. Real compaction lives in the app-server: `thread/compact/start`.
 *
 * Measured on CLI 0.153.4: the request returns `{}` AT ONCE and compaction runs in the background; when done
 * `thread/status/changed` goes back to `idle` (one 22k-token compaction took ~110s). So follow the
 * notification instead of waiting for the response, and keep a timeout.
 */

export interface CompactResult { beforeTokens?:number; afterTokens?:number; contextWindow?:number; }

interface Pending { resolve:(v:any)=>void; reject:(e:Error)=>void; }

export class CodexAppServer {
  private id=0;
  private pending=new Map<number,Pending>();
  private proc:ReturnType<ProcessRunner['spawnDuplex']>|undefined;
  private onClosed?: (e:Error)=>void;
  private notifications:Array<(method:string,params:any)=>void>=[];

  constructor(private runner:ProcessRunner,private executable='codex'){}

  private send(method:string,params:any):Promise<any>{
    const id=++this.id;
    const p=new Promise<any>((resolve,reject)=>this.pending.set(id,{resolve,reject}));
    if(!this.proc?.write(JSON.stringify({jsonrpc:'2.0',id,method,params}))){
      this.pending.delete(id);
      return Promise.reject(new Error('codex app-server is not accepting input'));
    }
    return p;
  }
  private notify(method:string,params:any){ this.proc?.write(JSON.stringify({jsonrpc:'2.0',method,params})); }

  private async pump(){
    if(!this.proc)return;
    for await(const line of this.proc.stdoutLines){
      let m:any; try{m=JSON.parse(line);}catch{continue;}
      if(m?.id!==undefined&&this.pending.has(m.id)){
        const p=this.pending.get(m.id)!; this.pending.delete(m.id);
        if(m.error)p.reject(new Error(String(m.error?.message||JSON.stringify(m.error))));
        else p.resolve(m.result??{});
        continue;
      }
      if(typeof m?.method==='string')for(const fn of this.notifications)fn(m.method,m.params||{});
    }
    for(const [,p] of this.pending)p.reject(new Error('codex app-server closed'));
    this.pending.clear();
    this.onClosed?.(new Error("codex app-server closed"));
  }

  private async open(cwd:string){
    this.proc=this.runner.spawnDuplex({command:this.executable,args:['app-server'],cwd});
    void this.pump();
    await this.send('initialize',{clientInfo:{name:'devhub-vscode',title:'Dev Hub',version:'1'}});
    this.notify('initialized',{});
  }
  async close(){ const p=this.proc; this.proc=undefined; await p?.cancel(); }

  /**
   * Compact one Codex thread's context. `onEvent` gets progress so the transcript has something to show —
   * the same kind of events Claude emits for `/compact`.
   */
  async compact(threadId:string,cwd:string,onEvent:(e:DevHubEvent)=>void,
                opts:{beforeTokens?:number;timeoutMs?:number}={}):Promise<CompactResult>{
    const timeoutMs=opts.timeoutMs??15*60_000;
    // `thread/resume` does NOT return token usage (checked on 0.153.4: the thread object has no
    // `tokenUsage`), so the pre-compaction level must come from the usage Dev Hub already tracks.
    const result:CompactResult={beforeTokens:opts.beforeTokens};
    let sawActive=false;
    let settle:((v:void)=>void)|undefined; let failWith:((e:Error)=>void)|undefined;
    const finished=new Promise<void>((resolve,reject)=>{settle=resolve;failWith=reject;});
    this.notifications.push((method,params)=>{
      if(params?.threadId&&params.threadId!==threadId)return;
      if(method==='thread/tokenUsage/updated'){
        const u=params?.tokenUsage||{};
        // `total` is cumulative across the thread, not the current context size.
        const last=u.last?.totalTokens;
        if(typeof last==='number'&&Number.isFinite(last))result.afterTokens=last;
        const win=Number(u.modelContextWindow);
        if(Number.isFinite(win)&&win>0)result.contextWindow=win;
      } else if(method==='thread/status/changed'){
        const type=params?.status?.type;
        if(type==='active')sawActive=true;
        // Compaction done = back to idle AFTER having been active. The idle from the resume is ignored.
        else if(type==='idle'&&sawActive)settle?.();
      } else if(method==='thread/error'||method==='error'){
        failWith?.(new Error(String(params?.message||params?.error||'codex compact failed')));
      }
    });

    // Start the deadline before initialization; every request and the background work
    // share it. Attach rejection handlers before notifications can arrive.
    const timer:any=setTimeout(()=>failWith?.(new Error('codex compact timed out')),timeoutMs);
    timer.unref?.();
    this.onClosed=failWith;
    const step=<T>(work:Promise<T>)=>Promise.race([work,finished.then(()=>new Promise<T>(()=>{}))]);
    try{
      onEvent({type:'tool_started',tool:'Compact',label:'compacting the conversation…',timestamp:Date.now()} as DevHubEvent);
      await step(this.open(cwd));
      await step(this.send('thread/resume',{threadId,excludeTurns:true}));
      await step(this.send('thread/compact/start',{threadId}));
      await finished;
    } finally {
      clearTimeout(timer);
      this.onClosed=undefined;
      this.notifications=[];
      await this.close();
    }

    const summary=result.beforeTokens!==undefined&&result.afterTokens!==undefined
      ?`${result.beforeTokens} → ${result.afterTokens} tokens`
      :result.afterTokens!==undefined?`${result.afterTokens} tokens now`:undefined;
    onEvent({type:'tool_completed',tool:'Compact',label:'compacted',summary,timestamp:Date.now()} as DevHubEvent);
    if(result.afterTokens!==undefined)
      onEvent({type:'usage',usage:{contextUsedTokens:result.afterTokens,
        ...(result.contextWindow?{contextWindowTokens:result.contextWindow}:{})},timestamp:Date.now()});
    return result;
  }
}
