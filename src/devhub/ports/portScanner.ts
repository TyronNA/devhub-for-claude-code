const cp=require('node:child_process');
const util=require('node:util');
const execFile=util.promisify(cp.execFile);
const path=require('node:path');
import { projectForCwd } from '../providers/historyUtils';

// group: the proc's original group, only set when it's pulled into the Pinned group — which loses the project context.
export interface ListeningProc { pid:number; command:string; cwd?:string; ports:number[]; group?:string; }
export interface PortGroup { name:string; projectId?:string; known:boolean; pinned?:boolean; procs:ListeningProc[]; }

/**
 * `lsof -F` prints one field per line, prefixed by the field name: p=pid, c=command, n=name.
 * The p/c fields belong to the process and apply to every following n line until the next process.
 */
function parseFields(out:string,onName:(pid:number,command:string,name:string)=>void){
  let pid=0,command='';
  for(const line of String(out||'').split('\n')){
    const tag=line[0],val=line.slice(1);
    if(tag==='p'){pid=Number(val)||0;command='';}
    else if(tag==='c')command=val;
    else if(tag==='n'&&pid)onName(pid,command,val);
  }
}

/** `*:8080`, `127.0.0.1:8080`, `[::1]:8080` -> 8080. */
export function portOf(name:string):number|undefined{
  const m=/:(\d+)$/.exec(String(name||''));
  const n=m?Number(m[1]):NaN;
  return Number.isInteger(n)&&n>0?n:undefined;
}

export function parseListen(out:string):Map<number,ListeningProc>{
  const byPid=new Map<number,ListeningProc>();
  parseFields(out,(pid,command,name)=>{
    const port=portOf(name); if(port===undefined)return;
    let p=byPid.get(pid);
    if(!p){p={pid,command:command||String(pid),ports:[]};byPid.set(pid,p);}
    // The same port shows up twice when a process binds both IPv4 and IPv6.
    if(!p.ports.includes(port))p.ports.push(port);
  });
  for(const p of byPid.values())p.ports.sort((a,b)=>a-b);
  return byPid;
}

export function parseCwds(out:string):Map<number,string>{
  const cwds=new Map<number,string>();
  parseFields(out,(pid,_c,name)=>{if(!cwds.has(pid))cwds.set(pid,name);});
  return cwds;
}

/** No root, so only the user's own processes are visible — exactly the scope needed. */
export async function scanListeningPorts(timeoutMs=5000):Promise<ListeningProc[]>{
  let listen='';
  try{ listen=(await execFile('lsof',['-nP','-iTCP','-sTCP:LISTEN','-F','pcn'],{timeout:timeoutMs,maxBuffer:1<<22})).stdout; }
  catch(e:any){ listen=String(e?.stdout||''); if(!listen)return []; }
  const byPid=parseListen(listen);
  if(!byPid.size)return [];
  const pids=[...byPid.keys()].join(',');
  let cwdOut='';
  try{ cwdOut=(await execFile('lsof',['-a','-d','cwd','-p',pids,'-F','pn'],{timeout:timeoutMs,maxBuffer:1<<22})).stdout; }
  catch(e:any){ cwdOut=String(e?.stdout||''); }
  const cwds=parseCwds(cwdOut);
  for(const p of byPid.values()){const c=cwds.get(p.pid);if(c&&c!=='/')p.cwd=c;}
  return [...byPid.values()].sort((a,b)=>a.ports[0]-b.ports[0]);
}

const SYSTEM='System';
export const PINNED='Pinned';
/**
 * The cwd basename is the repo name in most cases, EXCEPT when the process runs from
 * `~/Library` — there it is an app's internal folder (docker gives `Data`), so use the command
 * name as the label instead of a meaningless word.
 */
function groupNameFor(proc:ListeningProc){
  if(!proc.cwd)return '';
  if(proc.cwd.includes(`${path.sep}Library${path.sep}`))return proc.command;
  return path.basename(proc.cwd);
}
/**
 * Grouped by Dev Hub project. Repos not added to Dev Hub still get their own group by
 * cwd folder name — lumping them together would mix real servers with system daemons.
 */
export function groupPortsByProject(procs:ListeningProc[],projects:any[],pinned?:Iterable<number>,agents?:{name:string;cwd:string}[]):PortGroup[]{
  const pins=new Set<number>(pinned?[...pinned]:[]);
  // Agents reuse the project prefix match: an agent's cwd is the bot repo's rootPath.
  const agentRoots=(agents||[]).filter(a=>a&&a.name&&a.cwd).map(a=>({name:a.name,rootPath:a.cwd}));
  const groups=new Map<string,PortGroup>();
  const put=(name:string,project:any,proc:ListeningProc,isPin:boolean,agent?:any)=>{
    // Key ≠ label: two projects with different paths but the same basename ("api") sharing a key would be
    // merged into one group. The label is still the name; the cwd in the tooltip tells same-named groups apart.
    const key=isPin?PINNED:project?'p:'+project.id:agent?'a:'+agent.name:'n:'+name+'\u0000'+(proc.cwd||'');
    let g=groups.get(key);
    if(!g){g={name,projectId:project?.id,known:!!project,...(isPin?{pinned:true}:{}),procs:[]};groups.set(key,g);}
    g.procs.push(proc);
  };
  for(const proc of procs){
    const project=proc.cwd?projectForCwd(projects,proc.cwd):undefined;
    // A bot running from a repo not added to Dev Hub: use the agent name, or the Ports group calls it
    // by folder basename while the Agents section calls it by name — one process, two names.
    const agent=!project&&proc.cwd?projectForCwd(agentRoots,proc.cwd):undefined;
    const name=project?.name??agent?.name??(groupNameFor(proc)||SYSTEM);
    // A pinned port MOVES to the Pinned group rather than sitting in both — duplicate tree rows are hard to read.
    const pinnedPorts=pins.size?proc.ports.filter(p=>pins.has(p)):[];
    if(!pinnedPorts.length){put(name,project,proc,false,agent);continue;}
    put(PINNED,undefined,{...proc,ports:pinnedPorts,group:name},true);
    const rest=proc.ports.filter(p=>!pins.has(p));
    if(rest.length)put(name,project,{...proc,ports:rest},false,agent);
  }
  return [...groups.values()].sort((a,b)=>
    (a.name===PINNED?0:1)-(b.name===PINNED?0:1)||
    (a.name===SYSTEM?1:0)-(b.name===SYSTEM?1:0)||
    (b.known?1:0)-(a.known?1:0)||a.name.localeCompare(b.name));
}
