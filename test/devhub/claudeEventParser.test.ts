const test = require('node:test');
const assert = require('node:assert/strict');
import { ClaudeEventParser, parseClaudeEvent } from '../../src/devhub/providers/claude/claudeEventParser';

test('claude parser normalizes assistant, tool and usage events', () => {
  const assistant = parseClaudeEvent({type:'assistant', message:{content:[{type:'text',text:'hello'},{type:'tool_use',id:'r1',name:'Read',input:{file_path:'/tmp/a.ts'}}]}});
  assert.equal(assistant.some((e:any)=>e.type==='assistant_message' && e.text==='hello'), true);
  assert.equal(assistant.some((e:any)=>e.type==='tool_started' && e.tool==='Read'), true);
  const result = parseClaudeEvent({type:'result',subtype:'success',session_id:'sid',usage:{input_tokens:120,cached_input_tokens:30,cache_creation_input_tokens:7,output_tokens:40},total_cost_usd:0.1});
  assert.equal(result.some((e:any)=>e.type==='usage' && e.usage.inputTokens===120 && e.usage.cachedInputTokens===30 && e.usage.cacheWriteInputTokens===7), true);
  assert.equal(result.some((e:any)=>e.type==='turn_done'), true);
});

test('claude streaming parser emits deltas without duplicating final assistant text', () => {
  const parser=new ClaudeEventParser();
  const delta=parser.parse({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'hel'}}});
  const delta2=parser.parse({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'lo'}}});
  const final=parser.parse({type:'assistant',message:{content:[{type:'text',text:'hello'}]}});
  assert.deepEqual(delta.map((e:any)=>[e.type,e.text]),[['assistant_delta','hel']]);
  assert.deepEqual(delta2.map((e:any)=>[e.type,e.text]),[['assistant_delta','lo']]);
  assert.equal(final.some((e:any)=>e.type==='assistant_message'),false);
});

test('claude parser correlates Bash tool result and file edits by tool_use_id', () => {
  const parser=new ClaudeEventParser();
  const bashStart=parser.parse({type:'assistant',message:{content:[{type:'tool_use',id:'bash-1',name:'Bash',input:{command:'npm test'}}]}});
  assert.equal(bashStart.some((e:any)=>e.type==='command_started'&&e.command==='npm test'),true);
  const bashDone=parser.parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'bash-1',content:'20 passed'}]}});
  assert.equal(bashDone.some((e:any)=>e.type==='command_completed'&&e.command==='npm test'&&e.output==='20 passed'),true);

  const editStart=parser.parse({type:'assistant',message:{content:[{type:'tool_use',id:'edit-1',name:'Edit',input:{file_path:'/tmp/a.ts'}}]}});
  assert.equal(editStart.some((e:any)=>e.type==='tool_started'&&e.tool==='Edit'),true);
  const editDone=parser.parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'edit-1',content:'updated'}]}});
  assert.equal(editDone.some((e:any)=>e.type==='tool_completed'&&e.tool==='Edit'),true);
  assert.equal(editDone.some((e:any)=>e.type==='file_changed'&&e.path==='/tmp/a.ts'&&e.change==='modify'),true);
});

test('claude parser ignores unknown events', () => { assert.deepEqual(parseClaudeEvent({type:'future_event',foo:1}), []); });

test('claude parser opens a tool row at content_block_start and refines it once', () => {
  const parser=new ClaudeEventParser();
  const early=parser.parse({type:'stream_event',event:{type:'content_block_start',index:0,
    content_block:{type:'tool_use',id:'toolu_1',name:'Bash',input:{}}}});
  assert.deepEqual(early.map((e:any)=>[e.type,e.command,e.callId]),[['command_started','','toolu_1']]);
  const full=parser.parse({type:'assistant',message:{content:[{type:'tool_use',id:'toolu_1',name:'Bash',input:{command:'ls -la'}}]}});
  assert.deepEqual(full.map((e:any)=>[e.type,e.command,e.callId]),[['command_started','ls -la','toolu_1']]);
  // Lượt sau tái dùng id thì phải mở lại được dòng mới.
  parser.parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu_1',content:'ok'}]}});
  const again=parser.parse({type:'stream_event',event:{type:'content_block_start',index:0,
    content_block:{type:'tool_use',id:'toolu_1',name:'Bash',input:{}}}});
  assert.equal(again.length,1);
});

