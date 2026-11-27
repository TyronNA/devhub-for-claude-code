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
  // A later turn reusing the id must be able to open a new row.
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
  assert.equal((noCode.find((e:any)=>e.type==='command_completed') as any).exitCode,1,'unreadable must still be non-zero');

  parser.parse({type:'assistant',message:{content:[{type:'tool_use',id:'b3',name:'Bash',input:{command:'true'}}]}});
  const ok=parser.parse({type:'user',message:{content:[{type:'tool_result',tool_use_id:'b3',content:'Exit code 0'}]}});
  assert.equal((ok.find((e:any)=>e.type==='command_completed') as any).exitCode,undefined,'a passing command gets no exit code');
});

/**
 * Claude's sub-agent tool is named `Agent` (`Task` is the old name) and its input only has
 * description/subagent_type/prompt — it matches no path/command/query branch, so the label used to fall
 * back to the tool name: two entirely different spawns both read "Agent (Agent)".
 */
test('a Claude sub-agent shows its description and agent type, not the word Agent twice',()=>{
  const p=new ClaudeEventParser();
  const [started]=p.parse({type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Agent',
    input:{description:'Independent review of T813 PR',subagent_type:'general-purpose',prompt:'…'}}]}}) as any[];
  assert.equal(started.type,'tool_started');
  assert.equal(started.tool,'Agent');
  assert.equal(started.label,'Independent review of T813 PR (general-purpose)');
});

test('without a description it is still no worse than before',()=>{
  const p=new ClaudeEventParser();
  const [a]=p.parse({type:'assistant',message:{content:[{type:'tool_use',id:'t2',name:'Task',
    input:{subagent_type:'Explore'}}]}}) as any[];
  assert.equal(a.label,'(Explore)');
  const p2=new ClaudeEventParser();
  const [b]=p2.parse({type:'assistant',message:{content:[{type:'tool_use',id:'t3',name:'Agent',input:{}}]}}) as any[];
  assert.equal(b.label,'Agent');
});

/**
 * Recorded from the REAL stdout of `claude --print --output-format stream-json --include-partial-messages`
 * when the main turn spawns a background sub-agent: the child's stream comes down the same pipe, differing only in
 * `parent_tool_use_id`. Before the fix, the child's words became the parent's bubble and the child's tool rows
 * split the parent's streaming text mid-word.
 */
test('a background sub-agent does not cut into the main stream',()=>{
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

/** A background call: `tool_result` is only a receipt, the real output arrives in `task_notification`. */
test('a background Agent row follows task_* and is not closed by the receipt',()=>{
  const p=new ClaudeEventParser();
  p.parse({type:'assistant',message:{content:[{type:'tool_use',id:'toolu_p',name:'Agent',
    input:{description:'Count .txt files',subagent_type:'general-purpose'}}]}});
  const started=p.parse({type:'system',subtype:'task_started',tool_use_id:'toolu_p',
    description:'Count .txt files',subagent_type:'general-purpose',is_backgrounded:true}) as any[];
  assert.equal(started.length,1);
  assert.equal(started[0].type,'tool_started');
  assert.equal(started[0].callId,'toolu_p');
  // The "Async agent launched successfully…" receipt must NOT close the row.
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
 * A `task_notification` for a task left over from a PREVIOUS session (the CLI re-reports it on resume) has no row
 * to attach to. Building a new row for it cuts into the middle of the streaming text.
 */
test('task_* for an unknown id is dropped, no ghost Agent row',()=>{
  const p=new ClaudeEventParser();
  assert.deepEqual(p.parse({type:'system',subtype:'task_notification',tool_use_id:'toolu_old',
    status:'stopped',summary:''}),[]);
  assert.deepEqual(p.parse({type:'system',subtype:'task_progress',tool_use_id:'toolu_old'}),[]);
});

test('a <synthetic> row answering a CLI-inserted turn is not drawn as the agent speaking',()=>{
  // Real payload: "Continue from where you left off." (isMeta, filtered since 0.29.52) is answered
  // with this row. Drawing it makes a reopened tab read as if the message just sent had been blocked.
  const ghost=parseClaudeEvent({type:'assistant',message:{model:'<synthetic>',role:'assistant',
    stop_reason:'stop_sequence',content:[{type:'text',text:'No response requested.'}]}});
  assert.deepEqual(ghost,[],'must emit no event');

  // But REAL errors are <synthetic> too; losing them makes an exhausted quota look like a hang.
  const limit=parseClaudeEvent({type:'assistant',isApiErrorMessage:true,error:'rate_limit',apiErrorStatus:429,
    message:{model:'<synthetic>',role:'assistant',content:[{type:'text',text:"You've hit your weekly limit · resets 10pm (Asia/Saigon)"}]}});
  assert.equal(limit.length,1);
  assert.equal(limit[0].type,'assistant_message');
  assert.match((limit[0] as any).text,/weekly limit/);

  // Local command output (`/context`) is also <synthetic> without the error flag — swallowing it gives a blank "done after 0s" turn.
  const local=parseClaudeEvent({type:'assistant',message:{model:'<synthetic>',role:'assistant',stop_reason:'end_turn',
    content:[{type:'text',text:'## Context Usage\n\n**Tokens:** 13.9k / 1m (1%)'}]}});
  assert.equal(local.length,1);
  assert.match((local[0] as any).text,/Context Usage/);

  // Real models still pass through as before.
  const real=parseClaudeEvent({type:'assistant',message:{model:'claude-opus-5',role:'assistant',
    content:[{type:'text',text:'hi'}]}});
  assert.equal(real.length,1);
});

test('system/init carries the real model id so the chip shows more than the alias', () => {
  assert.deepEqual(parseClaudeEvent({type:'system',subtype:'init',session_id:'s',model:'claude-opus-5-5'}).map((e:any)=>e.usage),[{model:'claude-opus-5-5'}]);
  assert.equal(parseClaudeEvent({type:'system',subtype:'init',session_id:'s'}).length,0,'no model means no empty usage event');
});

test('thinking with text (Opus 5.5 progress sentence) shows; redacted empty thinking is still dropped', () => {
  const note=parseClaudeEvent({type:'assistant',message:{model:'claude-opus-5-5',content:[{type:'thinking',thinking:'Check the parser first.\n',signature:'x'}]}});
  assert.deepEqual(note.map((e:any)=>[e.type,e.text]),[['assistant_message','Check the parser first.']]);
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
  assert.deepEqual(imgs.map(e=>e.src),['data:image/png;base64,iVBORw0KGgo='],'only base64 rasters are accepted, svg and url are dropped');
});

test('claude parser spills tool images to a content-addressed file instead of a data URI', () => {
  const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'devhub-img-test-'));
  try{
    const shot=(id:string)=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:[
      {type:'image',source:{type:'base64',media_type:'image/png',data:'iVBORw0KGgo='}}]}]}});
    const a=new ClaudeEventParser(dir).parse(shot('s1')).find((e:any)=>e.type==='assistant_image') as any;
    assert.equal(a.src,undefined,'no data URI travels in events any more');
    assert.ok(a.path.startsWith(dir+path.sep)&&a.path.endsWith('.png'));
    assert.deepEqual(fs.readFileSync(a.path),Buffer.from('iVBORw0KGgo=','base64'));
    // Re-reading the transcript (new parser) must point at the same file, not create another.
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
