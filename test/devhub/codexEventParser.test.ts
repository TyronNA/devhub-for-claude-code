const test = require('node:test');
const assert = require('node:assert/strict');
import { parseCodexEvent } from '../../src/devhub/providers/codex/codexEventParser';

test('codex parser maps agent message, command, file and usage', () => {
  assert.equal(parseCodexEvent({type:'item.completed',item:{type:'agent_message',text:'done'}})[0].type, 'assistant_message');
  assert.equal(parseCodexEvent({type:'item.started',item:{type:'command_execution',command:'npm test'}})[0].type, 'command_started');
  assert.equal(parseCodexEvent({type:'item.completed',item:{type:'file_change',path:'/tmp/a.ts',kind:'modify'}})[0].type, 'file_changed');
  const events = parseCodexEvent({type:'turn.completed',usage:{input_tokens:80,cached_input_tokens:50,cache_write_input_tokens:4,output_tokens:20,reasoning_output_tokens:6}});
  assert.equal(events.some((e:any)=>e.type==='usage' && e.usage.outputTokens===20 && e.usage.cacheWriteInputTokens===4 && e.usage.reasoningOutputTokens===6), true);
  assert.equal(events.some((e:any)=>e.type==='turn_done'), true);
});

test('codex parser ignores unknown event', () => { assert.deepEqual(parseCodexEvent({type:'future'}), []); });

test('codex parser turns an image-gen extension result into an assistant image',()=>{
  const events=parseCodexEvent({type:'item.completed',item:{type:'Extension',kind:'image_gen.generation',title:'image.png',result:'aGk='}});
  assert.deepEqual(events,[{type:'assistant_image',src:'data:image/png;base64,aGk=',alt:'image.png',timestamp:events[0].timestamp}]);
});

test('a generated image travels as a path, not as 1.7MB of base64',()=>{
  const os=require('node:os');const path=require('node:path');
  const {codexImageEvent,codexImageRoot}=require('../../src/devhub/providers/codex/codexEventParser');
  const root=codexImageRoot();
  assert.equal(root,path.join(os.homedir(),'.codex','generated_images'));

  const saved=path.join(root,'thread-1','exec-1.png');
  const big='A'.repeat(2_000_000);
  const withPath=codexImageEvent({type:'Extension',kind:'image_gen.generation',result:big,savedPath:saved,title:'sprite.png'});
  assert.deepEqual(withPath,{type:'assistant_image',path:saved,alt:'sprite.png',timestamp:withPath.timestamp});
  assert.equal(withPath.src,undefined,'with a file on disk, no bytes go into the event');

  // Without savedPath it must still show — base64 is the fallback, not the main path.
  const fallback=codexImageEvent({type:'Extension',result:'aGk=',title:'image.png'});
  assert.equal(fallback.src,'data:image/png;base64,aGk=');
  assert.equal(fallback.path,undefined);
});

test('a savedPath outside the Codex image folder is refused',()=>{
  const path=require('node:path');
  const {codexImageEvent,codexImageRoot}=require('../../src/devhub/providers/codex/codexEventParser');
  const root=codexImageRoot();
  // localResourceRoots already blocks at the VS Code layer; this is a second layer, because the CLI supplies `savedPath`.
  const escape=path.join(root,'..','..','.ssh','id_rsa.png');
  assert.equal(codexImageEvent({type:'Extension',savedPath:escape,result:'aGk='}).src,'data:image/png;base64,aGk=',
    'outside the image folder falls back to base64, no path returned');
  assert.equal(codexImageEvent({type:'Extension',savedPath:path.join(root,'a','notes.txt'),result:'aGk='}).path,undefined,
    'only image extensions are accepted');
  assert.equal(codexImageEvent({type:'Extension',savedPath:'relative/x.png',result:'aGk='}).path,undefined,
    'a relative path cannot be trusted');
});

