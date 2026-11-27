export {};
const test=require('node:test');const assert=require('node:assert/strict');
const http=require('node:http');
import { PlannerWatcher, PlannerReminderPush } from '../../src/devhub/providers/planner/plannerWatcher';

/**
 * Daemon giả chỉ có `/stream`: watcher phải giữ ống mở khi KHÔNG có lượt nào chạy — đó là cả
 * lý do nó tồn tại. `messages` trả lời `/conversations/{id}/messages`.
 */
function fakeDaemon(messages:any[]=[],port=0){
  let sse:any;const conns:any[]=[];
  const server=http.createServer((req:any,res:any)=>{
    if(req.url==='/stream'){
      res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders?.();
      sse=res;conns.push(res);return;
    }
    if(req.url?.startsWith('/conversations/')){
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({messages}));return;
    }
    res.writeHead(404);res.end();
  });
  return new Promise<any>(resolve=>server.listen(port,'127.0.0.1',()=>resolve({
    endpoint:`http://127.0.0.1:${server.address().port}`,port:server.address().port,
    frame:(kind:string,data:any)=>sse?.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`),
    raw:(text:string)=>sse?.write(text),
    ready:async()=>{for(let i=0;i<200&&!sse;i++)await new Promise(r=>setTimeout(r,5));return !!sse;},
    drop:()=>{for(const c of conns)try{c.destroy();}catch{}sse=undefined;},
    close:()=>new Promise<void>(r=>{for(const c of conns)try{c.end();}catch{}server.close(()=>r());}),
  })));
}

const settle=()=>new Promise(r=>setTimeout(r,60));

test('a fired reminder reaches the host with no turn in flight',async()=>{
  const d=await fakeDaemon();
  const got:PlannerReminderPush[]=[];
  const w=new PlannerWatcher(p=>got.push(p));
  try{
    w.watch([d.endpoint]);
    assert.ok(await d.ready(),'watcher phải tự mở /stream, không chờ lượt nào');
    d.frame('reminder_fired',{conversation_id:'chat:agent-acme',payload:{
      reminder_id:7,note:'báo khi có plan',jira_key:'KRP-11922',
      moved:['ANALYZING','WAITING_APPROVAL'],reply:'plan v1 xong, confidence 0.6'}});
    await settle();
    assert.equal(got.length,1);
    assert.deepEqual({...got[0],endpoint:''},{endpoint:'',conversationId:'chat:agent-acme',
      reminderId:7,note:'báo khi có plan',jiraKey:'KRP-11922',
      reply:'plan v1 xong, confidence 0.6',movedFrom:'ANALYZING',movedTo:'WAITING_APPROVAL'});
  } finally { w.dispose();await d.close(); }
});

test('view and message frames are ignored — only reminder_fired carries a full reply',async()=>{
  const d=await fakeDaemon();
  const got:PlannerReminderPush[]=[];
  const w=new PlannerWatcher(p=>got.push(p));
  try{
    w.watch([d.endpoint]);await d.ready();
    // `view` là message bị edit tại chỗ; `message` chỉ là placeholder "⏳ processing".
    d.frame('view',{conversation_id:'chat:x',payload:{text:'⏳ processing… 2s'}});
    d.frame('message',{conversation_id:'chat:x',payload:{text:'⏳ processing…'}});
    d.frame('heartbeat',{});
    d.raw(': comment\n\n');
    await settle();
    assert.deepEqual(got,[]);
  } finally { w.dispose();await d.close(); }
});

test('a frame with no conversation id is dropped rather than fired at a random tab',async()=>{
  const d=await fakeDaemon();
  const got:PlannerReminderPush[]=[];
  const w=new PlannerWatcher(p=>got.push(p));
  try{
    w.watch([d.endpoint]);await d.ready();
    d.frame('reminder_fired',{payload:{note:'mồ côi',reply:'x'}});
    await settle();
    assert.deepEqual(got,[]);
  } finally { w.dispose();await d.close(); }
});

test('the watch reconnects after the daemon drops the stream',async()=>{
  const d=await fakeDaemon();
  const got:PlannerReminderPush[]=[];
  const w=new PlannerWatcher(p=>got.push(p));
  try{
    w.watch([d.endpoint]);await d.ready();
    d.drop();                       // `make restart` bên daemon
    assert.ok(await d.ready(),'phải tự nối lại, không chờ ai bấm gì');
    d.frame('reminder_fired',{conversation_id:'chat:x',payload:{note:'sau restart',reply:'ok'}});
    await settle();
    assert.deepEqual(got.map(g=>g.note),['sau restart']);
  } finally { w.dispose();await d.close(); }
});

test('an endpoint dropped from settings stops being watched',async()=>{
  const d=await fakeDaemon();
  const got:PlannerReminderPush[]=[];
  const w=new PlannerWatcher(p=>got.push(p));
  try{
    w.watch([d.endpoint]);await d.ready();
    w.watch([]);
    await settle();
    d.frame('reminder_fired',{conversation_id:'chat:x',payload:{note:'không ai nghe',reply:'x'}});
    await settle();
    assert.deepEqual(got,[],'bỏ agent khỏi settings là bỏ luôn ống');
  } finally { w.dispose();await d.close(); }
});

test('a planner transcript carries the stored turns, so a reminder survives a closed panel',async()=>{
  const {PlannerProvider}=require('../../src/devhub/providers/planner/plannerProvider');
  const d=await fakeDaemon([
    {role:'user',text:'lên plan ticket',created_at:1000},
    {role:'assistant',text:'đã kéo vào inbox',created_at:1001},
    {role:'user',text:'[scheduled check] báo khi có plan',created_at:1002},
    {role:'assistant',text:'plan v1 xong rồi',created_at:1003},
  ]);
  try{
    const events=await new PlannerProvider(d.endpoint).loadTranscript(
      {provider:'planner',nativeSessionId:'chat:agent-acme',updatedAt:2000} as any);
    assert.deepEqual(events.map((e:any)=>[e.type,e.text]),[
      ['user_message','lên plan ticket'],
      ['assistant_message','đã kéo vào inbox'],
      ['user_message','[scheduled check] báo khi có plan'],
      ['assistant_message','plan v1 xong rồi'],
    ]);
    assert.equal(events[0].timestamp,1000*1000,'epoch giây của daemon -> ms');
  } finally { await d.close(); }
});

test('an old daemon without the messages endpoint still opens a tab',async()=>{
  const {PlannerProvider}=require('../../src/devhub/providers/planner/plannerProvider');
  const server=http.createServer((_:any,res:any)=>{res.writeHead(404);res.end();});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
  try{
    const events=await new PlannerProvider(`http://127.0.0.1:${server.address().port}`)
      .loadTranscript({provider:'planner',nativeSessionId:'chat:x',updatedAt:1} as any);
    assert.deepEqual(events,[],'404 không được ném ra ngoài');
  } finally { await new Promise<void>(r=>server.close(()=>r())); }
});

/**
 * Daemon tắt hẳn thì watcher retry 30s/lần mãi mãi; in mỗi lần một dòng là 500 dòng một đêm và
 * mọi dòng log khác của extension chìm theo. Log phải theo chuyển trạng thái.
 */
test('a daemon that stays down is logged once, not once per retry',async()=>{
  const d=await fakeDaemon();const port=d.port;
  const log:string[]=[];
  const w=new PlannerWatcher(()=>{},l=>log.push(l));
  let back:any;
  try{
    w.watch([d.endpoint]);assert.ok(await d.ready());
    await d.close();
    // Backoff 1s→2s→5s: 3.2s phủ đúng hai lần thử hỏng, đủ để bắt lỗi in trùng.
    await new Promise(r=>setTimeout(r,3200));
    assert.equal(log.filter(l=>l.includes('error')).length,1,'nhiều lần thử hỏng chỉ được một dòng');
    back=await fakeDaemon([],port);
    back.frame('ping',{});
    for(let i=0;i<120&&!log.some(l=>l.includes('nối lại được'));i++){
      await new Promise(r=>setTimeout(r,100));back.frame('ping',{});
    }
    assert.ok(log.some(l=>l.includes('nối lại được')),'nối lại được phải có một dòng');
  } finally { w.dispose();if(back)await back.close(); }
});
