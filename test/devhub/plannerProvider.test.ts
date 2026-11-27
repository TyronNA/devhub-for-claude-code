import { plannerConversationId } from '../../src/devhub/sessions/plannerIdentity';
export {};
const test=require('node:test');const assert=require('node:assert/strict');
import { parseSseFrame, taskKeyOf, summarizeEvents } from '../../src/devhub/providers/planner/plannerProvider';

test('parseSseFrame reads the kind and the payload', () => {
  const f = parseSseFrame('event: view\ndata: {"conversation_id":"chat:1","payload":{"text":"hi"}}');
  assert.equal(f?.kind, 'view');
  assert.equal(f?.data.conversation_id, 'chat:1');
  assert.equal(f?.data.payload.text, 'hi');
});

test('parseSseFrame defaults the kind when only data is sent', () => {
  assert.equal(parseSseFrame('data: {"a":1}')?.kind, 'message');
});

test('parseSseFrame ignores a frame it cannot read', () => {
  assert.equal(parseSseFrame('event: view\ndata: not json'), undefined);
  assert.equal(parseSseFrame(': heartbeat comment'), undefined);
});

test('only a task session has a ticket behind it', () => {
  assert.equal(taskKeyOf('task:KRP-1'), 'KRP-1');
  assert.equal(taskKeyOf('chat:devhub'), undefined);
});

test('the state history collapses to one line per event', () => {
  const text = summarizeEvents([
    {kind:'task_state',created_at:0,payload:{from:'DISCOVERED',to:'ANALYZING'}},
    {kind:'plan_stored',created_at:0,payload:{version:1}},
    {kind:'scan',created_at:0}]);
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('DISCOVERED → ANALYZING'));
  assert.ok(lines[1].includes('"version":1'));
  assert.ok(lines[2].endsWith('scan'), 'event không payload vẫn phải có một dòng');
});

/** Daemon giả: `/stream` là bus chung, `/chat` chặn tới khi có câu trả lời cuối. */
function fakeDaemon(views=['Hel','Hello wor','Hello world'],reply='Hello world'){
  const http=require('node:http');
  let sse:any;
  const server=http.createServer((req:any,res:any)=>{
    if(req.url==='/stream'){
      res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();sse=res;return;
    }
    const chunks:any[]=[];req.on('data',(c:any)=>chunks.push(c));
    req.on('end',async()=>{
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      const id=body.conversation_id;
      const frame=(kind:string,data:any)=>sse?.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
      views.forEach((text,i)=>{
        frame('view',{conversation_id:id,payload:{text}});
        // Bus dùng chung: chen frame của conversation khác vào giữa để chắc nó bị bỏ.
        if(i===1)frame('view',{conversation_id:'someone-else',payload:{text:'NOT YOURS'}});
      });
      await new Promise(r=>setTimeout(r,20));
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({conversation_id:id,reply}));
    });
  });
  return new Promise<any>(resolve=>server.listen(0,'127.0.0.1',()=>resolve({
    endpoint:`http://127.0.0.1:${server.address().port}`,
    close:()=>new Promise<void>(r=>{try{sse?.end();}catch{}server.close(()=>r());}),
  })));
}

test('the partial reply streams as replace-frames, and the last one wins', async()=>{
  const {PlannerProvider,stripViewSuffix}=require('../../src/devhub/providers/planner/plannerProvider');
  // Đuôi trạng thái của daemon đổi theo giây và KHÔNG phải văn bản trả lời.
  assert.equal(stripViewSuffix('Hello\n\n_⏳ processing… 12s_'),'Hello');
  assert.equal(stripViewSuffix('Hello\n\n_🛠️ 2 tools · 8.3s_'),'Hello');
  assert.equal(stripViewSuffix('_⏳ processing… 1s_'),'','frame đầu chưa có chữ nào thì phải ra rỗng');
  const d=await fakeDaemon(['_⏳ processing… 1s_','Hel\n\n_⏳ processing… 2s_','Hello wor\n\n_⏳ processing… 3s_'],'Hello world');
  try{
    const p=new PlannerProvider(d.endpoint);
    const handle=await p.resume({session:{provider:'planner',nativeSessionId:'task:A-1'},prompt:'hi'});
    const got:any[]=[];
    for await(const e of handle.events)got.push(e);
    // Frame chỉ có đuôi bị bỏ; mỗi frame còn lại là TOÀN BỘ phần đã sinh, không phải delta.
    assert.deepEqual(got.map(e=>e.type),['assistant_view','assistant_view','assistant_view','turn_done']);
    assert.deepEqual(got.filter(e=>e.type==='assistant_view').map(e=>e.text),['Hel','Hello wor','Hello world']);
  } finally { await d.close(); }
});

