const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
import { ProcessRunner } from '../../src/devhub/providers/processRunner';
import { codexWritableRoots, CodexProvider } from '../../src/devhub/providers/codex/codexProvider';
import { DevHubEvent } from '../../src/devhub/types';

/** Fake CLI that writes its whole argv to a file to check flags, then emits a minimal turn. */
async function argvCli(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-codex-argv-'));
  const out=path.join(dir,'argv.json');
  const file=path.join(dir,'codex');
  await fs.writeFile(file,`#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(out)},JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:'thread.started',thread_id:'t1'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,{mode:0o755});
  return {file,read:async()=>JSON.parse(await fs.readFile(out,'utf8')) as string[]};
}
async function drain(h:any){const e:any[]=[];for await(const x of h.events)e.push(x);return e;}
const SESSION:any={provider:'codex',nativeSessionId:'t1',workspaceId:'w',projectId:'p',
  cwd:os.tmpdir(),title:'t',status:'done',createdAt:1,updatedAt:1};

test('codex is launched with an explicit sandbox mode, or exec silently runs read-only',async()=>{
  const cli=await argvCli();
  const p=new CodexProvider(new ProcessRunner(),cli.file,10,undefined,undefined,'workspace-write');
  await drain(await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'hi'}));
  const argv=await cli.read();
  assert.ok(argv.includes('-c'),'sandbox goes through -c');
  assert.ok(argv.includes('sandbox_mode="workspace-write"'),
    '`codex exec` defaults to read-only + approval never: without the flag the agent can neither write files nor ask for access');
});

test('the sandbox flag rides on resume too, where -s does not exist',async()=>{
  const cli=await argvCli();
  const p=new CodexProvider(new ProcessRunner(),cli.file,10,undefined,undefined,'read-only');
  await drain(await p.resume({session:SESSION,prompt:'again'} as any));
  const argv=await cli.read();
  // `codex exec resume --help` (0.153.4) has NO -s/--sandbox; only `-c sandbox_mode` works on both.
  assert.equal(argv.includes('-s'),false);
  assert.equal(argv.includes('--sandbox'),false);
  assert.ok(argv.includes('sandbox_mode="read-only"'));
  assert.ok(argv.includes('resume')&&argv.includes('t1'));
});

test('an empty sandbox setting leaves the user config untouched',async()=>{
  const cli=await argvCli();
  const p=new CodexProvider(new ProcessRunner(),cli.file,10,undefined,undefined,'');
  await drain(await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'hi'}));
  assert.equal((await cli.read()).some(a=>a.startsWith('sandbox_mode=')),false);
});

test('pasted images are attached with -i, not glued into the prompt text',async()=>{
  const cli=await argvCli();
  const p=new CodexProvider(new ProcessRunner(),cli.file,10);
  await drain(await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'look at this',
    images:['/tmp/a.png','/tmp/b.png']} as any));
  const argv=await cli.read();
  assert.deepEqual(argv.filter((a,i)=>argv[i-1]==='-i'),['/tmp/a.png','/tmp/b.png']);
});

/** Fake app-server: speaks exactly the JSON-RPC `CodexAppServer` expects, notification order included. */
async function appServerCli(opts:{fail?:boolean;neverIdle?:boolean}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-as-'));
  const file=path.join(dir,'codex');
  await fs.writeFile(file,`#!/usr/bin/env node
const say=o=>console.log(JSON.stringify(o));
let buf='';
process.stdin.on('data',c=>{buf+=c;let i;
  while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
    if(!line.trim())continue;let m;try{m=JSON.parse(line)}catch{continue}
    if(m.method==='initialize'){say({id:m.id,result:{codexHome:'/tmp'}});
      // the idle from the resume: must NOT count as "compaction done".
      say({method:'thread/status/changed',params:{threadId:'t1',status:{type:'idle'}}});continue}
    // the REAL thread/resume returns no token usage — the fake must not either, or the
    // test would hide that the "pre-compaction level" must come from Dev Hub's usage.
    if(m.method==='thread/resume'){say({id:m.id,result:{thread:{id:'t1',turns:[]}}});continue}
    if(m.method==='thread/compact/start'){
      say({id:m.id,result:{}});
      ${opts.fail?`say({method:'thread/error',params:{threadId:'t1',message:'compaction failed'}});`:''}
      say({method:'thread/status/changed',params:{threadId:'t1',status:{type:'active'}}});
      say({method:'thread/tokenUsage/updated',params:{threadId:'t1',tokenUsage:{last:{totalTokens:9733},total:{totalTokens:122105},modelContextWindow:258400}}});
      ${opts.neverIdle?'':`say({method:'thread/status/changed',params:{threadId:'t1',status:{type:'idle'}}});`}
      continue}
  }});
`,{mode:0o755});
  return file;
}

test('clicking the context ring runs a real codex compaction and reports the shrink',async()=>{
  const exe=await appServerCli();
  const p=new CodexProvider(new ProcessRunner(),exe,10);
  const seen:DevHubEvent[]=[];
  const result=await p.compact({...SESSION,usage:{contextUsedTokens:22105}},e=>seen.push(e));
  assert.equal(result.beforeTokens,22105,'the pre-compaction level comes from the usage Dev Hub holds');
  assert.equal(result.afterTokens,9733);
  assert.equal(result.contextWindow,258400);

  const started=seen.find((e:any)=>e.type==='tool_started') as any;
  assert.equal(started.tool,'Compact','there must be progress, not 100 seconds of silence');
  const done=seen.find((e:any)=>e.type==='tool_completed') as any;
  assert.equal(done.summary,'22105 → 9733 tokens');
  const usage=seen.find((e:any)=>e.type==='usage') as any;
  assert.equal(usage.usage.contextUsedTokens,9733,'the context ring must drop right after compaction');
});

test('a compaction that never finishes times out instead of hanging the tab',async()=>{
  const exe=await appServerCli({neverIdle:true});
  const p=new CodexProvider(new ProcessRunner(),exe,10);
  const server=new (await import('../../src/devhub/providers/codex/codexAppServer')).CodexAppServer(new ProcessRunner(),exe);
  await assert.rejects(server.compact('t1',os.tmpdir(),()=>{},{timeoutMs:300}),/timed out/);
  void p;
});

test('a compaction error surfaces instead of pretending it worked',async()=>{
  const exe=await appServerCli({fail:true});
  const p=new CodexProvider(new ProcessRunner(),exe,10);
  await assert.rejects(p.compact(SESSION,()=>{}),/compaction failed/);
});

test('image arguments cannot swallow the resume command or stdin prompt',async()=>{
  const cli=await argvCli();
  const p=new CodexProvider(new ProcessRunner(),cli.file,10);
  for(const resume of [false,true]){
    const opts={prompt:'image prompt',images:['/tmp/a b.png','/tmp/b.png']};
    await drain(resume?await p.resume({session:SESSION,...opts}):await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),...opts}));
    const argv=await cli.read();
    const end=argv.indexOf('--');
    assert.ok(end>argv.lastIndexOf('-i'),'end image options before positional arguments');
    assert.equal(argv[end+1],'-','stdin prompt remains positional');
    if(resume)assert.ok(argv.indexOf('resume')<argv.indexOf('-i'),'resume images belong to resume parser');
  }
});

test('exec completion refreshes context from the rollout while keeping billing counters',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-context-'));
  try{
    await fs.mkdir(path.join(dir,'sessions'));
    const rollout=path.join(dir,'sessions','rollout-t1.jsonl');
    const cli=path.join(dir,'codex');
    const rows=[{type:'session_meta',payload:{id:'t1',cwd:dir}},
      {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:603297},last_token_usage:{total_tokens:82883},model_context_window:364800}}}];
    await fs.writeFile(cli,`#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(rollout)},${JSON.stringify(rows.map(r=>JSON.stringify(r)).join('\n')+'\n')});
console.log(JSON.stringify({type:'thread.started',thread_id:'t1'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:599419,output_tokens:3878}}));
`,{mode:0o755});
    const p=new CodexProvider(new ProcessRunner(),cli,10,dir);
    const events=await drain(await p.start({workspaceId:'w',projectId:'p',cwd:dir,prompt:'hi'}));
    const usage=events.filter((e:any)=>e.type==='usage').reduce((u:any,e:any)=>({...u,...e.usage}),{});
    assert.equal(usage.inputTokens,599419);assert.equal(usage.contextUsedTokens,82883);assert.equal(usage.contextWindowTokens,364800);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

/**
 * `codex exec --json` 0.153.4 has no item for image_gen images (the item enum only has
 * agent_message/reasoning/command_execution/file_change/mcp_tool_call/web_search/todo_list),
 * so images only show if the provider watches the folder itself — before, the whole turn had nothing.
 */
test('an image generated during an exec turn reaches the transcript before turn_done',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-imggen-'));
  try{
    const saved=path.join(dir,'generated_images','t1','exec-1.png');
    const cli=path.join(dir,'codex');
    await fs.writeFile(cli,`#!/usr/bin/env node
