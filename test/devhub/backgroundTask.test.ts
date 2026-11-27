const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
import { SessionStore } from '../../src/devhub/storage/sessionStore';
import { SessionManager } from '../../src/devhub/sessions/sessionManager';
const {ClaudeProvider}=require('../../src/devhub/providers/claude/claudeProvider');

const TOOL='toolu_01WjEngdCKTJXv6MZ8nVRBJB';
/**
 * The real sequence CLI 2.1.272 emits with Dev Hub's exact flags when the model fires a background Bash then
 * ends the turn: `result` closes the turn, then TEN SECONDS LATER the CLI itself queues a `<task-notification>`
 * and runs another report turn — nobody typed anything.
 */
const TURN=[
  {type:'assistant',message:{content:[{type:'tool_use',id:TOOL,name:'Bash',input:{command:'sleep 12; echo BGDONE',run_in_background:true}}]}},
  {type:'system',subtype:'task_started',task_id:'b3qm5kswc',tool_use_id:TOOL,description:'sleep 12; echo BGDONE',is_backgrounded:true,task_type:'local_bash'},
  {type:'user',message:{content:[{tool_use_id:TOOL,type:'tool_result',content:'Command running in background with ID: b3qm5kswc.'}]}},
  {type:'assistant',message:{content:[{type:'text',text:'Launched.'}]}},
  {type:'result',subtype:'success'},
];
const AFTER=[
  {type:'system',subtype:'background_tasks_changed',tasks:[]},
  {type:'system',subtype:'task_updated',task_id:'b3qm5kswc',patch:{status:'completed'}},
  {type:'system',subtype:'task_notification',task_id:'b3qm5kswc',tool_use_id:TOOL,status:'completed',
   summary:'Background command completed (exit code 0)',output_file:'/tmp/tasks/b3qm5kswc.output'},
  {type:'system',subtype:'init',session_id:'bg-1',slash_commands:[]},
  {type:'assistant',message:{content:[{type:'text',text:'Background task completed (exit code 0).'}]}},
  {type:'result',subtype:'success'},
];

function scriptedRunner(){
  return {isAvailable:async()=>true,spawnDuplex(){
    const lines:string[]=[];let wake:any;let done=false;
    const push=(v:any)=>{lines.push(JSON.stringify(v));wake?.();};
    return {alive:()=>!done,pid:1,
      // Only a `user` message opens a turn; a control_request (`get_usage` after `result`) doesn't.
      write(line:string){if(JSON.parse(line).type!=='user')return true;for(const r of TURN)push(r);
        // After `result`: no turn is running, the old turn's generator has returned.
        setTimeout(()=>{for(const r of AFTER)push(r);},5);
        return true;},
      stdoutLines:(async function*(){while(!done){if(lines.length)yield lines.shift();else await new Promise(r=>wake=r);}})(),
      stderrLines:(async function*(){})(),cancel:async()=>{done=true;wake?.();}};
  }};
}

test('a turn the CLI opens after a background task finishes is no longer dropped',async()=>{
  const p=new ClaudeProvider(scriptedRunner(),'claude',10,undefined,undefined,undefined,0);
  const idle:any[]=[];
  p.setIdleEventSink((id:string,e:any)=>idle.push({id,e}));
  try{
    const h=await p.start({cwd:process.cwd(),prompt:'run it in the background'});
    const inTurn:any[]=[];for await(const e of h.events)inTurn.push(e);
    assert.equal(inTurn.at(-1).type,'turn_done','our turn still ends at the first `result`');
    assert.ok(!inTurn.some(e=>e.type==='tool_completed'&&e.callId===TOOL),
      'the background bash row must still be open when the turn ends — a receipt is not a result');
    await new Promise(r=>setTimeout(r,60));
    const kinds=idle.map(x=>x.e.type);
    assert.ok(kinds.includes('tool_completed'),`task_notification must close the bash row: ${kinds}`);
    assert.equal(idle.find(x=>x.e.type==='tool_completed').e.callId,TOOL,'closes EXACTLY the row it opened');
    const say=idle.find(x=>x.e.type==='assistant_message');
    assert.ok(say&&say.e.text.includes('exit code 0'),'the follow-up turn report must arrive');
    assert.equal(kinds.at(-1),'turn_done','the follow-up turn must close too');
  }finally{p.dispose();}
});