test('claude parser opens no early row for a text block or an id-less tool block', () => {
  const parser=new ClaudeEventParser();
  assert.deepEqual(parser.parse({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}}),[]);
  assert.deepEqual(parser.parse({type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'tool_use',name:'Bash',input:{}}}}),[]);
});

test('claude parser reports thinking token estimates as an absolute count', () => {
  const parser=new ClaudeEventParser();
  assert.deepEqual(parser.parse({type:'system',subtype:'thinking_tokens',estimated_tokens:150,estimated_tokens_delta:100})
    .map((e:any)=>[e.type,e.tokens]),[['thinking',150]]);
  assert.deepEqual(parser.parse({type:'system',subtype:'thinking_tokens',estimated_tokens:0}),[]);
});

test('claude parser reads the real exit code out of a failed Bash result', () => {
  const parser=new ClaudeEventParser();
  parser.parse({type:'assistant',message:{content:[{type:'tool_use',id:'b1',name:'Bash',input:{command:'ls /nope'}}]}});
  const failed=parser.parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'b1',is_error:true,
    content:'Exit code 2\nls: /nope: No such file or directory'}]}});
  assert.equal((failed.find((e:any)=>e.type==='command_completed') as any).exitCode,2);

  parser.parse({type:'assistant',message:{content:[{type:'tool_use',id:'b2',name:'Bash',input:{command:'false'}}]}});
  const noCode=parser.parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'b2',is_error:true,content:'boom'}]}});
  assert.equal((noCode.find((e:any)=>e.type==='command_completed') as any).exitCode,1,'không đọc được thì vẫn phải khác 0');

  parser.parse({type:'assistant',message:{content:[{type:'tool_use',id:'b3',name:'Bash',input:{command:'true'}}]}});
  const ok=parser.parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'b3',content:'Exit code 0'}]}});
  assert.equal((ok.find((e:any)=>e.type==='command_completed') as any).exitCode,undefined,'lệnh pass không được gắn exit code');
});

/**
 * Sub-agent của Claude tên tool là `Agent` (`Task` là tên cũ) và input chỉ có
 * description/subagent_type/prompt — không khớp nhánh path/command/query nào, nên nhãn từng rơi
 * về đúng tên tool: hai lần spawn khác hẳn nhau mà cùng đọc ra "Agent (Agent)".
 */
test('một sub-agent của Claude hiện mô tả và loại agent, không phải hai chữ Agent',()=>{
  const p=new ClaudeEventParser();
  const [started]=p.parse({type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Agent',
    input:{description:'Independent review of T813 PR',subagent_type:'general-purpose',prompt:'…'}}]}}) as any[];
  assert.equal(started.type,'tool_started');
  assert.equal(started.tool,'Agent');
  assert.equal(started.label,'Independent review of T813 PR (general-purpose)');
});

test('thiếu mô tả thì vẫn không tệ hơn trước',()=>{
  const p=new ClaudeEventParser();
  const [a]=p.parse({type:'assistant',message:{content:[{type:'tool_use',id:'t2',name:'Task',
    input:{subagent_type:'Explore'}}]}}) as any[];
  assert.equal(a.label,'(Explore)');
  const p2=new ClaudeEventParser();
  const [b]=p2.parse({type:'assistant',message:{content:[{type:'tool_use',id:'t3',name:'Agent',input:{}}]}}) as any[];
  assert.equal(b.label,'Agent');
});

/**
 * Ghi lại từ stdout THẬT của `claude --print --output-format stream-json --include-partial-messages`
 * khi lượt chính spawn một sub-agent nền: stream của con ra cùng một đường ống, chỉ khác ở
 * `parent_tool_use_id`. Trước bản vá, lời của con thành bong bóng của cha và dòng tool của con
 * cắt đôi đoạn cha đang stream giữa từ.
 */
test('sub-agent nền không chen vào dòng chính',()=>{
  const p=new ClaudeEventParser();
  p.parse({type:'assistant',message:{content:[{type:'tool_use',id:'toolu_p',name:'Agent',
    input:{description:'Count .txt files',subagent_type:'general-purpose'}}]}});
  assert.deepEqual(p.parse({type:'assistant',parent_tool_use_id:'toolu_p',
    message:{content:[{type:'text',text:'Let me kick off the build.'}]}}),[]);
  assert.deepEqual(p.parse({type:'assistant',parent_tool_use_id:'toolu_p',
    message:{content:[{type:'tool_use',id:'toolu_c',name:'Bash',input:{command:'ls'}}]}}),[]);
  assert.deepEqual(p.parse({type:'user',parent_tool_use_id:'toolu_p',
    message:{content:[{type:'tool_result',tool_use_id:'toolu_c',content:'3'}]}}),[]);
});

