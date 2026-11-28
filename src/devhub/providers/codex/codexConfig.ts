const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
import { codexModel, effectiveContextWindow } from './codexCatalog';

/**
 * `model_context_window` in config.toml is the user's real override.
 * Do NOT use `model_auto_compact_token_limit` instead: that is the auto-compact trigger threshold,
 * a different setting entirely; used as the context window it gives a wrong percentage.
 */
export function parseContextWindow(toml:string):number|undefined{
  const m=/^\s*model_context_window\s*=\s*(\d+)/m.exec(toml);
  const n=m?Number(m[1]):NaN;
  return Number.isFinite(n)&&n>0?n:undefined;
}
export function parseConfiguredModel(toml:string):string|undefined{
  const m=/^\s*model\s*=\s*"([^"]+)"/m.exec(toml);
  return m?m[1]:undefined;
}

function readToml():string|undefined{
  try{
    const home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
    return fs.readFileSync(path.join(home,'config.toml'),'utf8');
  }catch{return undefined;}
}

let cached:{at:number;window:number|undefined;model:string|undefined}|undefined;
function config(ttlMs:number){
  const now=Date.now();
  if(cached&&now-cached.at<ttlMs)return cached;
  const toml=readToml();
  cached={at:now,window:toml?parseContextWindow(toml):undefined,model:toml?parseConfiguredModel(toml):undefined};
  return cached;
}

/**
 * Context window for `model`. The config.toml override wins, then the official catalog.
 * If it can't be known, return undefined — the UI shows `—` instead of a wrong percentage.
 */
export function codexContextWindow(model?:string,ttlMs=60_000):number|undefined{
  const override=config(ttlMs).window;
  if(override)return override;
  return effectiveContextWindow(codexModel(model??config(ttlMs).model));
}
