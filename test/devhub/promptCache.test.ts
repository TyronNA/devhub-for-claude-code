const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
import { ClaudeEventParser } from '../../src/devhub/providers/claude/claudeEventParser';
import { insightsFromUsage, resetInsightsThrottle } from '../../src/devhub/providers/claude/claudeSession';
import { mergeSessionUsage } from '../../src/devhub/usage/usageAggregator';
import { SessionStore } from '../../src/devhub/storage/sessionStore';
import { SessionManager } from '../../src/devhub/sessions/sessionManager';
const {ClaudeProvider}=require('../../src/devhub/providers/claude/claudeProvider');

// `usage` thật của một assistant message (CLI 2.1.284, TTL 1h), rút gọn.
const U1H={input_tokens:2,cache_creation_input_tokens:3981,cache_read_input_tokens:114343,output_tokens:364,
  cache_creation:{ephemeral_1h_input_tokens:3981,ephemeral_5m_input_tokens:0}};

test('mốc cache neo ở message_start, một lần cho mỗi message, kèm TTL đọc từ cache_creation',()=>{
  const p=new ClaudeEventParser();
  const a=p.parse({type:'stream_event',event:{type:'message_start',message:{id:'msg_1',usage:U1H}}}).filter(e=>e.type==='usage') as any[];
  assert.equal(a.length,1);
  assert.equal(a[0].usage.cacheTtlMs,3600000,'ephemeral_1h > 0 là TTL 1h');
  assert.equal(a[0].usage.cacheTokens,2+3981+114343,'phần lượt kế phải ghi lại nếu cache nguội');
  assert.ok(Math.abs(a[0].usage.cacheAnchorAt-Date.now())<1000);
  // `assistant` của cùng message lặp lại mỗi content block: không được dời mốc về sau.
  const again=p.parse({type:'assistant',message:{id:'msg_1',usage:U1H,content:[]}}).filter(e=>e.type==='usage');
  assert.equal(again.length,0);
  // Lượt chỉ đọc cache không nói TTL: không gửi key rỗng, merge giữ TTL cũ.
  const read=p.parse({type:'stream_event',event:{type:'message_start',message:{id:'msg_2',usage:{input_tokens:1,cache_read_input_tokens:9000,cache_creation_input_tokens:0}}}})
    .filter(e=>e.type==='usage') as any[];
  assert.equal('cacheTtlMs' in read[0].usage,false,'key undefined sẽ xoá TTL ở Object.assign của webview');
  assert.equal(mergeSessionUsage(a[0].usage,read[0].usage).cacheTtlMs,3600000);
  // Request không chạm cache thì không làm mới gì cả.
  assert.equal(p.parse({type:'stream_event',event:{type:'message_start',message:{id:'msg_3',usage:{input_tokens:50}}}}).length,0);
});

test('sub-agent có cache riêng, không dời mốc của hội thoại chính; compact làm nguội cache',()=>{
  const p=new ClaudeEventParser();
  assert.deepEqual(p.parse({type:'stream_event',parent_tool_use_id:'toolu_x',event:{type:'message_start',message:{id:'m',usage:U1H}}}),[]);
  const c=p.parse({type:'system',subtype:'status',compact_result:'success',pre_tokens:120000,post_tokens:18000});
  assert.deepEqual((c.find(e=>e.type==='usage') as any).usage,{cacheAnchorAt:0});
  // Sau compact, request đầu (dù cùng id với trước) phải neo lại được.
  assert.equal(p.parse({type:'stream_event',event:{type:'message_start',message:{id:'m',usage:U1H}}}).length,1);
});

// `get_usage` thật (CLI 2.1.284), cắt phần không dùng.
const GET_USAGE={subscription_type:'team',rate_limits_available:true,behaviors:{
  day:{request_count:1772,session_count:25,behaviors:[{key:'long_context',pct:72,count:922},{key:'subagent_heavy',pct:39,count:2}],
    agents:[{name:'impl-acme-task',pct:3},{name:'general-purpose',pct:1}],skills:[{name:'impl-acme-task',pct:12}],plugins:[],
    mcp_servers:[{name:'plugin:playwright:playwright',pct:4}]},
  week:{request_count:18494,session_count:2164,behaviors:[{key:'high_parallel',pct:28,count:4745}],agents:[],skills:[],plugins:[],mcp_servers:[]}}};

