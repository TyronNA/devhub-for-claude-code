const cp = require('node:child_process');

export interface PsRow { pid:number; ppid:number; rssKb:number; }

/** `ps -Ao pid=,ppid=,rss=`: three columns, no header. Junk lines are skipped, not thrown. */
export function parsePsRows(out:string):PsRow[]{
  const rows:PsRow[]=[];
  for(const line of String(out).split('\n')){
    const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if(m)rows.push({pid:+m[1],ppid:+m[2],rssKb:+m[3]});
  }
  return rows;
}

/**
 * `claude`'s RSS does NOT include the MCP servers it spawns, and those are what bloat (one stdio server
 * = 2 node processes for EACH chat). So sum the whole subtree, with `seen` so a pid under two roots
 * isn't counted twice.
 */
export function sumRssKb(rows:PsRow[],roots:number[]):number{
  const kids=new Map<number,number[]>(); const rss=new Map<number,number>();
  for(const r of rows){ rss.set(r.pid,r.rssKb); const k=kids.get(r.ppid); if(k)k.push(r.pid); else kids.set(r.ppid,[r.pid]); }
  const seen=new Set<number>(); const stack=[...roots]; let total=0;
  while(stack.length){
    const pid=stack.pop()!;
    if(seen.has(pid)||!rss.has(pid))continue;
    seen.add(pid); total+=rss.get(pid)!;
    for(const kid of kids.get(pid)||[])stack.push(kid);
  }
  return total;
}

/** Total RAM (MB) of those pids and their descendants. 0 pids = no `ps` spawned at all. */
export async function cliMemoryMB(pids:number[],exec:(cmd:string,args:string[])=>Promise<string> = run):Promise<number>{
  if(!pids.length)return 0;
  const out=await exec('ps',['-Ao','pid=,ppid=,rss=']);
  return Math.round(sumRssKb(parsePsRows(out),pids)/1024);
}

function run(cmd:string,args:string[]):Promise<string>{
  return new Promise((resolve,reject)=>{
    cp.execFile(cmd,args,{timeout:3000,maxBuffer:8*1024*1024},(err:any,stdout:string)=>err?reject(err):resolve(stdout));
  });
}
