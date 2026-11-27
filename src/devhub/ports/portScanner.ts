const cp=require('node:child_process');
const util=require('node:util');
const execFile=util.promisify(cp.execFile);
const path=require('node:path');
import { projectForCwd } from '../providers/historyUtils';

// group: nhóm gốc của proc, chỉ set khi nó bị kéo sang nhóm Pinned — ở đó mất ngữ cảnh project.
export interface ListeningProc { pid:number; command:string; cwd?:string; ports:number[]; group?:string; }
export interface PortGroup { name:string; projectId?:string; known:boolean; pinned?:boolean; procs:ListeningProc[]; }

/**
 * `lsof -F` in ra từng field một dòng, tiền tố là tên field: p=pid, c=command, n=name.
 * Field p/c dính vào process và áp cho mọi dòng n phía sau tới process kế tiếp.
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
    // Cùng một cổng xuất hiện hai lần khi process bind cả IPv4 và IPv6.
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

/** Không có quyền root nên chỉ thấy process của chính user — đúng phạm vi cần. */
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
 * Basename của cwd là tên repo trong hầu hết trường hợp, TRỪ khi process chạy từ
 * `~/Library` — ở đó nó là thư mục nội bộ của app (docker cho ra `Data`), nên lấy tên
 * lệnh làm nhãn thay vì một từ vô nghĩa.
 */
function groupNameFor(proc:ListeningProc){
  if(!proc.cwd)return '';
  if(proc.cwd.includes(`${path.sep}Library${path.sep}`))return proc.command;
  return path.basename(proc.cwd);
}
/**
 * Group theo project của Dev Hub. Repo chưa add vào Dev Hub vẫn được nhóm riêng theo
 * tên thư mục cwd — nếu dồn hết vào một nhóm thì server thật lẫn với daemon hệ thống.
 */
export function groupPortsByProject(procs:ListeningProc[],projects:any[],pinned?:Iterable<number>,agents?:{name:string;cwd:string}[]):PortGroup[]{
  const pins=new Set<number>(pinned?[...pinned]:[]);
  // Agent dùng lại khớp-prefix của project: cwd của nó chính là rootPath của repo bot.
  const agentRoots=(agents||[]).filter(a=>a&&a.name&&a.cwd).map(a=>({name:a.name,rootPath:a.cwd}));
  const groups=new Map<string,PortGroup>();
  const put=(name:string,project:any,proc:ListeningProc,isPin:boolean,agent?:any)=>{
    // Key ≠ nhãn: hai project khác path nhưng cùng basename ("api") mà chung key thì bị
    // gộp thành một nhóm. Nhãn vẫn là tên; cwd trong tooltip phân biệt hai nhóm trùng tên.
    const key=isPin?PINNED:project?'p:'+project.id:agent?'a:'+agent.name:'n:'+name+'\u0000'+(proc.cwd||'');
    let g=groups.get(key);
    if(!g){g={name,projectId:project?.id,known:!!project,...(isPin?{pinned:true}:{}),procs:[]};groups.set(key,g);}
    g.procs.push(proc);
  };
  for(const proc of procs){
    const project=proc.cwd?projectForCwd(projects,proc.cwd):undefined;
    // Bot chạy từ repo chưa add vào Dev Hub: lấy tên agent, nếu không nhóm Ports gọi nó
    // bằng basename thư mục còn mục Agents gọi bằng name — cùng một process, hai cái tên.
    const agent=!project&&proc.cwd?projectForCwd(agentRoots,proc.cwd):undefined;
    const name=project?.name??agent?.name??(groupNameFor(proc)||SYSTEM);
    // Ghim thì cổng đó SANG nhóm Pinned, không nằm cả hai chỗ — cây có dòng trùng thì khó đọc.
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