test('an unplanned turn flips status and blocks overlapping turns, then releases',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-oot-'));
  const store=new SessionStore(dir);
  const manager=new SessionManager(store,{claude:{id:'claude',isAvailable:async()=>true,
    start:async()=>({getNativeSessionId:()=>'n1',cancel:async()=>{},events:(async function*(){yield {type:'turn_done',timestamp:1} as any;})()}),
    resume:async()=>{throw new Error('unused');},discoverHistory:async()=>[],loadTranscript:async()=>[]} as any},4);
  await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp/r',prompt:'x'});
  await manager.waitForIdle();
  assert.equal((await store.list())[0].status,'done');
  assert.equal(manager.isBusy('claude','n1'),false);

  const seen:any[]=[];manager.on('event',(x:any)=>seen.push(x.event.type));
  manager.ingestOutOfTurn('claude','n1',{type:'tool_completed',tool:'Bash',label:'sleep',callId:TOOL,timestamp:1} as any);
  assert.equal(manager.isBusy('claude','n1'),true,'must be busy, otherwise a user turn overlaps it');
  await manager.waitForIdle();
  assert.equal((await store.list())[0].status,'running');
  manager.ingestOutOfTurn('claude','n1',{type:'assistant_message',text:'all done',timestamp:2} as any);
  manager.ingestOutOfTurn('claude','n1',{type:'turn_done',timestamp:3} as any);
  assert.equal(manager.isBusy('claude','n1'),false);
  await manager.waitForIdle();
  assert.equal((await store.list())[0].status,'done','done again so the queue can flush');
  assert.deepEqual(seen,['tool_completed','assistant_message','turn_done']);
});

test('idle TTL does not reclaim the process while a background task runs',async()=>{
  // The runner stays quiet after `result` so the session sits idle right when the idle timer fires.
  const runner:any={isAvailable:async()=>true,spawnDuplex(){
    const lines:string[]=[];let wake:any;let done=false;
    const push=(v:any)=>{lines.push(JSON.stringify(v));wake?.();};
    return {alive:()=>!done,pid:1,
      write(){push({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'b1',task_type:'local_bash'}]});
        push({type:'result',subtype:'success'});return true;},
      stdoutLines:(async function*(){while(!done){if(lines.length)yield lines.shift();else await new Promise(r=>wake=r);}})(),
      stderrLines:(async function*(){})(),cancel:async()=>{done=true;wake?.();}};
  }};
  const p=new ClaudeProvider(runner,'claude',10,undefined,undefined,undefined,10);   // TTL 10ms
  try{
    const h=await p.start({cwd:process.cwd(),prompt:'x'});
    for await(const e of h.events){}
    await new Promise(r=>setTimeout(r,60));   // several TTLs pass
    assert.equal(p.livePids().length,1,'the process must live to receive the report turn the CLI will open');
  }finally{p.dispose();}
});

test('stop cancels a CLI self-opened turn, no longer a silent no-op',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-ootc-'));
  const store=new SessionStore(dir);
  const killed:string[]=[];
  const manager=new SessionManager(store,{claude:{id:'claude',isAvailable:async()=>true,
    start:async()=>({getNativeSessionId:()=>'n1',cancel:async()=>{},events:(async function*(){yield {type:'turn_done',timestamp:1} as any;})()}),
    resume:async()=>{throw new Error('unused');},discoverHistory:async()=>[],loadTranscript:async()=>[],
    interruptOutOfTurn:async(id:string)=>{killed.push(id);return true;}} as any},4);
  await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp/r',prompt:'x'});
  await manager.waitForIdle();

  // With no unplanned turn, stop must be a real no-op.
  await manager.cancel('claude','n1');
  assert.deepEqual(killed,[],'do not kill the process while the session is idle');
  assert.equal((await store.list())[0].status,'done');

  manager.ingestOutOfTurn('claude','n1',{type:'assistant_message',text:'running',timestamp:1} as any);
  await new Promise(r=>setTimeout(r,20));
  assert.equal((await store.list())[0].status,'running');
  await manager.cancel('claude','n1');
  assert.deepEqual(killed,['n1'],'must reach straight down to the provider');
  assert.equal((await store.list())[0].status,'cancelled','this status is what stops the tab spinner');
  assert.equal(manager.isBusy('claude','n1'),false,'release the lock so a new turn can be sent right away');
});

test('interruptOutOfTurn kills the process even when the real id only arrives after rekey',async()=>{
  const p=new ClaudeProvider(scriptedRunner(),'claude',10,undefined,undefined,undefined,0);
  try{
    const h=await p.start({cwd:process.cwd(),prompt:'run it in the background'});
    for await(const e of h.events){}
    await new Promise(r=>setTimeout(r,60));   // the CLI self-opened turn declared session_id 'bg-1'
    assert.equal(p.livePids().length,1,'the process must be alive before stopping');
    assert.equal(await p.interruptOutOfTurn('bg-1'),true);
    assert.equal(p.livePids().length,0,'the process must be fully dead');
    assert.equal(await p.interruptOutOfTurn('bg-1'),false,'a second stop has nothing to kill');
  }finally{p.dispose();}
});

