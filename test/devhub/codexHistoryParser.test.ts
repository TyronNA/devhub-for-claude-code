const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
import { codexHistorySnapshot, isCodexHistoryItem, parseCodexHistoryRecord } from '../../src/devhub/providers/codex/codexHistoryParser';
import { loadCodexTranscript } from '../../src/devhub/providers/codex/codexHistory';

/**
 * Real records taken from a rollout `~/.codex/sessions/.../rollout-*.jsonl` (CLI 0.153.4).
 * This is exactly the form the stdout parser does NOT understand: stdout uses `item.completed` + item.type
 * `agent_message`, while the rollout uses `event_msg/item_completed` + item.type `AgentMessage`.
 */
const ROWS:any[]=[
  {timestamp:'2026-09-08T04:17:03.648Z',type:'session_meta',payload:{session_id:'t1',id:'t1',cwd:'/repo'}},
  {timestamp:'2026-09-08T04:17:07.647Z',type:'event_msg',payload:{type:'item_completed',thread_id:'t1',
    item:{type:'UserMessage',id:'u1',content:[{type:'text',text:'review devhub'}]}}},
  {timestamp:'2026-09-08T04:17:12.107Z',type:'event_msg',payload:{type:'item_completed',thread_id:'t1',
    item:{type:'AgentMessage',id:'m1',content:[{type:'Text',text:'I will read the architecture.'}],phase:'commentary'}}},
  {timestamp:'2026-09-08T04:17:18.506Z',type:'event_msg',payload:{type:'item_completed',thread_id:'t1',
    item:{type:'CommandExecution',id:'e1',command:['/bin/zsh','-lc','cat SKILL.md'],status:'completed',
          exit_code:0,stdout:'---\nname: x\n'}}},
  {timestamp:'2026-09-08T04:17:19.000Z',type:'response_item',payload:{type:'reasoning',id:'r1',summary:[]}},
  {timestamp:'2026-09-08T04:17:19.500Z',type:'response_item',payload:{type:'message',role:'assistant',
    content:[{type:'output_text',text:'the copy sent to the model'}]}},
  {timestamp:'2026-09-08T04:17:18.977Z',type:'event_msg',payload:{type:'token_count',
    info:{total_token_usage:{input_tokens:21880,cached_input_tokens:12160,output_tokens:225,total_tokens:22105},
          last_token_usage:{total_tokens:22105},model_context_window:258400}}},
  {timestamp:'2026-09-08T04:19:52.471Z',type:'event_msg',payload:{type:'task_complete',turn_id:'x'}},
];

test('the rollout parser recovers the assistant turns the stdout parser dropped',()=>{
  assert.equal(ROWS.filter(isCodexHistoryItem).length,3);
  const events=ROWS.flatMap(parseCodexHistoryRecord);
  const kinds=events.map((e:any)=>e.type);

  const assistant=events.filter((e:any)=>e.type==='assistant_message');
  assert.equal(assistant.length,1,'the Codex reply must appear exactly once');
  assert.equal((assistant[0] as any).text,'I will read the architecture.');

  const user=events.filter((e:any)=>e.type==='user_message');
  assert.equal(user.length,1,'the user line must not be doubled');
  assert.equal((user[0] as any).text,'review devhub');

  const cmd=events.find((e:any)=>e.type==='command_completed') as any;
  assert.equal(cmd.command,'/bin/zsh -lc cat SKILL.md','command is an argv array and must be joined');
  assert.equal(cmd.exitCode,0);
  assert.ok(cmd.output.includes('name: x'));

  assert.ok(kinds.includes('turn_done'),'task_complete = end of turn');
  assert.equal(kinds.includes('tool_completed'),false,'Reasoning is not a tool');
});

test('token_count is the only trustworthy source for the codex context ring',()=>{
  const usage=(ROWS.flatMap(parseCodexHistoryRecord).find((e:any)=>e.type==='usage') as any).usage;
  assert.equal(usage.contextWindowTokens,258400,'the window the CLI reports, not a guess');
  assert.equal(usage.contextUsedTokens,22105);
  assert.equal(usage.inputTokens,21880);
  assert.equal(usage.cachedInputTokens,12160);
});

test('a freshly compacted thread reports zero used, not an empty ring',()=>{
  const row={timestamp:'2026-09-08T05:00:00.000Z',type:'event_msg',payload:{type:'token_count',
    info:{total_token_usage:{total_tokens:603297},last_token_usage:{total_tokens:0},model_context_window:258400}}};
  const usage=(parseCodexHistoryRecord(row).find((e:any)=>e.type==='usage') as any).usage;
  assert.equal(usage.contextUsedTokens,0);
  assert.equal(usage.contextWindowTokens,258400);
});

