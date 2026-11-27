const path = require('node:path');
import { readJson, writeJsonAtomic } from './jsonStore';

const MAX_AGE_MS=7*24*60*60*1000;
export interface StoredPrompt { text:string; images?:string[]; }
interface Entry { pid:number; at:number; items:StoredPrompt[]; }
interface QueueFile { version:1; queues:Record<string,Entry>; }

/**
 * Tin đã gõ nhưng chưa gửi chỉ sống trong RAM của host, nên Reload Window là mất sạch.
 * Ghi lại để lần mở session sau còn TRẢ LẠI CHỮ cho người dùng — cố ý không tự gửi:
 * một hàng chờ của cửa sổ trước tự chạy vài ngày sau là lượt không ai yêu cầu.
 * `pid` phân biệt "cửa sổ trước để lại" với hàng chờ của chính tiến trình đang chạy.
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
      // Key `pending:` bị rekey ngay sau lượt đầu nên bản ghi cũ thành mồ côi; quá hạn thì bỏ.
      const cutoff=Date.now()-MAX_AGE_MS;
      for(const [k,e] of Object.entries(data.queues))if(!(e?.at>cutoff))delete data.queues[k];
      await writeJsonAtomic(this.file,data);
    }).catch(()=>{});
  }
  /** Trả về hàng chờ do một tiến trình KHÁC để lại, rồi xoá nó đi. */
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
