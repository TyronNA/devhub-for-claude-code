import { GitStatus, readGitStatus } from './gitStatus';

/** Đang có lượt chạy thì file đổi từng giây; không thì 30s là đủ bắt người sửa tay ở editor khác. */
const HOT_MS=5000,COLD_MS=30000,TICK_MS=5000;
export interface GitRootRef {root:string;hot:boolean;}

/**
 * Cache git dùng chung cho panel và server mobile. Mỗi lần đọc là HAI lệnh `git`, nên:
 * single-flight theo root (mười tab cùng repo vẫn chỉ một lần chạy), và chỉ đọc lại khi
 * có người đang NHÌN repo đó — không tab nào hiện thì không có lệnh git nào chạy cả.
 */
export class GitStatusWatcher {
  private cache=new Map<string,{at:number;sig:string;status?:GitStatus}>();
  private inflight=new Map<string,Promise<void>>();
  private sources=new Set<()=>GitRootRef[]>();
  private listeners=new Set<(root:string,status?:GitStatus)=>void>();
  private timer:any;
  constructor(private read:(root:string)=>Promise<GitStatus|undefined>=readGitStatus){}

  on(fn:(root:string,status?:GitStatus)=>void){this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};}
  /** Nguồn trả về các root đang được nhìn ngay lúc gọi — panel và mobile mỗi bên một nguồn. */
  addSource(fn:()=>GitRootRef[]){this.sources.add(fn);this.start();return ()=>{this.sources.delete(fn);};}
  get(root?:string){return root?this.cache.get(root)?.status:undefined;}
  dispose(){clearInterval(this.timer);this.timer=undefined;this.sources.clear();this.listeners.clear();this.cache.clear();}

  private start(){if(this.timer)return;this.timer=setInterval(()=>this.tick(),TICK_MS);this.timer.unref?.();}

  tick(){
    const want=new Map<string,boolean>();
    for(const src of this.sources){
      let refs:GitRootRef[]=[]; try{ refs=src()||[]; }catch{}
      for(const r of refs)if(r?.root)want.set(r.root,!!want.get(r.root)||!!r.hot);
    }
    for(const [root,hot] of want)void this.refresh(root,hot?HOT_MS:COLD_MS);
    // Repo không còn ai nhìn thì buông; cửa sổ mở cả tuần không giữ mãi mọi repo đã mở qua.
    for(const root of [...this.cache.keys()])if(!want.has(root)&&!this.inflight.has(root))this.cache.delete(root);
  }

  /** `maxAgeMs` = chấp nhận bản cache mới hơn ngần này; 0 là ép chạy lại. */
  refresh(root:string,maxAgeMs=0):Promise<void>{
    if(!root)return Promise.resolve();
    const running=this.inflight.get(root); if(running)return running;
    const hit=this.cache.get(root);
    if(hit&&maxAgeMs>0&&Date.now()-hit.at<maxAgeMs)return Promise.resolve();
    const p=(async()=>{
      let status:GitStatus|undefined;
      try{ status=await this.read(root); }catch{ status=undefined; }
      const sig=status?JSON.stringify(status):'';
      const before=this.cache.get(root);
      this.cache.set(root,{at:Date.now(),sig,status});
      // Chỉ báo khi thực sự đổi: nhịp 5s mà lần nào cũng vẽ lại header là nhấp nháy vô cớ.
      if(!before||before.sig!==sig)for(const fn of this.listeners)try{ fn(root,status); }catch{}
    })().then(()=>{this.inflight.delete(root);},()=>{this.inflight.delete(root);});
    this.inflight.set(root,p);
    return p;
  }
}