/** Lượt gọi nền: `tool_result` chỉ là biên nhận, output thật tới ở `task_notification`. */
test('dòng Agent nền chạy theo task_* chứ không đóng bằng biên nhận',()=>{
  const p=new ClaudeEventParser();
  p.parse({type:'assistant',message:{content:[{type:'tool_use',id:'toolu_p',name:'Agent',
    input:{description:'Count .txt files',subagent_type:'general-purpose'}}]}});
  const started=p.parse({type:'system',subtype:'task_started',tool_use_id:'toolu_p',
    description:'Count .txt files',subagent_type:'general-purpose',is_backgrounded:true}) as any[];
  assert.equal(started.length,1);
  assert.equal(started[0].type,'tool_started');
  assert.equal(started[0].callId,'toolu_p');
  // Biên nhận "Async agent launched successfully…" KHÔNG được đóng dòng.
  assert.deepEqual(p.parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu_p',
    content:'Async agent launched successfully.'}]}}),[]);
  const progress=p.parse({type:'system',subtype:'task_progress',tool_use_id:'toolu_p',
    description:'Running Count .txt files',subagent_type:'general-purpose',
    last_tool_name:'Bash',usage:{tool_uses:1,duration_ms:2423}}) as any[];
  assert.equal(progress[0].type,'tool_started');
  assert.match(progress[0].summary,/1 tool call/);
  assert.match(progress[0].summary,/last: Bash/);
  const done=p.parse({type:'system',subtype:'task_notification',tool_use_id:'toolu_p',
    status:'completed',summary:'3',output_file:'/tmp/a.output',usage:{duration_ms:5034}}) as any[];
  assert.equal(done.length,1);
  assert.equal(done[0].type,'tool_completed');
  assert.equal(done[0].callId,'toolu_p');
  assert.match(done[0].summary,/^3/);
  assert.match(done[0].summary,/a\.output/);
});

/**
 * `task_notification` của một task còn sót từ phiên TRƯỚC (CLI báo lại lúc resume) không có dòng
 * nào để bám. Dựng dòng mới cho nó là chèn ngang vào giữa đoạn đang stream.
 */
test('task_* của id lạ bị bỏ, không dựng dòng Agent ma',()=>{
  const p=new ClaudeEventParser();
  assert.deepEqual(p.parse({type:'system',subtype:'task_notification',tool_use_id:'toolu_cũ',
    status:'stopped',summary:''}),[]);
  assert.deepEqual(p.parse({type:'system',subtype:'task_progress',tool_use_id:'toolu_cũ'}),[]);
});

test('hàng <synthetic> trả lời lượt CLI tự chèn không được vẽ như lời agent',()=>{
  // Payload thật: "Continue from where you left off." (isMeta, đã lọc ở 0.29.52) được đáp
  // bằng hàng này. Vẽ ra thì mở lại tab đọc y như câu vừa gửi bị chặn.
  const ghost=parseClaudeEvent({type:'assistant',message:{model:'<synthetic>',role:'assistant',
    stop_reason:'stop_sequence',content:[{type:'text',text:'No response requested.'}]}});
  assert.deepEqual(ghost,[],'không được sinh event nào');

  // Nhưng lỗi THẬT cũng là <synthetic>; mất nó thì hết quota trông y như treo.
  const limit=parseClaudeEvent({type:'assistant',isApiErrorMessage:true,error:'rate_limit',apiErrorStatus:429,
    message:{model:'<synthetic>',role:'assistant',content:[{type:'text',text:"You've hit your weekly limit · resets 10pm (Asia/Saigon)"}]}});
  assert.equal(limit.length,1);
  assert.equal(limit[0].type,'assistant_message');
  assert.match((limit[0] as any).text,/weekly limit/);

  // Output lệnh local (`/context`) cũng là <synthetic> không cờ lỗi — nuốt nó là lượt "done sau 0s" trắng.
  const local=parseClaudeEvent({type:'assistant',message:{model:'<synthetic>',role:'assistant',stop_reason:'end_turn',
    content:[{type:'text',text:'## Context Usage\n\n**Tokens:** 13.9k / 1m (1%)'}]}});
  assert.equal(local.length,1);
  assert.match((local[0] as any).text,/Context Usage/);

  // Model thật vẫn đi qua như cũ.
  const real=parseClaudeEvent({type:'assistant',message:{model:'claude-opus-5',role:'assistant',
    content:[{type:'text',text:'hi'}]}});
  assert.equal(real.length,1);
});

