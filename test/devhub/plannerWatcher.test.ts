export {};
const test=require('node:test');const assert=require('node:assert/strict');
const http=require('node:http');
import { PlannerWatcher, PlannerReminderPush } from '../../src/devhub/providers/planner/plannerWatcher';

/**
 * A fake daemon with only `/stream`: the watcher must keep the pipe open while NO turn runs — that is the whole
 * reason it exists. `messages` answers `/conversations/{id}/messages`.
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
    assert.ok(await d.ready(),'the watcher must open /stream by itself, not wait for a turn');
    d.frame('reminder_fired',{conversation_id:'chat:agent-acme',payload:{
      reminder_id:7,note:'tell me when there is a plan',jira_key:'KRP-11922',
      moved:['ANALYZING','WAITING_APPROVAL'],reply:'plan v1 xong, confidence 0.6'}});
    await settle();
    assert.equal(got.length,1);
    assert.deepEqual({...got[0],endpoint:''},{endpoint:'',conversationId:'chat:agent-acme',
      reminderId:7,note:'tell me when there is a plan',jiraKey:'KRP-11922',
      reply:'plan v1 xong, confidence 0.6',movedFrom:'ANALYZING',movedTo:'WAITING_APPROVAL'});
  } finally { w.dispose();await d.close(); }
});

test('view and message frames are ignored — only reminder_fired carries a full reply',async()=>{
  const d=await fakeDaemon();
  const got:PlannerReminderPush[]=[];
  const w=new PlannerWatcher(p=>got.push(p));
  try{
    w.watch([d.endpoint]);await d.ready();
    // `view` is a message edited in place; `message` is only the "⏳ processing" placeholder.
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
    d.frame('reminder_fired',{payload:{note:'orphan',reply:'x'}});
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
    d.drop();                       // `make restart` on the daemon side
    assert.ok(await d.ready(),'must reconnect by itself, without waiting for anyone to click');
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
    d.frame('reminder_fired',{conversation_id:'chat:x',payload:{note:'nobody listening',reply:'x'}});
    await settle();
    assert.deepEqual(got,[],'removing the agent from settings also drops the pipe');
  } finally { w.dispose();await d.close(); }
});

test('a planner transcript carries the stored turns, so a reminder survives a closed panel',async()=>{
  const {PlannerProvider}=require('../../src/devhub/providers/planner/plannerProvider');
  const d=await fakeDaemon([
    {role:'user',text:'plan the ticket',created_at:1000},
    {role:'assistant',text:'pulled into the inbox',created_at:1001},
    {role:'user',text:'[scheduled check] tell me when there is a plan',created_at:1002},
    {role:'assistant',text:'plan v1 is done',created_at:1003},
  ]);
  try{
    const events=await new PlannerProvider(d.endpoint).loadTranscript(
      {provider:'planner',nativeSessionId:'chat:agent-acme',updatedAt:2000} as any);
    assert.deepEqual(events.map((e:any)=>[e.type,e.text]),[
      ['user_message','plan the ticket'],
      ['assistant_message','pulled into the inbox'],
      ['user_message','[scheduled check] tell me when there is a plan'],
      ['assistant_message','plan v1 is done'],
    ]);
    assert.equal(events[0].timestamp,1000*1000,'the daemon\'s epoch seconds -> ms');
  } finally { await d.close(); }
});

test('an old daemon without the messages endpoint still opens a tab',async()=>{
  const {PlannerProvider}=require('../../src/devhub/providers/planner/plannerProvider');
  const server=http.createServer((_:any,res:any)=>{res.writeHead(404);res.end();});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
  try{
    const events=await new PlannerProvider(`http://127.0.0.1:${server.address().port}`)
      .loadTranscript({provider:'planner',nativeSessionId:'chat:x',updatedAt:1} as any);
    assert.deepEqual(events,[],'404 must not be thrown');
  } finally { await new Promise<void>(r=>server.close(()=>r())); }
});

/**
 * With the daemon fully off the watcher retries every 30s forever; a line per attempt is 500 lines a night and
 * drowns every other log line of the extension. Logging must follow state transitions.
 */
test('a daemon that stays down is logged once, not once per retry',async()=>{
  const d=await fakeDaemon();const port=d.port;
  const log:string[]=[];
  const w=new PlannerWatcher(()=>{},l=>log.push(l));
  let back:any;
  try{
    w.watch([d.endpoint]);assert.ok(await d.ready());
    await d.close();
    // Backoff 1s→2s→5s: 3.2s covers exactly two failed attempts, enough to catch duplicate logging.
    await new Promise(r=>setTimeout(r,3200));
    assert.equal(log.filter(l=>l.includes('error')).length,1,'many failed attempts give only one line');
    back=await fakeDaemon([],port);
    back.frame('ping',{});
    for(let i=0;i<120&&!log.some(l=>l.includes('reconnected'));i++){
      await new Promise(r=>setTimeout(r,100));back.frame('ping',{});
    }
    assert.ok(log.some(l=>l.includes('reconnected')),'reconnecting must log one line');
  } finally { w.dispose();if(back)await back.close(); }
});
