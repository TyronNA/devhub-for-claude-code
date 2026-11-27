const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

/** `max>0`: a size-capped buffer that drops the oldest line. Only used for stderr — which may
 *  have no consumer; losing a stdout line loses an event, so stdout is always unbounded. */
class AsyncLineQueue {
  private values:string[]=[]; private waiters:any[]=[]; private done=false;
  constructor(private max=0){}
  push(v:string){ if(this.done)return; const w=this.waiters.shift(); if(w){ w({value:v,done:false}); return; }
    this.values.push(v); if(this.max>0) while(this.values.length>this.max) this.values.shift(); }
  close(){ if(this.done)return; this.done=true; while(this.waiters.length) this.waiters.shift()({value:undefined,done:true}); }
  [Symbol.asyncIterator](){ return this; }
  next(){ if(this.values.length) return Promise.resolve({value:this.values.shift(),done:false}); if(this.done) return Promise.resolve({value:undefined,done:true}); return new Promise(resolve=>this.waiters.push(resolve)); }
}

const STDERR_MAX_LINES=500;

/**
 * Descendants of the CLI process, by ppid, at any depth.
 * Process groups aren't used: Claude CLI runs each Bash command in its OWN group (measured on
 * 2.1.272 — the child zsh's pgid differs from claude's), so `kill(-pgid)` doesn't reach it.
 */
async function descendants(root:number):Promise<number[]>{
  const rows=await new Promise<string>(resolve=>{
    try{cp.execFile('ps',['-axo','pid=,ppid='],{maxBuffer:4*1024*1024},(_e:any,out:any)=>resolve(String(out||'')));}
    catch{resolve('');}
  });
  const kids=new Map<number,number[]>();
  for(const line of rows.split('\n')){
    const m=line.trim().split(/\s+/); const pid=Number(m[0]),ppid=Number(m[1]);
    if(!pid||!ppid)continue; const a=kids.get(ppid); if(a)a.push(pid); else kids.set(ppid,[pid]);
  }
  const out:number[]=[]; const stack=[root];
  while(stack.length){ const p=stack.pop() as number;
    for(const c of kids.get(p)||[]){ if(c===p||out.indexOf(c)>=0)continue; out.push(c); stack.push(c); } }
  return out;
}

/**
 * Kills the subtree captured BEFORE the parent dies — once the parent dies the grandchildren are reparented to launchd and
 * can't be traced any more. TERM first so they clean up, KILL only the stubborn ones.
 * A pid may have been reassigned to another process in between; the window is a few hundred ms, so that's accepted.
 */
async function killTree(pids:number[]){
  if(!pids.length)return;
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
  for(const pid of pids.slice().reverse())try{process.kill(pid,'SIGTERM');}catch{}
  await new Promise(r=>setTimeout(r,800));
  for(const pid of pids)if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}
}

export interface SpawnLineOptions { command:string; args:string[]; cwd:string; env?:any; signal?:any; stdinText?:string; }
export interface SpawnedLineProcess { stdoutLines:AsyncIterable<string>; stderrLines:AsyncIterable<string>; exit:Promise<{code:number|null;signal:any}>; cancel():Promise<void>; }

export interface DuplexProcess { stdoutLines:AsyncIterable<string>; stderrLines:AsyncIterable<string>; write(line:string):boolean; exit:Promise<{code:number|null;signal:any}>; cancel():Promise<void>; alive():boolean; pid?:number; }

