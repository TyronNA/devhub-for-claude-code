import { scopedPlannerSession } from './plannerIdentity';
const crypto = require('node:crypto');
const {EventEmitter}=require('node:events');
import { DevHubEvent, DevHubSession, ProviderId, UsageSnapshot } from '../types';
import { SessionStore } from '../storage/sessionStore';
import { AgentProvider, ProviderTurnHandle } from '../providers/provider';
import { mergeSessionUsage } from '../usage/usageAggregator';

export class SessionManager {
  private emitter=new EventEmitter(); private active=new Map<string,{handle:ProviderTurnHandle;task:Promise<void>;session:DevHubSession}>(); private tasks=new Set<Promise<void>>(); private cancelledHandles=new WeakSet<any>();
  /**
   * `active` only gets an entry after provider.start/resume returns — in between there are several `await`s
   * (isAvailable, spawn). A plain count before those awaits lets N turns slip through at once,
   * so a slot must be RESERVED first and released in finally.
   */
  private reserved=0;
  /** Lock per session so two resumes can't overlap on the same thread. */
  private claimed=new Set<string>();
  /**
   * Sessions running a turn Dev Hub did NOT start: the CLI opens a report turn by itself after a
   * background task finishes. It takes no concurrency slot (we didn't start it and can't refuse it),
   * but `isBusy` must see it — otherwise a turn the user sends at that moment overlaps it.
   */
  private outOfTurn=new Set<string>();
  /** Store writes are chained: the pump's sink calls synchronously, and two parallel writes would clobber each other. */
  private outOfTurnWrites:Promise<any>=Promise.resolve();
  /**
   * `active` MUST also be keyed by provider: a native id isn't exclusive to one CLI —
   * Codex and the planner may carry the same string, and a map keyed only by id lets a later turn overwrite
   * an earlier one, `runningCount()` undercounts, and `cancel()` cancels another provider's session.
   */
  private akey(provider:string,nativeId:string){return `${provider}\u0000${nativeId}`;}
  constructor(private store:SessionStore,private providers:Record<string,AgentProvider>,private maxConcurrent=4){}
  on(name:'sessionUpdated'|'event'|'sessionAdded'|'sessionRekeyed',fn:(x:any)=>void){this.emitter.on(name,fn);return()=>this.emitter.off(name,fn);}
  private reserveSlot(){
    if(this.active.size+this.reserved>=this.maxConcurrent)throw new Error(`Dev Hub is already running ${this.maxConcurrent} turns`);
    this.reserved++;
  }
  /**
   * `cancel()` writes status 'cancelled' IMMEDIATELY, while `active` only empties after consume drains the
   * stream. In between, the status says idle but `claim()` still refuses — anyone reading the status to
   * decide whether to send a new turn gets an error. Ask this instead of guessing from the status.
   */
  isBusy(provider:string,nativeId:string){return this.claimed.has(`${provider}:${nativeId}`)||this.active.has(this.akey(provider,nativeId))||this.outOfTurn.has(this.akey(provider,nativeId));}
  /**
   * Events of a CLI self-opened turn. They take the same emitter path as normal turns, so the tab, the cache and
   * the mobile page keep drawing without knowing anything; only the session status must be flipped here, because
   * `consume()` already finished with the previous turn.
   */
  ingestOutOfTurn(provider:ProviderId,nativeId:string,event:DevHubEvent){
    const key=this.akey(provider,nativeId);
    this.emitter.emit('event',{provider,sessionId:nativeId,event});
    if(this.active.has(key))return;   // a normal turn is still running: consume() owns the status
    // A stray `usage` outside a turn (the `get_usage` answer after `result`) opens no turn: treating it as
    // a "start" would flip the session to running and leave it stuck there, since no turn_done follows.
    const began=!this.outOfTurn.has(key)&&event.type!=='usage';
    const ended=event.type==='turn_done'||event.type==='error';
    if(ended)this.outOfTurn.delete(key); else if(began)this.outOfTurn.add(key);
    if(!began&&!ended&&event.type!=='usage')return;
    this.outOfTurnWrites=this.outOfTurnWrites.then(async()=>{
      const cur=await this.store.get(provider,nativeId); if(!cur)return;
      let next:DevHubSession={...cur,updatedAt:Date.now()};
      if(event.type==='usage')next={...next,usage:mergeSessionUsage(cur.usage,event.usage)};
      if(ended)next={...next,status:event.type==='error'?'failed':'done'};
      else if(began)next={...next,status:'running'};
      await this.store.upsert(next);
      this.emitter.emit('sessionUpdated',next);
    }).catch(()=>{});
  }
  private claim(provider:string,nativeId:string){
    const key=`${provider}:${nativeId}`;
    if(this.claimed.has(key)||this.active.has(this.akey(provider,nativeId)))throw new Error('That session is already running a turn');
    this.claimed.add(key); return key;
  }
  /**
   * Locks a session for an operation OUTSIDE a turn (compaction over the app-server, takes a minute or more).
   * Without the lock the session still reads `done` and a resume could slip in mid-compaction.
   * Takes no concurrency slot — compaction is not a turn.
   */
  async withSessionLock<T>(session:DevHubSession,fn:()=>Promise<T>):Promise<T>{
    const lock=this.claim(session.provider,session.nativeSessionId);
    try{ return await fn(); } finally { this.claimed.delete(lock); }
  }
  async start(input:{provider:ProviderId;workspaceId:string;projectId:string;cwd:string;prompt:string;model?:string;effort?:string;images?:string[]}){
    this.reserveSlot();
    let handle:ProviderTurnHandle|undefined;
    try{
      const provider=this.providers[input.provider];if(!provider)throw new Error(`${input.provider} provider unavailable`);if(!await provider.isAvailable())throw new Error(`${input.provider} executable not found`);
      handle=await provider.start(input); const id=handle.getNativeSessionId()||`pending:${crypto.randomUUID()}`; const now=Date.now(); const session:DevHubSession={provider:input.provider,nativeSessionId:id,workspaceId:input.workspaceId,projectId:input.projectId,cwd:input.cwd,title:input.prompt.replace(/\s+/g,' ').trim().slice(0,80)||`${input.provider} chat`,status:'running',createdAt:now,updatedAt:now,model:input.model,effort:input.effort}; await this.store.upsert(session); this.emitter.emit('sessionAdded',session); this.emitter.emit('event',{provider:input.provider,sessionId:id,event:{type:'user_message',text:input.prompt,...(input.images?.length?{images:input.images}:{}),timestamp:now}}); this.consume(session,handle); return session;
    } catch(e){await handle?.cancel().catch(()=>{});throw e;} finally { this.reserved--; }
  }
  async resume(session:DevHubSession,prompt:string,opts:{model?:string;effort?:string;images?:string[]}={}){
    session=scopedPlannerSession(session);
    const lock=this.claim(session.provider,session.nativeSessionId);
    try{ this.reserveSlot(); }catch(e){ this.claimed.delete(lock); throw e; }
    let handle:ProviderTurnHandle|undefined;
    try{
      const provider=this.providers[session.provider];if(!provider)throw new Error('Provider unavailable');if(!await provider.isAvailable())throw new Error(`${session.provider} executable not found`);handle=await provider.resume({session,prompt,...opts});session={...session,model:opts.model,effort:opts.effort,status:'running',updatedAt:Date.now()};await this.store.upsert(session);this.emitter.emit('sessionUpdated',session);this.emitter.emit('event',{provider:session.provider,sessionId:session.nativeSessionId,event:{type:'user_message',text:prompt,...(opts.images?.length?{images:opts.images}:{}),timestamp:Date.now()}});this.consume(session,handle);return session;
    } catch(e){await handle?.cancel().catch(()=>{});throw e;} finally { this.reserved--; this.claimed.delete(lock); }
  }
  private consume(session:DevHubSession,handle:ProviderTurnHandle){ const initialId=session.nativeSessionId; const task=(async()=>{let current=session;let sawError=false;try{for await(const event of handle.events){ const native=handle.getNativeSessionId(); if(native&&native!==current.nativeSessionId){const old=current.nativeSessionId;await this.store.rekey(current.provider,old,native);current={...current,nativeSessionId:native};const runtime=this.active.get(this.akey(current.provider,old));this.active.delete(this.akey(current.provider,old));if(runtime)this.active.set(this.akey(current.provider,native),{...runtime,session:current});this.emitter.emit('sessionRekeyed',{provider:current.provider,oldId:old,newId:native,session:current});} let shouldPersist=false;if(event.type==='usage'){current={...current,usage:mergeSessionUsage(current.usage,event.usage),updatedAt:Date.now()};shouldPersist=true;} if(event.type==='error')sawError=true; this.emitter.emit('event',{provider:current.provider,sessionId:current.nativeSessionId,event}); if(shouldPersist)await this.store.upsert(current); } current={...current,status:this.cancelledHandles.has(handle)?'cancelled':(sawError?'failed':'done'),updatedAt:Date.now()};await this.store.upsert(current);this.emitter.emit('sessionUpdated',current);}catch(e:any){current={...current,status:this.cancelledHandles.has(handle)?'cancelled':'failed',updatedAt:Date.now()};await this.store.upsert(current);this.emitter.emit('event',{provider:current.provider,sessionId:current.nativeSessionId,event:{type:'error',message:String(e?.message||e),timestamp:Date.now()}});this.emitter.emit('sessionUpdated',current);}finally{this.active.delete(this.akey(current.provider,current.nativeSessionId));this.active.delete(this.akey(session.provider,initialId));}})(); this.active.set(this.akey(session.provider,initialId),{handle,task,session});this.tasks.add(task);task.finally(()=>this.tasks.delete(task)); }


