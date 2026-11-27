const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
import { ProcessRunner } from '../../src/devhub/providers/processRunner';
import { ClaudeProvider } from '../../src/devhub/providers/claude/claudeProvider';
import { SessionManager } from '../../src/devhub/sessions/sessionManager';
import { SessionStore } from '../../src/devhub/storage/sessionStore';
import { DevHubSession } from '../../src/devhub/types';

const live:any[]=[];
test.after(()=>{for(const p of live)p.dispose?.()});
function track<T>(p:T):T{live.push(p);return p}

/**
 * CLI giả chạy `delayMs` rồi mới phát `result`. Dùng để chứng minh hẹn giờ idle không được
 * đóng process trong lúc lượt còn chạy.
 */
async function slowClaude(delayMs:number,opts:{dieMidTurn?:boolean}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-slow-'));
  const file=path.join(dir,'claude');
  await fs.writeFile(file,`#!/usr/bin/env node
const a=process.argv.slice(2);
let id='c1';const r=a.indexOf('--resume'),n=a.indexOf('--session-id');
if(r>=0)id=a[r+1];else if(n>=0)id=a[n+1];
let buf='';
process.stdin.on('data',c=>{buf+=c;let i;
  while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
    if(!line.trim())continue;let m;try{m=JSON.parse(line)}catch{continue}
    if(m.type!=='user')continue;
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
    ${opts.dieMidTurn
      ? `console.error('claude: out of memory');process.exit(9);`
      : `setTimeout(()=>{console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'ok'}]}}));
           console.log(JSON.stringify({type:'result',subtype:'success',session_id:id,usage:{input_tokens:1,output_tokens:1}}));},${delayMs});`}
  }});
process.stdin.on('end',()=>{});
`,{mode:0o755});
  return file;
}
async function drain(h:any){const e:any[]=[];for await(const x of h.events)e.push(x);return e;}

test('the idle timeout never closes a session that is still running a turn',async()=>{
  const exe=await slowClaude(400);
  // TTL 40ms, lượt dài 400ms: cách cũ đặt hẹn giờ TRƯỚC send() nên nó kill process giữa lượt.
  const p=track(new ClaudeProvider(new ProcessRunner(),exe,10,undefined,undefined,undefined,40));
  const h=await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'hello'});
  const events=await drain(h);
  assert.ok(events.some((e:any)=>e.type==='turn_done'),'lượt phải chạy hết, không bị cắt giữa đường');
  assert.equal(events.some((e:any)=>e.type==='error'),false,'không được có lỗi nào');
});

test('a claude process that dies mid-turn is reported as a failure, not a finished turn',async()=>{
  const exe=await slowClaude(0,{dieMidTurn:true});
  const p=track(new ClaudeProvider(new ProcessRunner(),exe,10));
  const events=await drain(await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'hello'}));
  // Trước đây pump() resolve lượt trong `finally` -> manager đánh dấu 'done' cho lượt chưa chạy.
  const err=events.find((e:any)=>e.type==='error') as any;
  assert.ok(err,'phải phát error');
  assert.ok(/exited before finishing/.test(err.message),err.message);
  assert.ok(/out of memory/.test(err.message),'đuôi stderr phải đi kèm để chẩn đoán được');
  assert.equal(events.some((e:any)=>e.type==='turn_done'),false);
});

test('cancelling a turn is not reported as a crash',async()=>{
  const exe=await slowClaude(60_000);
  const p=track(new ClaudeProvider(new ProcessRunner(),exe,10));
  const h=await p.start({workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'hello'});
  const t:any=setTimeout(()=>void h.cancel(),150); t.unref?.();
  const events=await drain(h);
  assert.equal(events.some((e:any)=>e.type==='error'),false,'người dùng bấm Stop không phải lỗi');
});

// ---------- giới hạn concurrent ----------

function stubProvider(gateMs:number){
  return {
    id:'claude' as const,
    async isAvailable(){await new Promise(r=>setTimeout(r,gateMs));return true;},
    async start(){return handle();},
    async resume(){return handle();},
    async discoverHistory(){return [];},
    async loadTranscript(){return [];},
  };
  function handle(){
    let release:(()=>void)|undefined;
    const gate=new Promise<void>(r=>{release=r;});
    const events=(async function*(){await gate;})();
    (events as any).release=release;
    return {events,cancel:async()=>{release?.();},getNativeSessionId:()=>'n'+(++seq)};
  }
}
let seq=0;

async function store(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'devhub-store-'));
  return new SessionStore(dir);
}
const INPUT={provider:'claude' as const,workspaceId:'w',projectId:'p',cwd:os.tmpdir(),prompt:'x'};

test('the concurrency limit holds even when starts race through the await window',async()=>{
  // Cách cũ đếm `active.size` TRƯỚC nhiều await; ba lệnh start cùng lọt qua cửa "limit = 1".
  const m=new SessionManager(await store(),{claude:stubProvider(30)} as any,1);
  const results=await Promise.allSettled([m.start(INPUT),m.start(INPUT),m.start(INPUT)]);
  const ok=results.filter(r=>r.status==='fulfilled');
  const rejected=results.filter(r=>r.status==='rejected');
  assert.equal(ok.length,1,'chỉ một lượt được chạy');
  assert.equal(rejected.length,2);
  assert.ok(/already running 1 turns/.test(String((rejected[0] as any).reason?.message)));
  assert.equal(m.runningCount(),1);
  await m.cancelAll();
});

test('two resumes cannot pile onto the same session',async()=>{
  const m=new SessionManager(await store(),{claude:stubProvider(30)} as any,4);
  const session:DevHubSession={provider:'claude',nativeSessionId:'same',workspaceId:'w',projectId:'p',
    cwd:os.tmpdir(),title:'t',status:'done',createdAt:1,updatedAt:1};
  const results=await Promise.allSettled([m.resume(session,'a'),m.resume(session,'b')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(/already running a turn/.test(String((results.find(r=>r.status==='rejected') as any).reason?.message)));
  await m.cancelAll();
});
