const cp=require('node:child_process');
const util=require('node:util');
const os=require('node:os');
const path=require('node:path');
const execFile=util.promisify(cp.execFile);

/** `kind:'http'` = bot có API loopback (planner): con của nó là task đọc qua HTTP, không
 *  phải thread đọc từ SQLite. Start/stop/logs vẫn là Makefile như mọi bot khác. */
export interface AgentSpec { name:string; cwd:string; start?:string; stop?:string; status?:string; logs?:string; db?:string; kind?:'process'|'http'; endpoint?:string; }
export interface AgentState { spec:AgentSpec; running:boolean; detail:string; }

export function expandHome(p:string){return p.startsWith('~')?path.join(os.homedir(),p.slice(1)):p;}

/** Makefile của cả hai bot đều in "running (pid=…)" hoặc "not running". */
export function parseStatus(out:string):{running:boolean;detail:string}{
  const t=String(out||'').trim();
  const running=/(^|\b)running\b/i.test(t)&&!/not\s+running/i.test(t);
  return {running,detail:t.split('\n')[0]?.slice(0,120)||(running?'running':'stopped')};
}

/** Bốn verb đi thẳng vào `/bin/sh -lc`; non-string thì bỏ để rơi về `make <verb>` chứ
 *  đừng đẩy nguyên object xuống execFile. */
const verb=(v:any)=>typeof v==='string'&&v.trim()?v:undefined;
export function normalizeAgents(raw:any):AgentSpec[]{
  if(!Array.isArray(raw))return [];
  return raw.filter((a:any)=>a&&typeof a.name==='string'&&typeof a.cwd==='string')
            .map((a:any)=>({name:a.name,cwd:expandHome(a.cwd),start:verb(a.start),stop:verb(a.stop),status:verb(a.status),logs:verb(a.logs),
                            ...(typeof a.db==='string'&&a.db?{db:expandHome(a.db)}:{}),
                            ...(a.kind==='http'?{kind:'http' as const}:{}),
                            ...(typeof a.endpoint==='string'&&a.endpoint?{endpoint:a.endpoint}:{})}));
}

const DEFAULTS:Record<string,string>={start:'make start',stop:'make stop',status:'make status',logs:'make logs'};

export class AgentRunner {
  constructor(private timeoutMs=8000){}
  private cmd(spec:AgentSpec,verb:string){return (spec as any)[verb]||DEFAULTS[verb];}
  async status(spec:AgentSpec):Promise<AgentState>{
    try{
      const {stdout}=await execFile('/bin/sh',['-lc',this.cmd(spec,'status')],{cwd:spec.cwd,timeout:this.timeoutMs});
      return {spec,...parseStatus(String(stdout))};
    }catch(e:any){return {spec,running:false,detail:`unavailable: ${String(e?.message||e).slice(0,80)}`};}
  }
  async run(spec:AgentSpec,verb:'start'|'stop'):Promise<string>{
    const {stdout,stderr}=await execFile('/bin/sh',['-lc',this.cmd(spec,verb)],{cwd:spec.cwd,timeout:this.timeoutMs*4});
    return String(stdout||stderr||'').trim();
  }
  logsCommand(spec:AgentSpec){return this.cmd(spec,'logs');}
}