const fsx=require('node:fs');
console.log(JSON.stringify({type:'thread.started',thread_id:'t1'}));
fsx.mkdirSync(${JSON.stringify(path.dirname(saved))},{recursive:true});
fsx.writeFileSync(${JSON.stringify(saved)},'png');
console.log(JSON.stringify({type:'item.completed',item:{id:'i0',type:'agent_message',text:'xong'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,{mode:0o755});
    const p=new CodexProvider(new ProcessRunner(),cli,10,dir);
    const events=await drain(await p.start({workspaceId:'w',projectId:'p',cwd:dir,prompt:'draw it'}));
    const image=events.find((e:any)=>e.type==='assistant_image');
    assert.ok(image,'an image generated in the turn must become an event, not just sit on disk');
    assert.equal(image.path,saved,'travels as a path, not 3MB of base64 in the event');
    assert.ok(!image.src,'the host is where it turns into a webview URI');
    assert.ok(events.indexOf(image)<events.findIndex((e:any)=>e.type==='turn_done'),
      'the image must sit inside the turn, as when the transcript is reread');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('resuming a session does not re-emit images from earlier turns',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-imgold-'));
  try{
    const folder=path.join(dir,'generated_images','t1');
    await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,'exec-old.png'),'png');
    const cli=path.join(dir,'codex');
    await fs.writeFile(cli,`#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(path.join(folder,'exec-new.png'))},'png');
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,{mode:0o755});
    const p=new CodexProvider(new ProcessRunner(),cli,10,dir);
    const events=await drain(await p.resume({session:{...SESSION,cwd:dir},prompt:'more'} as any));
    const images=events.filter((e:any)=>e.type==='assistant_image');
    assert.deepEqual(images.map((e:any)=>path.basename(e.path)),['exec-new.png'],
      'only this turn\'s images; earlier ones are already in the transcript');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

/**
 * `codex exec` FORCES `approval_policy=never` (measured on 0.154.0: passing `on-request` directly
 * still records `never` in the rollout), so whatever the sandbox blocks just dies, with no permission step.
 * Writable roots open one door without removing the sandbox entirely.
 */
test('extra writable roots ride along on every turn, start and resume alike',async()=>{
  const cli=await argvCli();
  const roots=[path.join(os.tmpdir(),'devhub-extra')];
  const p=new CodexProvider(new ProcessRunner(),cli.file,10,undefined,undefined,'workspace-write',roots);
  await drain(await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'hi'}));
  assert.ok((await cli.read()).includes(`sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`),
    '-c values are parsed as TOML; a JSON array of strings is also a valid TOML array');
  await drain(await p.resume({session:SESSION,prompt:'again'} as any));
  assert.ok((await cli.read()).some((a:string)=>a.startsWith('sandbox_workspace_write.writable_roots=')),
    'resume is a new process too, its fence must be identical');
});

test('with no roots configured no flag is added',async()=>{
  const cli=await argvCli();
  const p=new CodexProvider(new ProcessRunner(),cli.file,10,undefined,undefined,'workspace-write');
  await drain(await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'hi'}));
  assert.equal((await cli.read()).some((a:string)=>a.includes('writable_roots')),false);
});

test('writable roots: expand ~, drop relative paths, dedupe',()=>{
  const home=os.homedir();
  assert.deepEqual(codexWritableRoots(['~/.codex']),[path.join(home,'.codex')]);
  // A relative path would resolve against EACH chat's cwd — a different fence per tab.
  assert.deepEqual(codexWritableRoots(['relative/dir','',' ',null,7]),[]);
  assert.deepEqual(codexWritableRoots(['/tmp/a','/tmp/a/','/tmp/a']),[path.resolve('/tmp/a')]);
  assert.equal(codexWritableRoots(Array.from({length:50},(_,i)=>`/tmp/r${i}`)).length,32);
});
