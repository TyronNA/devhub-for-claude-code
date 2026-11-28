const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
import { ProcessRunner } from '../../src/devhub/providers/processRunner';
import { ClaudeProvider } from '../../src/devhub/providers/claude/claudeProvider';
import { CodexProvider } from '../../src/devhub/providers/codex/codexProvider';

async function fakeCli(kind:'claude'|'codex'){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-cli-'));const file=path.join(dir,kind);
  const code=kind==='claude'?`#!/usr/bin/env node
const a=process.argv.slice(2);
if(!a.includes('--include-partial-messages')){console.error('missing partial flag');process.exit(23)}
let id='claude-new';const r=a.indexOf('--resume'),n=a.indexOf('--session-id');if(r>=0)id=a[r+1];else if(n>=0)id=a[n+1];
let buf='';
process.stdin.on('data',c=>{buf+=c;let i;
  while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
    if(!line.trim())continue;let m;try{m=JSON.parse(line)}catch{continue}
    if(m.type!=='user')continue;
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'ok'}]}}));
    console.log(JSON.stringify({type:'result',subtype:'success',session_id:id,usage:{input_tokens:4,output_tokens:2}}));
  }});
process.stdin.on('end',()=>process.exit(0));`:`#!/usr/bin/env node\nconst a=process.argv.slice(2);let id='codex-new';const r=a.indexOf('resume');if(r>=0)id=a[r+1];console.log(JSON.stringify({type:'thread.started',thread_id:id}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:3}}));`;
  await fs.writeFile(file,code,{mode:0o755});return file;
}
async function collect(handle:any){const events=[];for await(const e of handle.events)events.push(e);return events;}
// A resident session keeps the child process alive; the test must close it or node won't exit.
const live:any[]=[];
function track<T>(p:T):T{live.push(p);return p}
test.after(()=>{for(const p of live)(p as any).dispose&&(p as any).dispose()});

test('Claude provider starts and resumes native session through JSONL transport',async()=>{
  const exe=await fakeCli('claude');const p=track(new ClaudeProvider(new ProcessRunner(),exe,10));const h=await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'hello'});const id=h.getNativeSessionId();const e=await collect(h);assert.equal(h.getNativeSessionId(),id);assert.equal(e.some((x:any)=>x.type==='assistant_message'),true);assert.equal(e.some((x:any)=>x.type==='usage'&&x.usage.inputTokens===4),true);const r=await p.resume({session:{provider:'claude',nativeSessionId:id,workspaceId:'w',projectId:'p',cwd:os.tmpdir(),title:'t',status:'done',createdAt:1,updatedAt:1},prompt:'again'} as any);await collect(r);assert.equal(r.getNativeSessionId(),id);
});

test('Codex provider captures thread id and resumes it',async()=>{
  const exe=await fakeCli('codex');const p=new CodexProvider(new ProcessRunner(),exe,10);const h=await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'hello'});const e=await collect(h);assert.equal(h.getNativeSessionId(),'codex-new');assert.equal(e.some((x:any)=>x.type==='usage'&&x.usage.inputTokens===5),true);const r=await p.resume({session:{provider:'codex',nativeSessionId:'codex-new',workspaceId:'w',projectId:'p',cwd:os.tmpdir(),title:'t',status:'done',createdAt:1,updatedAt:1},prompt:'again'} as any);await collect(r);assert.equal(r.getNativeSessionId(),'codex-new');
});

test('provider prompt never reaches argv and cannot trigger shell interpolation',async()=>{
  const exe=await fakeCli('claude');const sentinel=path.join(os.tmpdir(),`devhub-shell-${Date.now()}`);const p=track(new ClaudeProvider(new ProcessRunner(),exe,10));
  const h=await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:`$(touch ${sentinel})`});await collect(h);
  await assert.rejects(fs.stat(sentinel));
});