test('with no view frame at all the reply is still one message', async()=>{
  const {PlannerProvider}=require('../../src/devhub/providers/planner/plannerProvider');
  // Daemon không flush /stream (hoặc quá hạn 2s mở stream) — lượt vẫn phải hiện câu trả lời.
  const d=await fakeDaemon([],'Hello world');
  try{
    const p=new PlannerProvider(d.endpoint);
    const handle=await p.resume({session:{provider:'planner',nativeSessionId:'task:A-1'},prompt:'hi'});
    const got:any[]=[];
    for await(const e of handle.events)got.push(e);
    assert.deepEqual(got.map(e=>e.type),['assistant_message','turn_done']);
    assert.equal(got[0].text,'Hello world');
  } finally { await d.close(); }
});

test('a frame from another conversation on the shared bus is dropped', async()=>{
  const {PlannerProvider}=require('../../src/devhub/providers/planner/plannerProvider');
  const d=await fakeDaemon();
  try{
    const p=new PlannerProvider(d.endpoint);
    const handle=await p.resume({session:{provider:'planner',nativeSessionId:'task:A-1'},prompt:'hi'});
    const got:any[]=[];
    for await(const e of handle.events)got.push(e);
    assert.equal(plannerConversationId(handle.getNativeSessionId()),'task:A-1','conversation id là chính session id');
    // KHÔNG có `user_message`: SessionManager phát nó cho mọi provider, provider phát thêm
    // một cái nữa là bong bóng câu hỏi hiện hai lần trong transcript.
    // Ba frame chạy dở + câu trả lời cuối, tất cả đều là replace-frame vào cùng bong bóng.
    assert.deepEqual(got.map(e=>e.type),Array(4).fill('assistant_view').concat(['turn_done']));
    // `NOT YOURS` của conversation khác chen giữa bus không được vào bong bóng nào.
    assert.equal(got.filter((e:any)=>/NOT YOURS/.test(e.text||'')).length,0);
    assert.equal(got[3].text,'Hello world','câu trả lời cuối ghi đè bong bóng đang stream');
  } finally { await d.close(); }
});

test('a session carries its own daemon, so a resume cannot land on another one', async()=>{
  const {PlannerProvider}=require('../../src/devhub/providers/planner/plannerProvider');
  // A = endpoint trong settings, B = daemon đã sinh ra session. `task:A-1` tồn tại ở cả hai.
  const a=await fakeDaemon(['x'],'from A');
  const b=await fakeDaemon(['x'],'from B');
  try{
    const p=new PlannerProvider(a.endpoint);
    const handle=await p.resume({session:{provider:'planner',nativeSessionId:'task:A-1',plannerEndpoint:b.endpoint},prompt:'hi'});
    const got:any[]=[];
    for await(const e of handle.events)got.push(e);
    assert.equal(got.filter((e:any)=>e.type==='assistant_view').pop()?.text,'from B','endpoint của session phải thắng settings');
  } finally { await a.close();await b.close(); }
});

test('cancel says the daemon keeps going, because it does', async()=>{
  const {PlannerProvider}=require('../../src/devhub/providers/planner/plannerProvider');
  const d=await fakeDaemon(['x'],'late answer');
  try{
    const handle=await new PlannerProvider(d.endpoint).start({workspaceId:'',projectId:'',cwd:'/tmp',prompt:'hi'});
    await handle.cancel();
    const got:any[]=[];
    for await(const e of handle.events)got.push(e);
    const warn=got.find((e:any)=>e.type==='warning');
    assert.ok(warn&&/keeps running/.test(warn.message),'phải nói rõ lượt bên daemon vẫn chạy');
  } finally { await d.close(); }
});