test('an unusable record yields nothing instead of throwing',()=>{
  for(const bad of [null,undefined,{},{type:'event_msg'},{type:'event_msg',payload:{type:'item_completed'}}])
    assert.deepEqual(parseCodexHistoryRecord(bad),[]);
  assert.equal(isCodexHistoryItem(null),false);
});

test('a real transcript loads assistant text end to end, reading the tail of a big file',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-codex-hist-'));
  const file=path.join(dir,'rollout-t1.jsonl');
  // Pad the file past the read limit to prove the NEWEST part still shows.
  const filler=Array.from({length:400},(_,i)=>JSON.stringify({timestamp:'2026-09-08T04:00:00.000Z',type:'event_msg',
    payload:{type:'item_completed',item:{type:'AgentMessage',id:'old'+i,content:[{type:'Text',text:'old '+i}]}}}));
  await fs.writeFile(file,[...filler,...ROWS.map(r=>JSON.stringify(r))].join('\n')+'\n');

  const all=await loadCodexTranscript(file);
  assert.ok(all.some((e:any)=>e.type==='assistant_message'&&e.text==='I will read the architecture.'));

  const size=(await fs.stat(file)).size;
  const tail=await (await import('../../src/devhub/providers/historyUtils')).readJsonLines(file,Math.floor(size/4),'end');
  assert.ok(tail.length>0,'reading the tail must yield records');
  const tailEvents=tail.flatMap(parseCodexHistoryRecord);
  assert.ok(tailEvents.some((e:any)=>e.type==='assistant_message'&&e.text==='I will read the architecture.'),
    'the tail window must contain the newest turn');
  const head=await (await import('../../src/devhub/providers/historyUtils')).readJsonLines(file,Math.floor(size/4),'start');
  assert.equal(head.flatMap(parseCodexHistoryRecord).some((e:any)=>e.text==='I will read the architecture.'),false,
    'reading from the start loses exactly this part — the old bug');
});

test('context uses the latest model call, not the cumulative 603k total',()=>{
  const events=parseCodexHistoryRecord({type:'event_msg',payload:{type:'token_count',info:{
    total_token_usage:{total_tokens:603297},last_token_usage:{total_tokens:82883},model_context_window:364800}}});
  assert.equal((events[0] as any).usage.contextUsedTokens,82883);
});

test('missing latest usage never falls back to cumulative tokens',()=>{
  const events=parseCodexHistoryRecord({type:'event_msg',payload:{type:'token_count',info:{
    total_token_usage:{total_tokens:603297},model_context_window:364800}}});
  assert.equal((events[0] as any).usage.contextUsedTokens,undefined);
});

test('history snapshot exposes cumulative cache counters without changing the context snapshot',()=>{
  const events=ROWS.flatMap(parseCodexHistoryRecord);
  const usage=codexHistorySnapshot(events);
  assert.equal(usage.cachedInputTokens,12160);
  assert.equal(usage.inputTokens,21880);
  assert.equal(usage.contextUsedTokens,22105);
});

test('codex history keeps an image-gen extension result for replay',()=>{
  const events=parseCodexHistoryRecord({type:'event_msg',payload:{type:'item_completed',item:{
    type:'Extension',kind:'image_gen.generation',title:'image.png',result:'aGk='}}});
  assert.equal(events.length,1);
  assert.deepEqual(events[0],{type:'assistant_image',src:'data:image/png;base64,aGk=',alt:'image.png',timestamp:events[0].timestamp});
});

test('a rollout FileChange keeps one event per file, with real paths',()=>{
  const events=parseCodexHistoryRecord({type:'event_msg',payload:{type:'item_completed',item:{
    type:'FileChange',id:'exec-1',changes:{
      '/repo/src/a.ts':{type:'update',unified_diff:'@@'},
      '/repo/src/b.ts':{type:'add',unified_diff:'@@'}}}}}) as any[];
  assert.deepEqual(events.map(e=>[e.type,e.path,e.change]),
    [['file_changed','/repo/src/a.ts','modify'],['file_changed','/repo/src/b.ts','add']]);
});

test('a rollout McpToolCall replays its result text',()=>{
  const [ev]=parseCodexHistoryRecord({type:'event_msg',payload:{type:'item_completed',item:{
    type:'McpToolCall',id:'call_9',server:'docs',tool:'fetch',status:'completed',
    result:{content:[{type:'text',text:'ok'}],isError:false}}}}) as any[];
  assert.deepEqual([ev.type,ev.tool,ev.label,ev.summary,ev.callId],['tool_completed','docs','fetch','ok','call_9']);
});