/** Real `changes` is a map path -> {type}, several files per record; reading it wrong gives an empty path. */
test('a live file_change carries every path in its changes map',()=>{
  const events=parseCodexEvent({type:'item.completed',item:{type:'file_change',id:'exec-1',changes:{
    '/repo/a.ts':{type:'update',unified_diff:'@@'},
    '/repo/b.ts':{type:'add',unified_diff:'@@'}}}});
  assert.deepEqual(events.map((e:any)=>[e.path,e.change]),[['/repo/a.ts','modify'],['/repo/b.ts','add']]);
});

test('a deleted file is not reported as modified',()=>{
  const [ev]=parseCodexEvent({type:'item.completed',item:{type:'file_change',changes:{'/repo/gone.ts':{type:'delete'}}}}) as any[];
  assert.equal(ev.change,'delete');
});

test('an mcp tool call shows up live, paired by callId',()=>{
  const started=parseCodexEvent({type:'item.started',item:{type:'mcp_tool_call',id:'call_1',server:'docs',tool:'search'}}) as any[];
  assert.deepEqual([started[0].type,started[0].tool,started[0].label,started[0].callId],['tool_started','docs','search','call_1']);
  const done=parseCodexEvent({type:'item.completed',item:{type:'mcp_tool_call',id:'call_1',server:'docs',tool:'search',
    status:'completed',result:{content:[{type:'text',text:'{"resources":[]}'}],isError:false}}}) as any[];
  assert.deepEqual([done[0].type,done[0].callId,done[0].summary],['tool_completed','call_1','{"resources":[]}']);
});

/**
 * Sub-agents (`spawn_agent`/`wait_agent`) used to match no branch: neither the spawn nor
 * the child's death produced a row, so `wait_agent` dragged on for 22 minutes with a silent UI.
 * Data taken from a real rollout on 2026-09-12 (CLI 0.154.0).
 */
test('a sub-agent that spawns and finishes gives exactly one row, paired by thread id',()=>{
  const started=parseCodexEvent({type:'item.completed',item:{type:'sub_agent_activity',
    id:'call_lNGs',kind:'started',agent_thread_id:'01a0937d',agent_path:'/root/impl'}}) as any[];
  assert.equal(started.length,1);
  assert.equal(started[0].type,'tool_started');
  assert.equal(started[0].label,'/root/impl');
  const done=parseCodexEvent({type:'item.completed',item:{type:'sub_agent_activity',
    id:'subagent-completed-01a0937d',kind:'completed',agent_thread_id:'01a0937d',agent_path:'/root/impl'}}) as any[];
  assert.equal(done[0].type,'tool_completed');
  // The two records have DIFFERENT `id`s; pairing by item id gives two separate rows.
  assert.equal(done[0].callId,started[0].callId,'must pair by thread id, not item id');
  assert.match(done[0].summary,/01a0937d/,'the child thread id is the only thing that traces back');
});

test('a kind that is not a lifecycle milestone gets its own row and does not overwrite a finished one',()=>{
  const done=parseCodexEvent({type:'item.completed',item:{type:'sub_agent_activity',
    kind:'completed',agent_thread_id:'t9',agent_path:'/root/x'}})[0] as any;
  const chat=parseCodexEvent({type:'item.completed',item:{type:'sub_agent_activity',
    kind:'interacted',agent_thread_id:'t9',agent_path:'/root/x'}})[0] as any;
  assert.ok(done.callId);
  assert.equal(chat.callId,undefined,'an interacted sharing the id would swallow the completed row');
});

test('a collab tool call shows the tool and the receiver, under both item namings',()=>{
  for(const type of ['collab_agent_tool_call','collab_tool_call','CollabAgentToolCall']){
    const ev=parseCodexEvent({type:'item.completed',item:{type,id:'call_1',tool:'wait',
      status:'completed',receiver_agents:['/root/impl']}})[0] as any;
    assert.equal(ev.type,'tool_completed',type);
    assert.equal(ev.tool,'Agent',type);
    assert.equal(ev.label,'wait /root/impl',type);
    assert.equal(ev.callId,'call_1',type);
  }
  const open=parseCodexEvent({type:'item.started',item:{type:'collab_agent_tool_call',id:'call_2',tool:'spawn_agent'}})[0] as any;
  assert.equal(open.type,'tool_started');
});