  async updateUsage(session:DevHubSession,usage:UsageSnapshot){
    const current=await this.store.get(session.provider,session.nativeSessionId)??session;
    const updated={...current,usage:mergeSessionUsage(current.usage,usage),updatedAt:Date.now()};
    await this.store.upsert(updated);
    this.emitter.emit('sessionUpdated',updated);
    return updated;
  }

  /** Restore counters accumulated in the transcript; no merge, to avoid double-counting old turns. */
  async restoreHistoricalUsage(session:DevHubSession,usage:UsageSnapshot){
    const current=await this.store.get(session.provider,session.nativeSessionId)??session;
    const next={...(current.usage||{})}; let changed=false;
    for(const key of ['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'] as Array<keyof UsageSnapshot>){
      if(next[key]===undefined&&usage[key]!==undefined){(next as any)[key]=usage[key];changed=true;}
    }
    if(!changed)return current;
    const updated={...current,usage:next,updatedAt:Date.now()};
    await this.store.upsert(updated);this.emitter.emit('sessionUpdated',updated);return updated;
  }

  /**
   * Changing model/effort in the picker changes it for the session right away, even before any turn — closing the tab
   * and reopening must show that same choice. Keep `updatedAt` so the tree doesn't reorder.
   */
  async setTurnOptions(session:DevHubSession,opts:{model?:string;effort?:string}){
    const current=await this.store.get(session.provider,session.nativeSessionId)??session;
    const updated={...current,model:opts.model,effort:opts.effort};
    await this.store.upsert(updated);
    return updated;
  }

