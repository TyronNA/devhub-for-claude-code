export {};
const test=require('node:test'),assert=require('node:assert/strict');
const {ProcessRunner}=require('../../src/devhub/providers/processRunner');
const {ClaudeProvider}=require('../../src/devhub/providers/claude/claudeProvider');
const {SessionManager}=require('../../src/devhub/sessions/sessionManager');
const session={provider:'claude',nativeSessionId:'t',cwd:process.cwd(),status:'done',usage:{inputTokens:9,contextUsedTokens:100}};
function fakeRunner(stall?:string){
 const calls:any[]=[];let cancelled=0;
 return {calls,get cancelled(){return cancelled},spawnDuplex(o:any){calls.push(o);let wake:any;const lines:string[]=[];let done=false;
 const push=(v:any)=>{lines.push(JSON.stringify(v));wake?.();};
 return {alive:()=>!done,write(line:string){const m=JSON.parse(line);if(stall&&m.method===stall)return true;
 if(m.method)push({id:m.id,result:{}});else if(m.type==='user')push({type:'result',subtype:'success'});return true;},
 stdoutLines:(async function*(){while(!done){if(lines.length)yield lines.shift();else await new Promise(r=>wake=r);}})(),stderrLines:(async function*(){})(),
 cancel:async()=>{cancelled++;done=true;wake?.();}};
 }};
}
test('large duplex writes are accepted and delivered exactly once',async()=>{
 const p=new ProcessRunner().spawnDuplex({command:process.execPath,args:['-e','let s="";process.stdin.on("data",b=>{s+=b;if(s.endsWith("\\n")){console.log(s.length);process.exit(0)}})'],cwd:process.cwd()});
 try{assert.equal(p.write('a'.repeat(200000)),true);const lines=[];for await(const l of p.stdoutLines)lines.push(l);assert.deepEqual(lines,['200001']);}finally{await p.cancel();}
});
test('Claude options changes restart and resume, unchanged options reuse process',async()=>{
 const r=fakeRunner();const p=new ClaudeProvider(r,'claude',10,undefined,undefined,undefined,0);
 const drain=async(h:any)=>{for await(const e of h.events){}return h.getNativeSessionId();};
 try{const id=await drain(await p.start({cwd:process.cwd(),prompt:'a',model:'opus',effort:'low'}));
 const s={...session,provider:'claude',nativeSessionId:id};
 await drain(await p.resume({session:s,prompt:'b',model:'opus',effort:'low'}));assert.equal(r.calls.length,1);
 await drain(await p.resume({session:s,prompt:'c',model:'sonnet',effort:'high'}));assert.equal(r.calls.length,2);assert.equal(r.cancelled,1);
 assert.ok(r.calls[1].args.includes(id));assert.ok(r.calls[1].args.includes('sonnet'));assert.ok(r.calls[1].args.includes('high'));
 }finally{p.dispose();}
});
for(const method of ['start','resume'])test(method+' cancels spawned handle if persistence fails',async()=>{
 let cancelled=0;const h={getNativeSessionId:()=> 't',events:(async function*(){})(),cancel:async()=>{cancelled++}};
 const p={isAvailable:async()=>true,start:async()=>h,resume:async()=>h};
 const m=new SessionManager({upsert:async()=>{throw Error('disk full')}},{claude:p});
 await assert.rejects(method==='start'?m.start({...session,prompt:'a'}):m.resume(session,'a'),/disk full/);
 assert.equal(cancelled,1);assert.equal(m.runningCount(),0);
});
