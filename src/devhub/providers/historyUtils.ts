const fs = require('node:fs/promises');
const path = require('node:path');

export function pathKey(p:string){ const v=path.resolve(p).replace(/[\\/]+$/,''); return (process.platform==='darwin'||process.platform==='win32')?v.toLowerCase():v; }
export function projectForCwd(projects:any[], cwd:string){
  const ck=pathKey(cwd); let best:any, bestLen=-1;
  for(const p of projects){
    const pk=pathKey(p.rootPath);
    // A child repo inside a parent repo: `find` returns whichever comes first in the array, so the
    // registration order would decide who owns the session. The longest match is the true owner of the cwd.
    if((ck===pk||ck.startsWith(pk+path.sep))&&pk.length>bestLen){best=p;bestLen=pk.length;}
  }
  return best;
}
export function timestampOf(v:any, fallback:number){ const raw=v?.timestamp ?? v?.created_at ?? v?.createdAt; if(typeof raw==='number') return raw>1e12?raw:raw*1000; const parsed=raw?Date.parse(raw):NaN; return Number.isFinite(parsed)?parsed:fallback; }
export function truncateTitle(s:string){ return s.replace(/\s+/g,' ').trim().slice(0,80) || 'Untitled chat'; }
/**
 * `from:'end'` reads the file's TAIL: when a transcript exceeds maxBytes the newest part is the part
 * to show, and reading from the start would lose the recent conversation entirely. The first byte of the tail window lands
 * mid JSON line, so skip to the first newline.
 */
export async function readJsonLines(file:string, maxBytes=2*1024*1024, from:'start'|'end'='start'):Promise<any[]> {
  const fh=await fs.open(file,'r');
  try {
    const st=await fh.stat(); const size=Math.min(st.size,maxBytes);
    const offset=from==='end'?st.size-size:0;
    const b=Buffer.allocUnsafe(size); const {bytesRead}=await fh.read(b,0,size,offset);
    let text=b.toString('utf8',0,bytesRead);
    if(offset>0){ const nl=text.indexOf('\n'); text=nl>=0?text.slice(nl+1):''; }
    return text.split(/\r?\n/).filter(Boolean).flatMap((line:string)=>{try{return [JSON.parse(line)];}catch{return [];}});
  } finally { await fh.close(); }
}
export async function collectFiles(root:string, accept:(name:string)=>boolean, maxFiles:number, maxDepth=6):Promise<string[]> {
  const out:string[]=[]; async function walk(dir:string, depth:number){ if(depth>maxDepth||out.length>=maxFiles)return; let entries:any[]; try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return;} entries.sort((a,b)=>String(b.name).localeCompare(String(a.name))); for(const e of entries){ if(out.length>=maxFiles)break; const p=path.join(dir,e.name); if(e.isDirectory()) await walk(p,depth+1); else if(e.isFile()&&accept(e.name)) out.push(p); } }
  await walk(root,0); return out;
}

export async function mapLimit<T,R>(items:T[], limit:number, fn:(item:T,index:number)=>Promise<R>):Promise<R[]> {
  if(!items.length)return [];
  const results=new Array<R>(items.length);let cursor=0;
  const workers=Array.from({length:Math.min(Math.max(1,limit),items.length)},async()=>{
    while(true){const index=cursor++;if(index>=items.length)return;results[index]=await fn(items[index],index);}
  });
  await Promise.all(workers);return results;
}

export interface FileStamp { mtimeMs:number; size:number; }

/** stat is much cheaper than open+read 64KB; use it as the cache gate. */
export async function stampOf(file:string):Promise<FileStamp|undefined>{
  try{ const st=await fs.stat(file); return {mtimeMs:st.mtimeMs,size:st.size}; }catch{ return undefined; }
}

/**
 * LRU by the Map's insertion order. Keeps the *parsed facts* of each file, not a
 * DevHubSession — project mapping must be recomputed every time because the project list can change.
 */
export class HistoryScanCache<T> {
  private m=new Map<string,{stamp:FileStamp;value:T|undefined}>();
  constructor(private max=4000){}
  get(file:string,stamp:FileStamp):{hit:boolean;value:T|undefined}{
    const e=this.m.get(file);
    if(e&&e.stamp.mtimeMs===stamp.mtimeMs&&e.stamp.size===stamp.size){ this.m.delete(file); this.m.set(file,e); return {hit:true,value:e.value}; }
    return {hit:false,value:undefined};
  }
  set(file:string,stamp:FileStamp,value:T|undefined){
    if(this.m.has(file)) this.m.delete(file);
    this.m.set(file,{stamp,value});
    while(this.m.size>this.max){ const k=this.m.keys().next().value; if(k===undefined)break; this.m.delete(k); }
  }
  get size(){ return this.m.size; }
}

/** A size-capped Map, so transcriptIndex can't grow without bound. */
export function boundedSet(m:Map<string,string>,key:string,value:string,max=4000){
  if(m.has(key)) m.delete(key);
  m.set(key,value);
  while(m.size>max){ const k=m.keys().next().value; if(k===undefined)break; m.delete(k); }
}