/** A hand-driven runner: the test decides when the CLI says what and when the process dies. */
function manualRunner(){
  const ctl:any={};
  ctl.runner={isAvailable:async()=>true,spawnDuplex(){
    const lines:string[]=[];let wake:any;let done=false;
    ctl.push=(v:any)=>{lines.push(JSON.stringify(v));wake?.();};
    ctl.crash=()=>{done=true;wake?.();};
    return {alive:()=>!done,pid:1,
      write(line:string){if(JSON.parse(line).type!=='user')return true;
        ctl.push({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'b1',task_type:'local_bash'}]});
        ctl.push({type:'result',subtype:'success'});return true;},
      stdoutLines:(async function*(){while(!done||lines.length){if(lines.length)yield lines.shift();else await new Promise(r=>wake=r);}})(),
      stderrLines:(async function*(){})(),cancel:async()=>{done=true;wake?.();}};
  }};
  return ctl;
}
/** Background task finished, the CLI opened a report turn and it is still running (no `result` yet). */
const SELF_TURN_OPEN=[
  {type:'system',subtype:'background_tasks_changed',tasks:[]},
  {type:'system',subtype:'init',session_id:'bg-1',slash_commands:[]},
  {type:'assistant',message:{content:[{type:'tool_use',id:'toolu_rep',name:'Bash',input:{command:'python3 render.py'}}]}},
];

test('idle TTL does not reclaim the process mid CLI self-opened turn, only after the turn closes',async()=>{
  const ctl=manualRunner();
  const p=new ClaudeProvider(ctl.runner,'claude',10,undefined,undefined,undefined,10);   // TTL 10ms
  try{
    const h=await p.start({cwd:process.cwd(),prompt:'x'});
    for await(const e of h.events){}
    for(const r of SELF_TURN_OPEN)ctl.push(r);
    // `backgroundTasks` is back to 0 — previously this is exactly when the timer closed the process (real transcripts: 1800s/3600s).
    await new Promise(r=>setTimeout(r,60));
    assert.equal(p.livePids().length,1,'the process must live while the report turn runs');
    ctl.push({type:'result',subtype:'success'});
    await new Promise(r=>setTimeout(r,60));
    assert.equal(p.livePids().length,0,'once the turn closes the TTL reclaims as usual');
  }finally{p.dispose();}
});

test('a process dying mid CLI self-opened turn must report an error, not leave the session stuck running',async()=>{
  const ctl=manualRunner();
  const p=new ClaudeProvider(ctl.runner,'claude',10,undefined,undefined,undefined,0);
  const idle:any[]=[];p.setIdleEventSink((id:string,e:any)=>idle.push(e));
  try{
    const h=await p.start({cwd:process.cwd(),prompt:'x'});
    for await(const e of h.events){}
    for(const r of SELF_TURN_OPEN)ctl.push(r);
    await new Promise(r=>setTimeout(r,20));
    ctl.crash();
    await new Promise(r=>setTimeout(r,20));
    assert.equal(idle.at(-1)?.type,'error',`the turn must be closed with an error: ${idle.map(e=>e.type)}`);
    // Without a closing event the manager keeps outOfTurn forever → isBusy true → the queue never flushes.
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-oote-'));
    const store=new SessionStore(dir);
    const manager=new SessionManager(store,{claude:{id:'claude',isAvailable:async()=>true,
      start:async()=>({getNativeSessionId:()=>'n1',cancel:async()=>{},events:(async function*(){yield {type:'turn_done',timestamp:1} as any;})()}),
      resume:async()=>{throw new Error('unused');},discoverHistory:async()=>[],loadTranscript:async()=>[]} as any},4);
    await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp/r',prompt:'x'});
    await manager.waitForIdle();
    for(const e of idle)manager.ingestOutOfTurn('claude','n1',e);
    assert.equal(manager.isBusy('claude','n1'),false,'release the lock so sending can continue');
    await new Promise(r=>setTimeout(r,20));
    assert.equal((await store.list())[0].status,'failed');
  }finally{p.dispose();}
});

test('stopping a CLI self-opened turn adds no error — cancelOutOfTurn already wrote cancelled',async()=>{
  const ctl=manualRunner();
  const p=new ClaudeProvider(ctl.runner,'claude',10,undefined,undefined,undefined,0);
  const idle:any[]=[];p.setIdleEventSink((id:string,e:any)=>idle.push(e));
  try{
    const h=await p.start({cwd:process.cwd(),prompt:'x'});
    for await(const e of h.events){}
    for(const r of SELF_TURN_OPEN)ctl.push(r);
    await new Promise(r=>setTimeout(r,20));
    assert.equal(await p.interruptOutOfTurn('bg-1'),true);
    await new Promise(r=>setTimeout(r,20));
    assert.ok(!idle.some(e=>e.type==='error'),`stop is not an error: ${idle.map(e=>e.type)}`);
  }finally{p.dispose();}
});
