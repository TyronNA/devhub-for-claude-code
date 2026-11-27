const crypto = require('node:crypto');
import { AgentProvider, ProviderTurnHandle, StartSessionInput, ResumeSessionInput } from '../provider';
import { ProcessRunner } from '../processRunner';
import { DevHubEvent, DevHubProject, DevHubSession } from '../../types';
import { ClaudeEventParser, extractClaudeSessionId } from './claudeEventParser';
import { ClaudeFileFacts, discoverClaudeHistory, findClaudeTranscript, loadClaudeTranscript } from './claudeHistory';
import { HistoryScanCache } from '../historyUtils';
import { ClaudeSession, PermissionRequest, PermissionDecision } from './claudeSession';
import { isUnder } from './claudeAccount';

/** Claude has no `--image` flag for stream-json; it reads files with the Read tool, so a path
 *  sent along with the prompt is the workable way to attach an image. */
export function withImages(prompt:string,images?:string[]){
  return images&&images.length?[...images,prompt].filter(Boolean).join('\n'):prompt;
}

/**
 * Inverse of `withImages`: a re-read transcript only has a few bare path lines at the start of the prompt;
 * split them back into `images` so the bubble redraws the images. It sits next to `withImages` because the two must change
 * together — both the panel and the mobile page call this, and rewriting it is one more place to forget.
 * Doesn't stat the file: if an image was cleaned up by TTL, `alt` (the file name) is the right thing to show.
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
  async isAvailable(){ if(this.availableCache&&Date.now()-this.availableCache.at<60000)return this.availableCache.value; const value=await this.runner.isAvailable(this.executable); this.availableCache=value?{at:Date.now(),value}:undefined; return value; } // don't cache false: one miss must not block every turn for 60s
  async start(input:StartSessionInput){ const id=crypto.randomUUID(); return this.launch(input.cwd,withImages(input.prompt,input.images),id,undefined,input); }
  async resume(input:ResumeSessionInput){ return this.launch(input.session.cwd,withImages(input.prompt,input.images),input.session.nativeSessionId,input.session.nativeSessionId,input); }
  /** One ClaudeSession per nativeSessionId; the process lives until closed. */
  private sessions=new Map<string,ClaudeSession>();
  private idleTimers=new Map<string,any>();
  /** Sessions running a turn. Held by object so a rekey (`draft` -> real id) doesn't lose track. */
  private busy=new Set<ClaudeSession>();
  /**
   * Each session keeps one `claude` process (measured 120-270MB, ~200MB on average). The number of tabs
   * isn't capped, but idle ones must be reclaimed.
   * "Idle" counts from when the turn ENDS — a timer armed while running would kill the process mid-turn
   * when the turn outlasts the TTL (30 minutes by default).
   */
  private touch(key:string){
    const old=this.idleTimers.get(key); if(old)clearTimeout(old);
    this.idleTimers.delete(key);
    if(this.idleTtlMs<=0)return;
    const live=this.sessions.get(key);
    if(live&&this.busy.has(live))return;
    const t:any=setTimeout(()=>{this.idleTimers.delete(key);
      // A background task is still running: reclaiming the process now throws away the report turn the CLI opens by itself when
      // it finishes. An image-building job running for an hour easily outlasts the TTL, so re-arm rather than close.
      // When a task finishes, `backgroundTasks` drops to 0 the MOMENT the CLI opens the report turn — that turn isn't
      // in `busy`, so `selfTurn` must be checked too: real transcripts had turns killed at exactly 1800s/3600s.
      const s=this.sessions.get(key);
      if(s&&s.alive()&&(s.backgroundTasks>0||s.selfTurn)){this.touch(key);return;}
      this.closeSession(key);},this.idleTtlMs);
    t.unref?.();  // don't keep the event loop alive just for an idle timer
    this.idleTimers.set(key,t);
  }
  dispose(){for(const t of this.idleTimers.values())clearTimeout(t);this.idleTimers.clear();this.busy.clear();
    for(const s of this.sessions.values())void s.close(); this.sessions.clear();}
  private permissionSink?:(p:PermissionRequest&{sessionId:string})=>void;
  setPermissionSink(fn:(p:PermissionRequest&{sessionId:string})=>void){this.permissionSink=fn;}
  /**
   * Events arriving OUTSIDE a turn: the CLI opens a report turn by itself when a background task finishes. There is no
   * live `ProviderTurnHandle` left to receive it, so it goes straight up to the manager with the session id.
   */
  private idleEventSink?:(sessionId:string,event:DevHubEvent)=>void;
  setIdleEventSink(fn:(sessionId:string,event:DevHubEvent)=>void){this.idleEventSink=fn;}
  answerPermission(sessionId:string,requestId:string,decision:PermissionDecision){
    this.sessions.get(sessionId)?.respond(requestId,decision);
  }
  /** Slash commands are the user's configuration, not tied to any session — remember them
   *  the first time any session declares them, so closed/restored tabs can still use them. */
  private knownSlash:string[]=[];
  /** Persisted across Reload Window: after a reload `sessions` is empty so the RAM cache is gone and `/` is dead until the next turn. */
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
  /** pids of every session still holding a process — the tree asks this to sum RAM. */
  livePids():number[]{const out:number[]=[];for(const s of this.sessions.values()){const pid=s.pid;if(pid)out.push(pid);}return out;}
  /**
   * Switching a project's account: a live process keeps the token it was spawned with. Don't close it right away — it may
   * be mid-turn (including a self-opened turn) — but mark it; the next turn closes and respawns through the wrapper
   * with `--resume`, exactly like a model change.
   */
  private retired=new WeakSet<ClaudeSession>();
  retireUnder(root:string){let n=0;for(const s of this.sessions.values())if(isUnder(s.cwd,root)){this.retired.add(s);n++;}return n;}
  closeSession(id:string){const t=this.idleTimers.get(id);if(t)clearTimeout(t);this.idleTimers.delete(id);const s=this.sessions.get(id);this.sessions.delete(id);if(s)this.busy.delete(s);void s?.close();}

  /** The stop button on a CLI self-opened turn: the manager has no handle to call, so reach straight
   *  into the session holding the process. Without this `cancel()` returns silently. */
  async interruptOutOfTurn(nativeId:string){
    // Also look up by `s.id`: rekey only runs at the first turn's `result`, so the real id the CLI declares afterwards
    // is the id the manager knows while the map still holds the old key.
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
      // Read `s.id` at emit time rather than capturing it up front: the first turn rekeys from `pending:` to the real id.
      const s=session; s.setIdleSink(e=>this.idleEventSink?.(s.id??key,e));
      this.sessions.set(key,session);
    }
    const live=session; this.busy.add(live); this.touch(key);
    const queue:DevHubEvent[]=[]; let waiter:(()=>void)|undefined; let ended=false;
    const push=(e:DevHubEvent)=>{queue.push(e);const w=waiter;waiter=undefined;w?.();};
    const run=live.send(prompt,push,resumeId).catch((e:any)=>{
      push({type:'error',message:`Claude failed: ${e?.message||e}`,timestamp:Date.now()} as DevHubEvent);
    }).finally(()=>{ended=true;this.busy.delete(live);
      // touch by KEY, not by real id: the map hasn't been rekeyed yet, so `touch(live.id)` would
      // arm the timer on ANOTHER session holding that id. `run.then` below touches again after the rekey.
      this.touch(key);const w=waiter;waiter=undefined;w?.();});

    const events=(async function*(){
      while(true){
        while(queue.length)yield queue.shift() as DevHubEvent;
        if(ended){while(queue.length)yield queue.shift() as DevHubEvent;return;}
        await new Promise<void>(r=>{waiter=r;});
      }
    })();
    // Rekey when the CLI issues the real session id for the first turn.
    void run.then(()=>{const real=live.id;
      if(real&&real!==key&&!this.sessions.has(real)){
        this.sessions.delete(key);this.sessions.set(real,live);
        // Move the timer too, or it fires on a dead key and the new session lives forever.
        const t=this.idleTimers.get(key);if(t)clearTimeout(t);this.idleTimers.delete(key);
        this.touch(real);
      }});
    return {events,cancel:async()=>{await live.interrupt();},getNativeSessionId:()=>live.id??key};
  }
  discoverHistory(projects:DevHubProject[]){return discoverClaudeHistory(projects,this.historyRoot,this.maxHistory,this.transcriptIndex,this.scanCache);}
  async loadTranscript(session:DevHubSession){let f=this.transcriptIndex.get(session.nativeSessionId);if(!f){f=await findClaudeTranscript(session.nativeSessionId,this.historyRoot,this.maxHistory);if(f)this.transcriptIndex.set(session.nativeSessionId,f);} if(!f) throw new Error('Claude transcript not found'); return loadClaudeTranscript(f);}
}
