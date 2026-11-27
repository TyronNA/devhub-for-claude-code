const path = require('node:path');
import { readJson, writeJsonAtomic } from './jsonStore';

const MAX_AGE_MS=7*24*60*60*1000;
export interface StoredPrompt { text:string; images?:string[]; }
interface Entry { pid:number; at:number; items:StoredPrompt[]; }
interface QueueFile { version:1; queues:Record<string,Entry>; }

/**
 * Messages typed but not yet sent only live in the host's RAM, so Reload Window wipes them.
 * They are saved so the next time the session opens the TEXT IS HANDED BACK to the user — deliberately not auto-sent:
 * a previous window's queue firing days later is a turn nobody asked for.
 * `pid` tells "left over by a previous window" apart from the running process's own queue.
 */
export class QueueStore {
  private file:string;
  private chain:Promise<any>=Promise.resolve();
  constructor(storageDir:string){ this.file=path.join(storageDir,'devhub','queues.json'); }
  private load(){ return readJson<QueueFile>(this.file,{version:1,queues:{}}); }
  private exclusive<T>(fn:()=>Promise<T>):Promise<T>{ const next=this.chain.then(fn,fn); this.chain=next.then(()=>undefined,()=>undefined); return next; }

  async save(key:string,items:StoredPrompt[]){
    return this.exclusive(async()=>{
      const data=await this.load();
      if(items.length)data.queues[key]={pid:process.pid,at:Date.now(),items};
      else delete data.queues[key];
      // A `pending:` key is rekeyed right after the first turn, so the old record becomes an orphan; drop it once stale.
      const cutoff=Date.now()-MAX_AGE_MS;
      for(const [k,e] of Object.entries(data.queues))if(!(e?.at>cutoff))delete data.queues[k];
      await writeJsonAtomic(this.file,data);
    }).catch(()=>{});
  }
  /** Returns the queue left by ANOTHER process, then deletes it. */
  async take(key:string):Promise<StoredPrompt[]>{
    return this.exclusive(async()=>{
      const data=await this.load();
      const entry=data.queues[key];
      if(!entry?.items?.length||entry.pid===process.pid)return [];
      delete data.queues[key];
      await writeJsonAtomic(this.file,data);
      return entry.items;
    }).catch(()=>[]);
  }
}
