export {};
const test=require('node:test'),assert=require('node:assert/strict');
const {ProcessRunner}=require('../../src/devhub/providers/processRunner');
const {ClaudeProvider}=require('../../src/devhub/providers/claude/claudeProvider');
const {CodexAppServer}=require('../../src/devhub/providers/codex/codexAppServer');
const {SessionManager}=require('../../src/devhub/sessions/sessionManager');
const session={provider:'codex',nativeSessionId:'t',cwd:process.cwd(),status:'done',usage:{inputTokens:9,contextUsedTokens:100}};
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
for(const stage of ['initialize','thread/resume','thread/compact/start'])test('compact deadline covers '+stage,async()=>{
 const r=fakeRunner(stage),server=new CodexAppServer(r);let error:any;
 const task=server.compact('t',process.cwd(),()=>{},{timeoutMs:20}).catch((e:any)=>{error=e;});
 await Promise.race([task,new Promise(r=>setTimeout(r,100))]);
 try{assert.match(error?.message||'',/timed out/);assert.equal(r.cancelled,1);}finally{await server.close();}
});
for(const method of ['start','resume'])test(method+' cancels spawned handle if persistence fails',async()=>{
 let cancelled=0;const h={getNativeSessionId:()=> 't',events:(async function*(){})(),cancel:async()=>{cancelled++}};
 const p={isAvailable:async()=>true,start:async()=>h,resume:async()=>h};
 const m=new SessionManager({upsert:async()=>{throw Error('disk full')}},{codex:p});
 await assert.rejects(method==='start'?m.start({...session,prompt:'a'}):m.resume(session,'a'),/disk full/);
 assert.equal(cancelled,1);assert.equal(m.runningCount(),0);
});
test('out of turn usage persists and broadcasts the updated session',async()=>{
 let saved:any,updated:any;const m=new SessionManager({get:async()=>session,upsert:async(s:any)=>{saved=s}},{});
 m.on('sessionUpdated',(s:any)=>updated=s);
 await m.updateUsage(session,{contextUsedTokens:20});assert.equal(saved.usage.contextUsedTokens,20);assert.equal(saved.usage.inputTokens,9);assert.equal(updated,saved);
});
test('historical usage fills missing cache counters without adding them twice',async()=>{
 let saved:any,current:any={...session,usage:{contextUsedTokens:100}};const m=new SessionManager({get:async()=>current,upsert:async(s:any)=>{current=s;saved=s}},{});
 const restored=await m.restoreHistoricalUsage(session,{inputTokens:21880,cachedInputTokens:12160,cacheWriteInputTokens:400,outputTokens:225,reasoningOutputTokens:12});
 assert.deepEqual(restored.usage,{contextUsedTokens:100,inputTokens:21880,cachedInputTokens:12160,cacheWriteInputTokens:400,outputTokens:225,reasoningOutputTokens:12});
 assert.deepEqual(saved.usage,restored.usage);
 const again=await m.restoreHistoricalUsage(restored,{inputTokens:99999,cachedInputTokens:99999});
 assert.equal(again.usage.inputTokens,21880);
 assert.equal(again.usage.cachedInputTokens,12160);
});