  async markUnavailable(session:DevHubSession){
    const updated={...session,status:'unavailable' as const,updatedAt:Date.now()};
    await this.store.upsert(updated);this.emitter.emit('sessionUpdated',updated);return updated;
  }
  async recoverStaleSessions(){
    const sessions=await this.store.list();
    const stale=sessions.filter(session=>session.status==='running'&&!this.isBusy(session.provider,session.nativeSessionId));
    if(!stale.length)return;
    const locks:string[]=[];
    try{
      const recovered=await Promise.all(stale.map(async session=>{
        if(this.isBusy(session.provider,session.nativeSessionId))return undefined;
        // Hold the claim until after the batch write so a resume can't slip in and then be overwritten by recovery.
        locks.push(this.claim(session.provider,session.nativeSessionId));
        const provider=this.providers[session.provider];
        let status:DevHubSession['status']='imported';
        if(!provider){ status='unavailable'; }
        else {
          try{
            const events=await provider.loadTranscript(session);
            // Only read after the last message: the previous turn's turn_done doesn't end the interrupted turn.
            let from=0;
            for(let i=events.length-1;i>=0;i--)if(events[i].type==='user_message'){from=i;break;}
            for(let i=events.length-1;i>=from;i--){
              if(events[i].type==='turn_done'){status='done';break;}
              if(events[i].type==='error'){status='failed';break;}
            }
          } catch { status='unavailable'; }
        }
        return {...session,status,updatedAt:Date.now()};
      }));
      const updates=recovered.filter(s=>!!s);
      if(updates.length)await this.store.upsertMany(updates);
      for(const session of updates)this.emitter.emit('sessionUpdated',session);
    }finally{for(const lock of locks)this.claimed.delete(lock);}
  }

  async cancel(provider:string,nativeId:string){ const a=this.active.get(this.akey(provider,nativeId));if(!a)return await this.cancelOutOfTurn(provider,nativeId);this.cancelledHandles.add(a.handle);await a.handle.cancel();const s={...a.session,status:'cancelled' as const,updatedAt:Date.now()};await this.store.upsert(s);this.emitter.emit('sessionUpdated',s); }
  /**
   * A CLI self-opened turn isn't in `active` — we didn't start it so we hold no handle.
   * Without this branch `cancel()` returns at once and the stop button looks broken: the process keeps
   * running, the tab keeps spinning. Once the provider kills the process no more events arrive (the pump's sink
   * calls synchronously), so writing the status here is safe.
   */
  private async cancelOutOfTurn(provider:string,nativeId:string){
    const key=this.akey(provider,nativeId); if(!this.outOfTurn.has(key))return;
    const p=this.providers[provider]; if(!p?.interruptOutOfTurn)return;
    await p.interruptOutOfTurn(nativeId); this.outOfTurn.delete(key);
    // Chain onto `ingestOutOfTurn`'s write queue, or the last event's 'running' overwrites 'cancelled'.
    this.outOfTurnWrites=this.outOfTurnWrites.then(async()=>{
      const cur=await this.store.get(provider as ProviderId,nativeId); if(!cur)return;
      const next={...cur,status:'cancelled' as const,updatedAt:Date.now()};
      await this.store.upsert(next); this.emitter.emit('sessionUpdated',next);
    }).catch(()=>{});
    await this.outOfTurnWrites;
  }
  async cancelAll(){for(const [,a] of [...this.active]){try{await this.cancel(a.session.provider,a.session.nativeSessionId);}catch{}}}
  /** Also drains the out-of-turn status writes: deactivate must not drop them, and tests must not guess how long they take. */
  async waitForIdle(){await Promise.allSettled([...this.tasks]);await this.outOfTurnWrites;}
  runningCount(){return this.active.size;}
}
