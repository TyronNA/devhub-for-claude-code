const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

/** `max>0`: hàng chờ chặn kích thước, drop dòng cũ nhất. Chỉ dùng cho stderr — nơi có
 *  thể không ai consume; stdout mất dòng là mất event nên luôn để không chặn. */
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
 * Con cháu của process CLI, theo ppid, sâu bao nhiêu cũng lấy.
 * Không dùng process group: Claude CLI chạy mỗi lệnh Bash trong group RIÊNG (đo được trên
 * 2.1.272 — pgid của zsh con khác hẳn pgid của claude), nên `kill(-pgid)` không với tới nó.
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
 * Giết cây con đã chụp TRƯỚC khi bố chết — bố chết rồi thì cháu về làm con của launchd và
 * không còn đường lần ra. TERM trước cho nó tự dọn, ai lì mới KILL.
 * Pid có thể đã được cấp lại cho process khác trong khoảng này; cửa sổ vài trăm ms nên chấp nhận.
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
  /** stdin mở suốt vòng đời: dùng cho `--input-format stream-json`, một process nhiều lượt. */
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
    child.stdin?.on('error',()=>{}); // EPIPE khi process chết trước lúc ghi
    let closed=false;
    const exit=new Promise<{code:number|null;signal:any}>(resolve=>{
      child.once('error',()=>{closed=true;stdoutQ.close();stderrQ.close();resolve({code:null,signal:null});});
      child.once('close',(code:any,signal:any)=>{closed=true;if(outBuf)stdoutQ.push(outBuf);if(errBuf)stderrQ.push(errBuf);stdoutQ.close();stderrQ.close();resolve({code,signal});});
    });
    const cancel=async()=>{ if(closed)return;
      // Chụp cây con trước mọi signal: SIGTERM cho mình bố không lan xuống lệnh nền nó đẻ ra.
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
    // stdinText lớn hơn buffer pipe (64KB) mà CLI chết trước khi đọc: EPIPE không ai bắt ở đây
    // là sập cả extension host, không chỉ lượt này.
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
  /** Quá hạn = file có và đã chạy, chỉ chậm (binary ~300MB khởi động từ swap lúc máy tải
   *  cao vượt 2.5s) — coi là có. Báo "not found" chỉ khi spawn lỗi hoặc exit khác 0. */
  async isAvailable(command:string,timeoutMs=2500):Promise<boolean>{
    try { const h=this.spawnLines({command,args:['--version'],cwd:process.cwd()}); const r=await Promise.race([h.exit,new Promise<any>(resolve=>setTimeout(()=>resolve({code:999}),timeoutMs))]); if(r.code===999){ void h.cancel(); return true; } return r.code===0; } catch { return false; }
  }
}
