const https=require('node:https');
import { ProcessRunner } from './processRunner';

/**
 * So version CLI đang cài với bản mới nhất trên npm. Đây là chỗ DUY NHẤT extension
 * đi ra Internet ngoài planner/mobile (đều loopback/LAN), nên nó phải im lặng khi hỏng:
 * mọi lỗi mạng, timeout hay output lạ đều trả undefined chứ không nổi lên UI.
 */
export const CLI_PACKAGES:{[provider:string]:string}={claude:'@anthropic-ai/claude-code'};
export const CHECK_INTERVAL_MS=6*60*60*1000;

export interface VersionDrift { provider:string; installed:string; latest:string; pkg:string }
export interface VersionCacheEntry { at:number; latest?:string }

/** `claude --version` → "2.1.266 (Claude Code)",
 *  và cả dạng `v1.2.3` — tiền tố `v` dính liền số nên phải cho phép riêng. */
export function parseCliVersion(text:string):string|undefined{
  const m=/(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\w.])/.exec(String(text||''));
  return m?m[1]:undefined;
}

/** So theo số, prerelease coi như thấp hơn bản release cùng số (2.1.0-rc < 2.1.0). */
export function compareVersions(a:string,b:string):number{
  const split=(v:string)=>{const [core,pre]=String(v).split(/[-+]/,2);return {nums:core.split('.').map(x=>parseInt(x,10)||0),pre:pre||''};};
  const x=split(a),y=split(b);
  for(let i=0;i<Math.max(x.nums.length,y.nums.length);i++){const d=(x.nums[i]||0)-(y.nums[i]||0);if(d)return d<0?-1:1;}
  if(x.pre===y.pre)return 0;if(!x.pre)return 1;if(!y.pre)return -1;return x.pre<y.pre?-1:1;
}

export function isOutdated(installed?:string,latest?:string):boolean{
  if(!installed||!latest)return false;return compareVersions(installed,latest)<0;
}

export async function fetchLatestVersion(pkg:string,timeoutMs=3000):Promise<string|undefined>{
  return new Promise<string|undefined>(resolve=>{
    let settled=false;const done=(v?:string)=>{if(!settled){settled=true;resolve(v);}};
    try{
      const req=https.get(`https://registry.npmjs.org/${pkg.replace('/','%2F')}/latest`,
        // Bản rút gọn của registry: cùng field `version` nhưng nhỏ hơn packument đầy đủ nhiều lần.
        {headers:{accept:'application/vnd.npm.install-v1+json, application/json'},timeout:timeoutMs},(res:any)=>{
        if(res.statusCode!==200){res.resume();return done();}
        let body='';res.setEncoding('utf8');
        res.on('data',(c:string)=>{body+=c;if(body.length>1e6){req.destroy();done();}});
        res.on('end',()=>{try{done(String(JSON.parse(body).version||'')||undefined);}catch{done();}});
      });
      req.on('timeout',()=>{req.destroy();done();});
      req.on('error',()=>done());
    }catch{done();}
  });
}

/** Đọc version thật của binary. Không dùng lại isAvailable vì cái đó chỉ trả boolean. */
export async function readInstalledVersion(runner:ProcessRunner,command:string,timeoutMs=2500):Promise<string|undefined>{
  try{
    const h=runner.spawnLines({command,args:['--version'],cwd:process.cwd()});
    const lines:string[]=[];const collect=(async()=>{for await(const l of h.stdoutLines)lines.push(l);})();
    const r=await Promise.race([h.exit,new Promise<any>(resolve=>setTimeout(()=>resolve({code:999}),timeoutMs))]);
    if(r.code===999){await h.cancel();return undefined;}
    await collect;
    if(r.code!==0)return undefined;
    return parseCliVersion(lines.join(' '));
  }catch{return undefined;}
}

export interface DriftCheckDeps {
  runner:ProcessRunner;
  executables:{[provider:string]:string};
  cache:{get():{[provider:string]:VersionCacheEntry}; set(v:{[provider:string]:VersionCacheEntry}):void};
  fetchLatest?:(pkg:string)=>Promise<string|undefined>;
  now?:()=>number;
}

/**
 * Trả về mọi CLI đang tụt version. Cache theo provider để một cửa sổ mở cả ngày
 * không gõ registry mỗi lần refresh — version của binary thì đọc lại mỗi lần vì rẻ.
 */
export async function checkVersionDrift(deps:DriftCheckDeps):Promise<VersionDrift[]>{
  const now=deps.now?deps.now():Date.now();const fetchLatest=deps.fetchLatest||((p:string)=>fetchLatestVersion(p));
  const cache={...deps.cache.get()};let dirty=false;const drifts:VersionDrift[]=[];
  for(const [provider,pkg] of Object.entries(CLI_PACKAGES)){
    const command=deps.executables[provider];if(!command)continue;
    const installed=await readInstalledVersion(deps.runner,command);if(!installed)continue;
    let entry=cache[provider];
    if(!entry||now-entry.at>=CHECK_INTERVAL_MS){entry={at:now,latest:await fetchLatest(pkg)};cache[provider]=entry;dirty=true;}
    if(isOutdated(installed,entry.latest))drifts.push({provider,installed,latest:entry.latest!,pkg});
  }
  if(dirty)deps.cache.set(cache);
  return drifts;
}

export function updateCommandFor(pkg:string){return `npm install -g ${pkg}@latest`;}