test('a daemon that refuses the turn reports an error and still closes the turn', async()=>{
  const http=require('node:http');
  const server=http.createServer((req:any,res:any)=>{
    if(req.url==='/stream'){res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();return;}
    res.writeHead(500,'boom');res.end('');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
  try{
    const {PlannerProvider}=require('../../src/devhub/providers/planner/plannerProvider');
    const p=new PlannerProvider(`http://127.0.0.1:${server.address().port}`);
    const handle=await p.start({workspaceId:'',projectId:'',cwd:'/tmp',prompt:'hi'});
    const got:any[]=[];
    for await(const e of handle.events)got.push(e);
    assert.deepEqual(got.map(e=>e.type),['error','turn_done']);
    assert.ok(/500/.test(got[0].message));
  } finally { await new Promise<void>(r=>server.close(()=>r())); }
});

test('cancel stops waiting on a /chat that never answers',async()=>{
  const { PlannerProvider }=require('../../src/devhub/providers/planner/plannerProvider');
  let posted:any;const started=new Promise(r=>posted=r);
  // Daemon giả KHÔNG trả lời bao giờ — `/chat` chạy không hạn, nên nếu cancel không destroy
  // request thì generator await mãi và `waitForIdle()` treo theo daemon.
  const client:any={
    stream:(_c:any,onOpen:any)=>{onOpen?.();return {destroy(){}};},
    json:(_m:string,_p:string,_b:any,_t:number,onRequest:any)=>new Promise((_res,rej)=>{
      onRequest?.({destroy:(e:any)=>rej(e||new Error('destroyed'))});posted();}),
  };
  const handle=(new PlannerProvider() as any).turn('hi','chat:1',client,'http://127.0.0.1:7341');
  const drain=(async()=>{const out:any[]=[];for await(const e of handle.events)out.push(e);return out;})();
  await started;
  await handle.cancel();
  const events:any[]=await Promise.race([drain,
    new Promise<any>((_r,rej)=>setTimeout(()=>rej(new Error('iterator vẫn treo sau cancel')),2000))]);
  assert.deepEqual(events.map(e=>e.type),['warning','turn_done'],
    'destroy request là lỗi mình tự gây, không được biến thành bong bóng lỗi');
});

test('sseFrames cuts on CRLF and CR blank lines, not just LF', () => {
  const { sseFrames }=require('../../src/devhub/providers/planner/plannerProvider');
  const a=sseFrames('event: view\r\ndata: {"a":1}\r\n\r\nevent: view\ndata: {"a":2}\n\nleft');
  assert.deepEqual(a.frames.map((f:string)=>parseSseFrame(f)?.data.a), [1,2]);
  assert.equal(a.rest, 'left', 'frame chưa đủ phải ở lại buffer');
  assert.deepEqual(sseFrames('data: {}\r\r').frames.length, 1, 'CR trần cũng là dòng trắng theo spec');
  assert.equal(parseSseFrame('event: view\r\ndata: {"payload":{"text":"hi"}}')?.data.payload.text, 'hi');
});

test('a daemon that frames its stream with CRLF still streams the partial reply',async()=>{
  const { PlannerProvider }=require('../../src/devhub/providers/planner/plannerProvider');
  let onChunk:any;let reply:any;
  const client:any={
    stream:(c:any,onOpen:any)=>{onChunk=c;onOpen?.();return {destroy(){}};},
    json:()=>new Promise(r=>{reply=r;}),
  };
  const handle=(new PlannerProvider() as any).turn('hi','chat:1',client,'http://127.0.0.1:7341');
  const drain=(async()=>{const out:any[]=[];for await(const e of handle.events)out.push(e);return out;})();
  await new Promise(r=>setTimeout(r,0));
  onChunk('event: view\r\ndata: '+JSON.stringify({conversation_id:'chat:1',payload:{text:'Hello wor'}})+'\r\n\r\n');
  reply({reply:'Hello world',conversation_id:'chat:1'});
  const events:any[]=await drain;
  assert.deepEqual(events.map(e=>e.type),['assistant_view','assistant_view','turn_done'],
    'mất frame CRLF là lượt hoá ra chưa từng stream, và câu cuối bị phát thành message thứ hai');
  assert.equal(events[0].text,'Hello wor');
});
