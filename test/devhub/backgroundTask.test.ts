const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
import { SessionStore } from '../../src/devhub/storage/sessionStore';
import { SessionManager } from '../../src/devhub/sessions/sessionManager';
const {ClaudeProvider}=require('../../src/devhub/providers/claude/claudeProvider');

const TOOL='toolu_01WjEngdCKTJXv6MZ8nVRBJB';
/**
 * Chuỗi thật CLI 2.1.272 phát ra với đúng bộ cờ của Dev Hub khi model bắn một Bash nền rồi
 * kết thúc lượt: `result` đóng lượt, rồi MƯỜI GIÂY SAU chính CLI nạp `<task-notification>`
 * vào hàng chờ của nó và chạy tiếp một lượt báo cáo — không ai gõ gì.
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
      // Chỉ message `user` mở lượt; control_request (`get_usage` sau `result`) thì không.
      write(line:string){if(JSON.parse(line).type!=='user')return true;for(const r of TURN)push(r);
        // Sau `result`: không có lượt nào đang chạy, generator của lượt cũ đã return.
        setTimeout(()=>{for(const r of AFTER)push(r);},5);
        return true;},
      stdoutLines:(async function*(){while(!done){if(lines.length)yield lines.shift();else await new Promise(r=>wake=r);}})(),
      stderrLines:(async function*(){})(),cancel:async()=>{done=true;wake?.();}};
  }};
}

test('lượt CLI tự mở sau khi task nền xong không còn rơi xuống sàn',async()=>{
  const p=new ClaudeProvider(scriptedRunner(),'claude',10,undefined,undefined,undefined,0);
  const idle:any[]=[];
  p.setIdleEventSink((id:string,e:any)=>idle.push({id,e}));
  try{
    const h=await p.start({cwd:process.cwd(),prompt:'chạy nền đi'});
    const inTurn:any[]=[];for await(const e of h.events)inTurn.push(e);
    assert.equal(inTurn.at(-1).type,'turn_done','lượt của ta vẫn kết thúc ở `result` đầu');
    assert.ok(!inTurn.some(e=>e.type==='tool_completed'&&e.callId===TOOL),
      'dòng bash nền phải còn mở khi lượt kết thúc — biên nhận không phải kết quả');
    await new Promise(r=>setTimeout(r,60));
    const kinds=idle.map(x=>x.e.type);
    assert.ok(kinds.includes('tool_completed'),`task_notification phải đóng dòng bash: ${kinds}`);
    assert.equal(idle.find(x=>x.e.type==='tool_completed').e.callId,TOOL,'đóng ĐÚNG dòng đã mở');
    const say=idle.find(x=>x.e.type==='assistant_message');
    assert.ok(say&&say.e.text.includes('exit code 0'),'câu báo cáo của lượt nối phải tới nơi');
    assert.equal(kinds.at(-1),'turn_done','lượt nối cũng phải đóng');
  }finally{p.dispose();}
});

test('lượt ngoài kế hoạch lật status và chặn lượt chồng, rồi nhả ra',async()=>{
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
  assert.equal(manager.isBusy('claude','n1'),true,'phải bận, nếu không lượt người dùng chồng lên');
  await new Promise(r=>setTimeout(r,20));
  assert.equal((await store.list())[0].status,'running');
  manager.ingestOutOfTurn('claude','n1',{type:'assistant_message',text:'xong rồi',timestamp:2} as any);
  manager.ingestOutOfTurn('claude','n1',{type:'turn_done',timestamp:3} as any);
  assert.equal(manager.isBusy('claude','n1'),false);
  await new Promise(r=>setTimeout(r,20));
  assert.equal((await store.list())[0].status,'done','done lại để hàng chờ được flush');
  assert.deepEqual(seen,['tool_completed','assistant_message','turn_done']);
});

test('task nền còn chạy thì TTL idle không thu hồi process',async()=>{
  // Runner giữ im sau `result` để session đứng yên đúng lúc hẹn giờ idle nổ.
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
    await new Promise(r=>setTimeout(r,60));   // vài lần TTL trôi qua
    assert.equal(p.livePids().length,1,'process phải sống để nhận lượt báo cáo CLI sẽ tự mở');
  }finally{p.dispose();}
});

test('nút dừng huỷ được lượt CLI tự mở, không còn no-op im lặng',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-ootc-'));
  const store=new SessionStore(dir);
  const killed:string[]=[];
  const manager=new SessionManager(store,{claude:{id:'claude',isAvailable:async()=>true,
    start:async()=>({getNativeSessionId:()=>'n1',cancel:async()=>{},events:(async function*(){yield {type:'turn_done',timestamp:1} as any;})()}),
    resume:async()=>{throw new Error('unused');},discoverHistory:async()=>[],loadTranscript:async()=>[],
    interruptOutOfTurn:async(id:string)=>{killed.push(id);return true;}} as any},4);
  await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp/r',prompt:'x'});
  await manager.waitForIdle();

  // Không có lượt ngoài kế hoạch nào thì dừng phải là no-op thật sự.
  await manager.cancel('claude','n1');
  assert.deepEqual(killed,[],'đừng giết process khi session đang rảnh');
  assert.equal((await store.list())[0].status,'done');

  manager.ingestOutOfTurn('claude','n1',{type:'assistant_message',text:'đang chạy',timestamp:1} as any);
  await new Promise(r=>setTimeout(r,20));
  assert.equal((await store.list())[0].status,'running');
  await manager.cancel('claude','n1');
  assert.deepEqual(killed,['n1'],'phải với thẳng xuống provider');
  assert.equal((await store.list())[0].status,'cancelled','tab dừng quay là nhờ status này');
  assert.equal(manager.isBusy('claude','n1'),false,'nhả khoá để gửi lượt mới được ngay');
});

test('interruptOutOfTurn giết process dù id thật chỉ tới sau rekey',async()=>{
  const p=new ClaudeProvider(scriptedRunner(),'claude',10,undefined,undefined,undefined,0);
  try{
    const h=await p.start({cwd:process.cwd(),prompt:'chạy nền đi'});
    for await(const e of h.events){}
    await new Promise(r=>setTimeout(r,60));   // lượt CLI tự mở đã khai session_id 'bg-1'
    assert.equal(p.livePids().length,1,'process phải còn sống trước khi dừng');
    assert.equal(await p.interruptOutOfTurn('bg-1'),true);
    assert.equal(p.livePids().length,0,'process phải chết hẳn');
    assert.equal(await p.interruptOutOfTurn('bg-1'),false,'dừng lần hai không có gì để giết');
  }finally{p.dispose();}
});

/** Runner điều khiển tay: test tự quyết lúc nào CLI nói gì và lúc nào process chết. */
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
/** Task nền xong, CLI mở lượt báo cáo và đang chạy dở (chưa có `result`). */
const SELF_TURN_OPEN=[
  {type:'system',subtype:'background_tasks_changed',tasks:[]},
  {type:'system',subtype:'init',session_id:'bg-1',slash_commands:[]},
  {type:'assistant',message:{content:[{type:'tool_use',id:'toolu_rep',name:'Bash',input:{command:'python3 render.py'}}]}},
];