test('get_usage chỉ giữ thứ card cần: behaviors và mục đầu mỗi nhóm',()=>{
  const ins=insightsFromUsage(GET_USAGE,5)!;
  assert.equal(ins.observedAt,5);
  assert.deepEqual(ins.day!.behaviors,[{key:'long_context',pct:72},{key:'subagent_heavy',pct:39}]);
  assert.deepEqual(ins.day!.top,[{group:'agents',name:'impl-acme-task',pct:3},{group:'skills',name:'impl-acme-task',pct:12},
    {group:'mcp_servers',name:'plugin:playwright:playwright',pct:4}]);
  assert.equal(ins.week!.requests,18494);
  // Đăng nhập bằng API key: CLI trả behaviors null — không có gì để vẽ, không phải object rỗng.
  assert.equal(insightsFromUsage({behaviors:null}),undefined);
});

test('get_usage hỏi SAU result trên chính process đó, và các tab dùng chung một nhịp 5 phút',async()=>{
  resetInsightsThrottle();
  const writes:any[]=[];
  const runner:any={spawnDuplex(){const lines:string[]=[];let wake:any;let done=false;
    const push=(v:any)=>{lines.push(JSON.stringify(v));wake?.();};
    return {alive:()=>!done,pid:1,write(s:string){const m=JSON.parse(s);writes.push(m);
        if(m.type==='user')push({type:'result',subtype:'success'});
        if(m.type==='control_request'&&m.request?.subtype==='get_usage')
          push({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:GET_USAGE}});
        return true;},
      stdoutLines:(async function*(){while(!done){if(lines.length)yield lines.shift();else await new Promise(r=>wake=r);}})(),
      stderrLines:(async function*(){})(),cancel:async()=>{done=true;wake?.();}};}};
  const p=new ClaudeProvider(runner,'claude',10,undefined,undefined,undefined,0);
  const idle:any[]=[];p.setIdleEventSink((id:string,e:any)=>idle.push(e));
  try{
    const h=await p.start({cwd:process.cwd(),prompt:'a'});for await(const e of h.events){}
    await new Promise(r=>setTimeout(r,20));
    assert.deepEqual(writes.map(w=>w.type),['user','control_request'],'hỏi đúng một lần, sau lượt');
    const ev=idle.find(e=>e.type==='usage');
    assert.equal(ev.usage.usageInsights.day.behaviors[0].key,'long_context','câu trả lời đi đường ngoài lượt lên manager');
    const h2=await p.start({cwd:process.cwd(),prompt:'b'});for await(const e of h2.events){}
    await new Promise(r=>setTimeout(r,20));
    assert.equal(writes.filter(w=>w.type==='control_request').length,1,'trong 5 phút không hỏi lại, kể cả process khác');
  }finally{p.dispose();resetInsightsThrottle();}
});

test('usage lẻ ngoài lượt được lưu nhưng không lật session sang running',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-ins-'));
  const store=new SessionStore(dir);
  const manager=new SessionManager(store,{claude:{id:'claude',isAvailable:async()=>true,
    start:async()=>({getNativeSessionId:()=>'n1',cancel:async()=>{},events:(async function*(){yield {type:'turn_done',timestamp:1} as any;})()}),
    resume:async()=>{throw new Error('unused');},discoverHistory:async()=>[],loadTranscript:async()=>[]} as any},4);
  await manager.start({provider:'claude',workspaceId:'w',projectId:'p',cwd:'/tmp/r',prompt:'x'});
  await manager.waitForIdle();
  manager.ingestOutOfTurn('claude','n1',{type:'usage',usage:{usageInsights:insightsFromUsage(GET_USAGE,7)},timestamp:1} as any);
  assert.equal(manager.isBusy('claude','n1'),false,'không có lượt nào để chờ turn_done');
  await new Promise(r=>setTimeout(r,20));
  const s=(await store.list())[0];
  assert.equal(s.status,'done','kẹt running thì hàng chờ không bao giờ flush');
  assert.equal(s.usage?.usageInsights?.observedAt,7);
});