test('system/init mang id model thật để chip không chỉ hiện alias', () => {
  assert.deepEqual(parseClaudeEvent({type:'system',subtype:'init',session_id:'s',model:'claude-opus-5-5'}).map((e:any)=>e.usage),[{model:'claude-opus-5-5'}]);
  assert.equal(parseClaudeEvent({type:'system',subtype:'init',session_id:'s'}).length,0,'thiếu model thì không phát usage rỗng');
});

test('thinking có chữ (câu tiến độ của Opus 5.5) hiện ra; thinking rỗng bị bịt thì vẫn bỏ', () => {
  const note=parseClaudeEvent({type:'assistant',message:{model:'claude-opus-5-5',content:[{type:'thinking',thinking:'Kiểm tra parser trước.\n',signature:'x'}]}});
  assert.deepEqual(note.map((e:any)=>[e.type,e.text]),[['assistant_message','Kiểm tra parser trước.']]);
  assert.equal(parseClaudeEvent({type:'assistant',message:{model:'claude-opus-5',content:[{type:'thinking',thinking:'',signature:'x'}]}}).length,0);
  assert.equal(parseClaudeEvent({type:'assistant',message:{content:[{type:'thinking',thinking:'  \n'}]}}).length,0);
});

test('claude parser surfaces images from tool_result as assistant_image', () => {
  const parser=new ClaudeEventParser(null);
  parser.parse({type:'assistant',message:{content:[{type:'tool_use',id:'s1',name:'mcp__playwright__browser_take_screenshot',input:{}}]}});
  const out=parser.parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'s1',content:[
    {type:'text',text:'Took the screenshot'},
    {type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgo='}},
    {type:'image',source:{type:'base64',media_type:'image/svg+xml',data:'PHN2Zz4='}},
    {type:'image',source:{type:'url',url:'https://x/y.png'}}]}]}});
  assert.equal(out[0].type,'tool_completed');
  assert.equal((out[0] as any).summary,'Took the screenshot');
  const imgs=out.filter((e:any)=>e.type==='assistant_image') as any[];
  assert.deepEqual(imgs.map(e=>e.src),['data:image/png;base64,iVBORw0KGgo='],'chỉ nhận base64 raster, bỏ svg và url');
});

test('claude parser spills tool images to a content-addressed file instead of a data URI', () => {
  const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'devhub-img-test-'));
  try{
    const shot=(id:string)=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:[
      {type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgo='}}]}]}});
    const a=new ClaudeEventParser(dir).parse(shot('s1')).find((e:any)=>e.type==='assistant_image') as any;
    assert.equal(a.src,undefined,'không còn data URI đi trong event');
    assert.ok(a.path.startsWith(dir+path.sep)&&a.path.endsWith('.png'));
    assert.deepEqual(fs.readFileSync(a.path),Buffer.from('iVBORw0KGgo=','base64'));
    // Đọc lại transcript (parser mới) phải trỏ cùng file, không đẻ thêm.
    const b=new ClaudeEventParser(dir).parse(shot('s2')).find((e:any)=>e.type==='assistant_image') as any;
    assert.equal(b.path,a.path);
    assert.deepEqual(fs.readdirSync(dir),[path.basename(a.path)]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('claude parser falls back to a data URI when the image dir cannot be written', () => {
  const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'devhub-img-test-'));
  const blocker=path.join(dir,'file');fs.writeFileSync(blocker,'x');
  try{
    const out=new ClaudeEventParser(path.join(blocker,'sub')).parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'s1',content:[
      {type:'image',source:{type:'base64',media_type:'image/jpeg',data:'/9j/4AAQ'}}]}]}});
    const img=out.find((e:any)=>e.type==='assistant_image') as any;
    assert.equal(img.src,'data:image/jpeg;base64,/9j/4AAQ');
    assert.equal(img.path,undefined);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
