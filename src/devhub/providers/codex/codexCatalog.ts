const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');

export interface CodexModel { slug:string; label:string; efforts:string[]; contextWindow?:number; effectivePercent?:number; }

/**
 * Codex's model catalog. The real source is `codex debug models` (rendered by the CLI itself, with
 * `context_window` and per-model effort levels); `~/.codex/models_cache.json` is only the copy the
 * CLI caches, so it is the fallback until the command can be run.
 */
export function parseCatalog(json:string):CodexModel[]{
  let d:any; try{d=JSON.parse(json);}catch{return [];}
  const models=Array.isArray(d?.models)?d.models:[];
  return models
    .filter((m:any)=>m&&typeof m.slug==='string'&&m.visibility!=='hide')
    .map((m:any)=>({
      slug:m.slug,
      label:typeof m.display_name==='string'&&m.display_name?m.display_name:m.slug,
      efforts:Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((l:any)=>l?.effort).filter((e:any)=>typeof e==='string')
        : [],
      contextWindow:Number.isFinite(Number(m.context_window))&&Number(m.context_window)>0?Number(m.context_window):undefined,
      effectivePercent:Number.isFinite(Number(m.effective_context_window_percent))?Number(m.effective_context_window_percent):undefined,
    }));
}

/** The window Codex actually uses = context_window * effective_context_window_percent. */
export function effectiveContextWindow(m:CodexModel|undefined):number|undefined{
  if(!m?.contextWindow)return undefined;
  const pct=m.effectivePercent;
  const w=pct&&pct>0&&pct<=100?Math.floor(m.contextWindow*pct/100):m.contextWindow;
  return w>0?w:undefined;
}

function codexHome(){return process.env.CODEX_HOME||path.join(os.homedir(),'.codex');}
function fromCache():CodexModel[]{
  try{return parseCatalog(fs.readFileSync(path.join(codexHome(),'models_cache.json'),'utf8'));}catch{return [];}
}

let cached:{at:number;value:CodexModel[]}|undefined;
let refreshing:Promise<void>|undefined;

/** Synchronous: the cache if present, otherwise read the file. Call `refreshCodexCatalog` for the real one. */
export function codexCatalog(ttlMs=60_000):CodexModel[]{
  const now=Date.now();
  if(cached&&now-cached.at<ttlMs)return cached.value;
  const value=cached?.value?.length?cached.value:fromCache();
  cached={at:now,value};
  return value;
}

/** Run `codex debug models`; silently keep the old cache if the command can't run. */
export function refreshCodexCatalog(executable='codex',timeoutMs=8000):Promise<void>{
  if(refreshing)return refreshing;
  refreshing=new Promise<void>(resolve=>{
    let out='';
    try{
      const child=cp.spawn(executable,['debug','models'],{stdio:['ignore','pipe','ignore']});
      const timer:any=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},timeoutMs);
      timer.unref?.();
      child.stdout?.on('data',(c:any)=>{if(out.length<8*1024*1024)out+=String(c);});
      child.once('error',()=>{clearTimeout(timer);resolve();});
      child.once('close',(code:any)=>{
        clearTimeout(timer);
        if(code===0){const parsed=parseCatalog(out);if(parsed.length)cached={at:Date.now(),value:parsed};}
        resolve();
      });
    }catch{resolve();}
  }).finally(()=>{refreshing=undefined;});
  return refreshing;
}

export function codexModel(slug?:string):CodexModel|undefined{
  const list=codexCatalog();
  return slug?list.find(m=>m.slug===slug):undefined;
}
/** Effort levels of the selected model; with no known model, the union of every level the catalog knows. */
export function codexEfforts(slug?:string):string[]{
  const list=codexCatalog();
  if(!list.length)return [];
  const hit=codexModel(slug);
  if(hit&&hit.efforts.length)return hit.efforts;
  return [...new Set(list.flatMap(m=>m.efforts))];
}