test('an image the user attached survives a reload of the codex transcript',()=>{
  const p='/store/devhub/attachments/1-a.png';
  const [withText]=parseCodexHistoryRecord({type:'event_msg',payload:{type:'item_completed',item:{
    type:'UserMessage',id:'u1',content:[{type:'text',text:'look at this'},{type:'local_image',path:p}]}}}) as any[];
  assert.deepEqual([withText.text,withText.images],['look at this',[p]]);

  // An image-only message: `text.trim()` used to drop it entirely, the reopened transcript left no trace.
  const [imageOnly]=parseCodexHistoryRecord({type:'event_msg',payload:{type:'item_completed',item:{
    type:'UserMessage',id:'u2',content:[{type:'local_image',path:p}]}}}) as any[];
  assert.deepEqual([imageOnly.text,imageOnly.images],['',[p]]);
});

test('a pasted image with no file on disk keeps its data uri, the only copy there is',()=>{
  const src='data:image/png;base64,'+'A'.repeat(4096);
  const [ev]=parseCodexHistoryRecord({type:'event_msg',payload:{type:'item_completed',item:{
    type:'UserMessage',id:'u3',content:[{type:'text',text:'here is the image'},{type:'image',image_url:src}]}}}) as any[];
  assert.deepEqual([ev.text,ev.images],['here is the image',[src]]);
  // Junk is dropped: a stray string in `images` makes the webview draw a broken image tile.
  const [junk]=parseCodexHistoryRecord({type:'event_msg',payload:{type:'item_completed',item:{
    type:'UserMessage',id:'u4',content:[{type:'text',text:'x'},{type:'image',image_url:'http://evil/x.png'}]}}}) as any[];
  assert.equal(junk.images,undefined);
});

/** Real content of an old rollout: 1 image + 3 args that `codex exec` swallowed as local_image. */
test('argv the old build leaked into local_image is not shown as an image',()=>{
  const img='/Users/tyron/Library/Application Support/Code/User/globalStorage/local-devhub.dev-hub-claude-codex/devhub/attachments/1788855261816-8cc6c230.png';
  const [ev]=parseCodexHistoryRecord({type:'event_msg',payload:{type:'item_completed',item:{
    type:'UserMessage',id:'u5',content:[
      {type:'local_image',path:img},
      {type:'local_image',path:'resume'},
      {type:'local_image',path:'01a0800d-629a-7401-81f3-858089f408d1'},
      {type:'local_image',path:'-'},
      {type:'text',text:'check it'}]}}}) as any[];
  assert.deepEqual(ev.images,[img],'only an absolute path + image extension is drawn');
  assert.equal(ev.text,'check it');
});

test('a relative path or a non-image file is not an attachment',()=>{
  const [ev]=parseCodexHistoryRecord({type:'event_msg',payload:{type:'item_completed',item:{
    type:'UserMessage',id:'u6',content:[
      {type:'local_image',path:'shot.png'},
      {type:'local_image',path:'/tmp/notes.txt'},
      {type:'text',text:'x'}]}}}) as any[];
  assert.equal(ev.images,undefined);
});

/**
 * The rollout writes CamelCase (`SubAgentActivity`), exec stdout writes snake_case — the same
 * helper must take both, or the sub-agent vanishes when the transcript is reopened.
 */
test('a reopened transcript still shows the sub-agent, even one killed midway',()=>{
  const rec=(item:any)=>({timestamp:'2026-09-12T03:14:56.575Z',type:'event_msg',
    payload:{type:'item_completed',item}});
  const started=parseCodexHistoryRecord(rec({type:'SubAgentActivity',id:'call_G',kind:'started',
    agent_thread_id:'01a0939e',agent_path:'/root/fix_goal_state_review'}))[0] as any;
  assert.equal(started.type,'tool_started');
  assert.equal(started.label,'/root/fix_goal_state_review');
  const wait=parseCodexHistoryRecord(rec({type:'CollabAgentToolCall',id:'call_Y',tool:'wait',
    status:'completed',receiver_thread_ids:[]}))[0] as any;
  assert.equal(wait.label,'wait');
  // The child gets `turn_aborted: interrupted` when the parent process exits: there is never a
  // `completed` record. The row must STAY in the started state — that is the evidence.
  assert.equal(parseCodexHistoryRecord(rec({type:'SubAgentActivity',kind:'started',
    agent_thread_id:'01a0939e',agent_path:'/root/x'})).length,1);
});