export class ProcessRunner {
  /** stdin stays open for the whole lifetime: used for `--input-format stream-json`, one process for many turns. */
  spawnDuplex(options:SpawnLineOptions):DuplexProcess {
    const stdoutQ:any=new AsyncLineQueue(); const stderrQ:any=new AsyncLineQueue(STDERR_MAX_LINES);
    const child=cp.spawn(options.command,options.args,{cwd:options.cwd,env:options.env ?? process.env,stdio:['pipe','pipe','pipe'],signal:options.signal});
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    let outBuf='',errBuf='';
    const feed=(kind:'out'|'err',chunk:any)=>{
      let buf=(kind==='out'?outBuf:errBuf)+String(chunk); const parts=buf.split(/\r?\n/); const remain=parts.pop() ?? '';
      for(const line of parts)(kind==='out'?stdoutQ:stderrQ).push(line);
      if(kind==='out')outBuf=remain; else errBuf=remain;
    };
    child.stdout?.on('data',(c:any)=>feed('out',c)); child.stderr?.on('data',(c:any)=>feed('err',c));
    child.stdin?.on('error',()=>{}); // EPIPE when the process dies before the write
    let closed=false;
    const exit=new Promise<{code:number|null;signal:any}>(resolve=>{
      child.once('error',()=>{closed=true;stdoutQ.close();stderrQ.close();resolve({code:null,signal:null});});
      child.once('close',(code:any,signal:any)=>{closed=true;if(outBuf)stdoutQ.push(outBuf);if(errBuf)stderrQ.push(errBuf);stdoutQ.close();stderrQ.close();resolve({code,signal});});
    });
    const cancel=async()=>{ if(closed)return;
      // Capture the subtree before any signal: SIGTERM to the parent alone doesn't reach the background commands it spawned.
      const kids=child.pid?await descendants(child.pid):[];
      try{child.stdin?.end();}catch{} child.kill('SIGTERM');
      await Promise.race([exit,new Promise(r=>setTimeout(r,1200))]);
      if(!closed)child.kill('SIGKILL');
      await killTree(kids); };
    return {stdoutLines:stdoutQ,stderrLines:stderrQ,exit,cancel,
      pid:child.pid,
      alive:()=>!closed,
      write:(line:string)=>{ if(closed||!child.stdin?.writable||child.stdin.destroyed)return false; try{child.stdin.write(line.endsWith('\n')?line:line+'\n'); return true;}catch{return false;} }};
  }

  spawnLines(options:SpawnLineOptions):SpawnedLineProcess {
    const stdoutQ:any=new AsyncLineQueue(); const stderrQ:any=new AsyncLineQueue(STDERR_MAX_LINES);
    const child=cp.spawn(options.command, options.args, {cwd:options.cwd, env:options.env ?? process.env, stdio:['pipe','pipe','pipe'], signal:options.signal});
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    let stdoutBuf=''; let stderrBuf='';
    const feed=(kind:'out'|'err', chunk:any)=>{
      let buf=(kind==='out'?stdoutBuf:stderrBuf)+String(chunk); const parts=buf.split(/\r?\n/); const remain=parts.pop() ?? '';
      for(const line of parts) (kind==='out'?stdoutQ:stderrQ).push(line);
      if(kind==='out') stdoutBuf=remain; else stderrBuf=remain;
    };
    child.stdout?.on('data',(c:any)=>feed('out',c)); child.stderr?.on('data',(c:any)=>feed('err',c));
    // stdinText larger than the pipe buffer (64KB) with the CLI dying before reading: an EPIPE not caught here
    // crashes the whole extension host, not just this turn.
    child.stdin?.on('error',()=>{});
    if(options.stdinText !== undefined){ child.stdin?.end(options.stdinText); }
    else child.stdin?.end();
    const exit = new Promise<{code:number|null;signal:any}>((resolve,reject)=>{
      child.once('error',(e:any)=>{ stdoutQ.close(); stderrQ.close(); reject(e); });
      child.once('close',(code:any,signal:any)=>{ if(stdoutBuf) stdoutQ.push(stdoutBuf); if(stderrBuf) stderrQ.push(stderrBuf); stdoutQ.close(); stderrQ.close(); resolve({code,signal}); });
    });
    const cancel=async()=>{ if(child.exitCode!==null || child.signalCode!==null) return;
      const kids=child.pid?await descendants(child.pid):[];
      child.kill('SIGTERM'); await Promise.race([exit.catch(()=>{}),new Promise(r=>setTimeout(r,1200))]);
      if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
      await killTree(kids); };
    return {stdoutLines:stdoutQ, stderrLines:stderrQ, exit, cancel};
  }
  /** Timed out = the file exists and ran, just slowly (a ~300MB binary starting from swap under heavy load
   *  exceeds 2.5s) — count it as present. Report "not found" only on a spawn error or a non-zero exit. */
  async isAvailable(command:string,timeoutMs=2500):Promise<boolean>{
    try { const h=this.spawnLines({command,args:['--version'],cwd:process.cwd()}); const r=await Promise.race([h.exit,new Promise<any>(resolve=>setTimeout(()=>resolve({code:999}),timeoutMs))]); if(r.code===999){ void h.cancel(); return true; } return r.code===0; } catch { return false; }
  }
}
