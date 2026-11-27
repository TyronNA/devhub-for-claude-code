import { scopedPlannerSession, plannerConversationId } from '../sessions/plannerIdentity';
const path = require('node:path');
import { DevHubSession } from '../types';
import { readJson, writeJsonAtomic } from './jsonStore';
interface SessionStoreFile { version:1; sessions:DevHubSession[]; }

export class SessionStore {
  private file:string;
  private chain:Promise<any>=Promise.resolve();
  private data:SessionStoreFile|undefined;
  private loading:Promise<SessionStoreFile>|undefined;

  constructor(storageDir:string){ this.file=path.join(storageDir,'devhub','sessions.json'); }

  private async load(){
    if(this.data) return this.data;
    if(!this.loading){
      this.loading=readJson<SessionStoreFile>(this.file,{version:1,sessions:[]}).then(data=>{
        // Codex đã gỡ (0.29.72): bản ghi cũ không còn provider để mở, giữ lại chỉ thành hàng chết
        // trong tree. Lần ghi kế xoá hẳn khỏi file; lịch sử gốc ở ~/.codex không bị đụng.
        data.sessions=data.sessions.filter(s=>s.provider==='claude'||s.provider==='planner').map(scopedPlannerSession);
        this.data=data;
        this.loading=undefined;
        return data;
      },err=>{
        this.loading=undefined;
        throw err;
      });
    }
    return this.loading;
  }

  private async save(data:SessionStoreFile){ this.data=data; await writeJsonAtomic(this.file,data); }
  private key(provider:string,id:string){ return `${provider}\u0000${id}`; }

  async list(){ return [...(await this.load()).sessions].sort((a,b)=>b.updatedAt-a.updatedAt); }

  async upsert(session:DevHubSession){
    session=scopedPlannerSession(session);
    await this.upsertMany([session]);
    return session;
  }

  async upsertMany(sessions:DevHubSession[]){
    if(!sessions.length) return;
    return this.exclusive(async()=>{
      const data=await this.load();
      const byKey=new Map(data.sessions.map((s,i)=>[this.key(s.provider,s.nativeSessionId),i] as const));
      for(const input of sessions){
        const session=scopedPlannerSession(input);
        const key=this.key(session.provider,session.nativeSessionId);
        const i=byKey.get(key);
        // `name` chỉ `rename` được ghi: lượt đang chạy/cancel upsert bản session chụp trước khi
        // đổi tên, spread thẳng là tên mới bị lật về tên cũ.
        if(i!==undefined) data.sessions[i]={...data.sessions[i],...session,name:data.sessions[i].name};
        else { byKey.set(key,data.sessions.length); data.sessions.push(session); }
      }
      await this.save(data);
    });
  }

  async rename(provider:string,id:string,name:string){
    return this.exclusive(async()=>{
      const s=(await this.load()).sessions.find(x=>x.provider===provider&&x.nativeSessionId===id);
      if(!s)return undefined;
      const n=name.replace(/\s+/g,' ').trim(); if(n)s.name=n; else delete s.name;
      await this.save(this.data!);return s;
    });
  }

  async rekey(provider:string,oldId:string,newId:string){
    if(oldId===newId)return;
    return this.exclusive(async()=>{
      const data=await this.load();
      const old=data.sessions.find(s=>s.provider===provider&&s.nativeSessionId===oldId);
      if(!old)return;
      const existing=data.sessions.find(s=>s.provider===provider&&s.nativeSessionId===newId);
      if(existing) Object.assign(existing,old,{nativeSessionId:newId}); else old.nativeSessionId=newId;
      data.sessions=data.sessions.filter((s,i,a)=>a.findIndex(x=>x.provider===s.provider&&x.nativeSessionId===s.nativeSessionId)===i);
      await this.save(data);
    });
  }

  async get(provider:string,id:string){
    const sessions=(await this.load()).sessions;
    const exact=sessions.find(s=>s.provider===provider&&s.nativeSessionId===id);
    if(exact||provider!=='planner'||plannerConversationId(id)!==id)return exact;
    // Tab cũ chỉ có conversation ID: chỉ khôi phục khi không nhập nhằng daemon.
    const matches=sessions.filter(s=>s.provider==='planner'&&plannerConversationId(s.nativeSessionId)===id);
    return matches.length===1?matches[0]:undefined;
  }

  async remove(provider:string,id:string){
    return this.exclusive(async()=>{
      const data=await this.load();
      data.sessions=data.sessions.filter(s=>!(s.provider===provider&&s.nativeSessionId===id));
      await this.save(data);
    });
  }

  private exclusive<T>(fn:()=>Promise<T>):Promise<T>{ const next=this.chain.then(fn,fn); this.chain=next.then(()=>undefined,()=>undefined); return next; }
}