test('TTL idle không thu hồi process giữa lượt CLI tự mở, đóng lượt rồi mới thu hồi',async()=>{
  const ctl=manualRunner();
  const p=new ClaudeProvider(ctl.runner,'claude',10,undefined,undefined,undefined,10);   // TTL 10ms
  try{
    const h=await p.start({cwd:process.cwd(),prompt:'x'});
    for await(const e of h.events){}
    for(const r of SELF_TURN_OPEN)ctl.push(r);
    // `backgroundTasks` đã về 0 — trước đây đúng lúc này timer đóng process (transcript thật: 1800s/3600s).
    await new Promise(r=>setTimeout(r,60));
    assert.equal(p.livePids().length,1,'lượt báo cáo đang chạy thì process phải sống');
    ctl.push({type:'result',subtype:'success'});
    await new Promise(r=>setTimeout(r,60));
    assert.equal(p.livePids().length,0,'lượt đóng rồi thì TTL thu hồi như thường');
  }finally{p.dispose();}
});

test('process chết giữa lượt CLI tự mở phải báo lỗi, không để session kẹt running',async()=>{
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
    assert.equal(idle.at(-1)?.type,'error',`lượt phải được đóng bằng error: ${idle.map(e=>e.type)}`);
    // Không có event đóng thì manager giữ outOfTurn mãi → isBusy true → hàng chờ không flush.
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-oote-'));
    const store=new SessionStore(dir);
    const manager=new SessionManager(store,{claude:{id:'claude',isAvailable:async()=>true,
      start:async()=>({getNativeSessionId:()=>'n1',cancel:async()=>{},events:(async function*(){yield {type:'turn_done',timestamp:1} as any;})()}),
      resume:async()=>{throw new Error('unused');},discoverHistory:async()=>[],loadTranscript:async()=>[]} as any},4);
    await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp/r',prompt:'x'});
    await manager.waitForIdle();
    for(const e of idle)manager.ingestOutOfTurn('claude','n1',e);
    assert.equal(manager.isBusy('claude','n1'),false,'nhả khoá để gửi tiếp được');
    await new Promise(r=>setTimeout(r,20));
    assert.equal((await store.list())[0].status,'failed');
  }finally{p.dispose();}
});

test('dừng lượt CLI tự mở không sinh thêm lỗi — cancelOutOfTurn đã ghi cancelled',async()=>{
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
    assert.ok(!idle.some(e=>e.type==='error'),`stop không phải lỗi: ${idle.map(e=>e.type)}`);
  }finally{p.dispose();}
});
