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
   * `active` chỉ có mục sau khi provider.start/resume trả về — giữa lúc đó có nhiều `await`
   * (isAvailable, spawn). Đếm suông trước các await đó cho phép N lượt cùng lọt qua cửa,
   * nên phải GIỮ CHỖ trước và nhả trong finally.
   */
  private reserved=0;
  /** Khoá theo session để hai lần resume không chồng lên cùng một thread. */
  private claimed=new Set<string>();
  /**
   * Session đang chạy một lượt KHÔNG do Dev Hub khởi: CLI tự mở lượt báo cáo sau khi một
   * task nền xong. Không chiếm slot concurrent (ta không khởi nó, cũng không từ chối được),
   * nhưng `isBusy` phải thấy — nếu không, lượt người dùng gửi lúc đó chồng lên nó.
   */
  private outOfTurn=new Set<string>();
  /** Ghi store nối đuôi nhau: sink của pump gọi đồng bộ, hai lần ghi song song sẽ đè nhau. */
  private outOfTurnWrites:Promise<any>=Promise.resolve();
  /**
   * `active` PHẢI khoá theo provider nữa: native id không phải thứ độc quyền của một CLI —
   * Claude và planner có thể mang cùng một chuỗi, và một map chỉ theo id thì lượt sau đè lượt
   * trước, `runningCount()` đếm thiếu, còn `cancel()` huỷ nhầm session của provider khác.
   */
  private akey(provider:string,nativeId:string){return `${provider}\u0000${nativeId}`;}
  constructor(private store:SessionStore,private providers:Record<string,AgentProvider>,private maxConcurrent=4){}
  on(name:'sessionUpdated'|'event'|'sessionAdded'|'sessionRekeyed',fn:(x:any)=>void){this.emitter.on(name,fn);return()=>this.emitter.off(name,fn);}
  private reserveSlot(){
    if(this.active.size+this.reserved>=this.maxConcurrent)throw new Error(`Dev Hub is already running ${this.maxConcurrent} turns`);
    this.reserved++;
  }
  /**
   * `cancel()` ghi status 'cancelled' NGAY, còn `active` chỉ rỗng sau khi consume drain hết
   * stream. Trong khoảng đó status nói rảnh mà `claim()` vẫn từ chối — ai đọc status để
   * quyết định gửi lượt mới sẽ ăn lỗi. Hỏi cái này thay vì đoán qua status.
   */
  isBusy(provider:string,nativeId:string){return this.claimed.has(`${provider}:${nativeId}`)||this.active.has(this.akey(provider,nativeId))||this.outOfTurn.has(this.akey(provider,nativeId));}
  /**
   * Sự kiện của một lượt CLI tự mở. Đi đúng đường emitter như lượt thường nên tab, cache và
   * trang mobile vẽ tiếp mà không phải biết gì; chỉ trạng thái session là phải tự lật, vì
   * `consume()` đã kết thúc từ lượt trước.
   */
  ingestOutOfTurn(provider:ProviderId,nativeId:string,event:DevHubEvent){
    const key=this.akey(provider,nativeId);
    this.emitter.emit('event',{provider,sessionId:nativeId,event});
    if(this.active.has(key))return;   // lượt thường vẫn đang chạy: status do consume() lo
    // `usage` lẻ ngoài lượt (trả lời `get_usage` sau `result`) không mở lượt nào: coi nó là
    // "bắt đầu" thì session bị lật sang running và kẹt đó vì chẳng có turn_done nào theo sau.
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

  /**
   * Picker đổi model/effort là đổi ngay cho session, kể cả khi chưa gửi lượt nào — đóng tab
   * mở lại phải thấy đúng lựa chọn đó. Giữ nguyên `updatedAt` để cây không nhảy thứ tự.
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
        // Giữ claim tới sau lần ghi batch để resume không chen vào rồi bị recovery ghi đè.
        locks.push(this.claim(session.provider,session.nativeSessionId));
        const provider=this.providers[session.provider];
        let status:DevHubSession['status']='imported';
        if(!provider){ status='unavailable'; }
        else {
          try{
            const events=await provider.loadTranscript(session);
            // Chỉ đọc sau tin cuối: turn_done của lượt trước không kết thúc lượt bị cắt.
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
   * Lượt CLI tự mở không nằm trong `active` — ta không khởi nó nên không giữ handle nào.
   * Không có nhánh này thì `cancel()` return ngay và nút dừng trông y như hỏng: process vẫn
   * chạy, tab vẫn quay. Provider giết process xong thì không còn event nào tới nữa (sink của
   * pump gọi đồng bộ), nên ghi status ở đây là an toàn.
   */
  private async cancelOutOfTurn(provider:string,nativeId:string){
    const key=this.akey(provider,nativeId); if(!this.outOfTurn.has(key))return;
    const p=this.providers[provider]; if(!p?.interruptOutOfTurn)return;
    await p.interruptOutOfTurn(nativeId); this.outOfTurn.delete(key);
    // Nối đuôi hàng ghi của `ingestOutOfTurn`, nếu không 'running' của event chót đè 'cancelled'.
    this.outOfTurnWrites=this.outOfTurnWrites.then(async()=>{
      const cur=await this.store.get(provider as ProviderId,nativeId); if(!cur)return;
      const next={...cur,status:'cancelled' as const,updatedAt:Date.now()};
      await this.store.upsert(next); this.emitter.emit('sessionUpdated',next);
    }).catch(()=>{});
    await this.outOfTurnWrites;
  }
  async cancelAll(){for(const [,a] of [...this.active]){try{await this.cancel(a.session.provider,a.session.nativeSessionId);}catch{}}}
  async waitForIdle(){await Promise.allSettled([...this.tasks]);}
  runningCount(){return this.active.size;}
}
