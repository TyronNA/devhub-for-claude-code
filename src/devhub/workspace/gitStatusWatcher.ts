import { GitStatus, readGitStatus } from './gitStatus';

/** While a turn runs files change every second; otherwise 30s is enough to catch hand edits in another editor. */
const HOT_MS=5000,COLD_MS=30000,TICK_MS=5000;
export interface GitRootRef {root:string;hot:boolean;}

/**
 * Git cache shared by the panel and the mobile server. Each read is TWO `git` commands, so:
 * single-flight per root (ten tabs on one repo still run once), and re-read only while
 * someone is LOOKING at that repo — no visible tab means no git command runs at all.
 */
export class GitStatusWatcher {
  private cache=new Map<string,{at:number;sig:string;status?:GitStatus}>();
  private inflight=new Map<string,Promise<void>>();
  private sources=new Set<()=>GitRootRef[]>();
  private listeners=new Set<(root:string,status?:GitStatus)=>void>();
  private timer:any;
  constructor(private read:(root:string)=>Promise<GitStatus|undefined>=readGitStatus){}

  on(fn:(root:string,status?:GitStatus)=>void){this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};}
  /** A source returning the roots being looked at right now — the panel and mobile each have one. */
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
    // Let go of repos nobody looks at any more; a window open all week doesn't keep every repo it ever opened.
    for(const root of [...this.cache.keys()])if(!want.has(root)&&!this.inflight.has(root))this.cache.delete(root);
  }

  /** `maxAgeMs` = accept a cached result newer than this; 0 forces a rerun. */
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
      // Only notify on a real change: redrawing the header on every 5s tick is pointless flicker.
      if(!before||before.sig!==sig)for(const fn of this.listeners)try{ fn(root,status); }catch{}
    })().then(()=>{this.inflight.delete(root);},()=>{this.inflight.delete(root);});
    this.inflight.set(root,p);
    return p;
  }
}
