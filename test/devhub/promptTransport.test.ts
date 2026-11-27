const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
import { ProcessRunner } from '../../src/devhub/providers/processRunner';
import { ClaudeProvider } from '../../src/devhub/providers/claude/claudeProvider';
import { HistoryScanCache, boundedSet } from '../../src/devhub/providers/historyUtils';
import { discoverClaudeHistory } from '../../src/devhub/providers/claude/claudeHistory';

/** A fake CLI: writes argv + stdin to a file so the test can see which path the prompt took. */
/** A fake CLI speaking two-way stream-json: records argv + prompt, then emits `result` so the turn ends. */
async function echoCli(dump:string){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-echo-'));const file=path.join(dir,'cli');
  await fs.writeFile(file,`#!/usr/bin/env node
const a=process.argv.slice(2);
let buf='';
process.stdin.on('data',c=>{buf+=c;let i;
  while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
    if(!line.trim())continue;let m;try{m=JSON.parse(line)}catch{continue}
    if(m.type!=='user')continue;
    const text=(m.message.content||[]).map(x=>x.text).join('');
    require('fs').writeFileSync(${JSON.stringify(dump)},JSON.stringify({argv:a,stdin:text}));
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:'x'}));
    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'ok'}]}}));
    console.log(JSON.stringify({type:'result',subtype:'success',session_id:'x'}));
  }});
process.stdin.on('end',()=>process.exit(0));`,{mode:0o755});
  return file;
}
async function drain(h:any){const o=[];for await(const e of h.events)o.push(e);return o;}
// A resident session keeps the child process alive; the test must close it or node won't exit.
const live:any[]=[];
function track<T>(p:T):T{live.push(p);return p}
test.after(()=>{for(const p of live)p.dispose&&p.dispose()});

test('Claude prompt travels on stdin and is absent from argv',async()=>{
  const dump=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'devhub-d-')),'d.json');
  const exe=await echoCli(dump);const secret='PROMPT-SECRET-e2e';
  await drain(await track(new ClaudeProvider(new ProcessRunner(),exe,10)).start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:secret} as any));
  const got=JSON.parse(await fs.readFile(dump,'utf8'));
  assert.equal(got.stdin,secret,'the prompt must reach the CLI via stdin');
  assert.equal(got.argv.some((a:string)=>a.includes(secret)),false,'the prompt must NOT be in argv (visible through ps)');
});

test('permissionMode is forwarded only when configured',async()=>{
  const d1=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'devhub-d-')),'d.json');
  await drain(await track(new ClaudeProvider(new ProcessRunner(),await echoCli(d1),10,undefined,'acceptEdits')).start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'x'} as any));
  const a=JSON.parse(await fs.readFile(d1,'utf8')).argv;
  assert.equal(a.includes('--permission-mode'),true);
  assert.equal(a[a.indexOf('--permission-mode')+1],'acceptEdits');

  const d2=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'devhub-d-')),'d.json');
  await drain(await track(new ClaudeProvider(new ProcessRunner(),await echoCli(d2),10)).start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'x'} as any));
  assert.equal(JSON.parse(await fs.readFile(d2,'utf8')).argv.includes('--permission-mode'),false,'not set means no flag sent');
});

test('history scan cache skips re-reading a file whose mtime and size are unchanged',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-hist-'));
  const dir=path.join(root,'projects','p');await fs.mkdir(dir,{recursive:true});
  const cwd=await fs.realpath(os.tmpdir());
  const f=path.join(dir,'11111111-1111-1111-1111-111111111111.jsonl');
  const row=(t:string)=>JSON.stringify({type:'user',cwd,sessionId:'11111111-1111-1111-1111-111111111111',timestamp:'2026-01-01T00:00:00Z',message:{content:t}});
  await fs.writeFile(f,row('AAAA')+'\n');
  // utimes is only ms-precise; pin mtime BEFORE the first scan so the two stats compare equal.
  const pinned=new Date(1767225600000);
  await fs.utimes(f,pinned,pinned);
  const projects=[{id:'p',workspaceId:'w',name:'p',rootPath:cwd}] as any;
  const cache=new HistoryScanCache<any>();

  const first=await discoverClaudeHistory(projects,root,50,new Map(),cache);
  assert.equal(first[0].title,'AAAA');

  // Write different content BUT keep size + mtime -> a cache hit must return the old title.
  await fs.writeFile(f,row('BBBB')+'\n');
  await fs.utimes(f,pinned,pinned);
  const second=await discoverClaudeHistory(projects,root,50,new Map(),cache);
  assert.equal(second[0].title,'AAAA','cache hit => the file is not re-read');

  // Change mtime -> must re-read.
  const later=new Date(pinned.getTime()+60000);
  await fs.utimes(f,later,later);
  const third=await discoverClaudeHistory(projects,root,50,new Map(),cache);
  assert.equal(third[0].title,'BBBB','mtime changed => re-read');
});

test('bounded maps evict oldest entries instead of growing without limit',async()=>{
  const m=new Map<string,string>();
  for(let i=0;i<10;i++) boundedSet(m,'k'+i,'v'+i,4);
  assert.equal(m.size,4);
  assert.equal(m.has('k0'),false);
  assert.equal(m.has('k9'),true);
  const c=new HistoryScanCache<number>(2);
  c.set('a',{mtimeMs:1,size:1},1);c.set('b',{mtimeMs:1,size:1},2);c.set('c',{mtimeMs:1,size:1},3);
  assert.equal(c.size,2);
  assert.equal(c.get('a',{mtimeMs:1,size:1}).hit,false);
  assert.equal(c.get('c',{mtimeMs:1,size:1}).hit,true);
});

test('system prompt setting reaches Claude with its flag',async()=>{
  const d1=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'devhub-d-')),'d.json');
  await drain(await track(new ClaudeProvider(new ProcessRunner(),await echoCli(d1),10,undefined,undefined,'BE TERSE'))
    .start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'x'} as any));
  const a=JSON.parse(await fs.readFile(d1,'utf8')).argv;
  assert.equal(a.includes('--append-system-prompt'),true);
  assert.equal(a[a.indexOf('--append-system-prompt')+1],'BE TERSE');
  // The append flag turns the snapshot off itself; without turning it back on every old chat changes system prompt on its next resume.
  assert.equal(a[a.indexOf('--system-prompt-snapshot')+1],'on');

  const d3=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'devhub-d-')),'d.json');
  await drain(await track(new ClaudeProvider(new ProcessRunner(),await echoCli(d3),10)).start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'x'} as any));
  const c3=JSON.parse(await fs.readFile(d3,'utf8')).argv;
  assert.equal(c3.includes('--append-system-prompt'),false,'not set means not sent');
  assert.equal(c3.includes('--system-prompt-snapshot'),false,'without append the snapshot stays the CLI default');
});
