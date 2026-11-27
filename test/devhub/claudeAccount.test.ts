const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
import { altRootFor, readAltRoots, toggleAltRoot } from '../../src/devhub/providers/claude/claudeAccount';
const {ClaudeProvider}=require('../../src/devhub/providers/claude/claudeProvider');

function tmp(){const d=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'devhub-acct-')));
  for(const x of ['work/a','work/a/sub','game/b'])fs.mkdirSync(path.join(d,x),{recursive:true});return d;}

test('bật rồi tắt acc phụ cho một project, giữ comment và dòng khác',()=>{
  const d=tmp();const f=path.join(d,'cfg/roots');const a=path.join(d,'work/a'),b=path.join(d,'game/b');
  fs.mkdirSync(path.dirname(f));fs.writeFileSync(f,`# acc phụ\n${a}\n`);
  assert.equal(altRootFor(f,path.join(a,'sub')),a,'thư mục con ăn theo dòng cha');
  assert.equal(altRootFor(f,b),undefined);
  assert.deepEqual(toggleAltRoot(f,b),{alt:true});assert.equal(altRootFor(f,b),b);
  assert.deepEqual(toggleAltRoot(f,b),{alt:false});assert.equal(altRootFor(f,b),undefined);
  assert.equal(fs.readFileSync(f,'utf8'),`# acc phụ\n${a}\n`,'tắt trả file về y nguyên');
});

test('project nằm dưới dòng cha: không ghi thêm, báo inherited',()=>{
  const d=tmp();const f=path.join(d,'roots');const a=path.join(d,'work/a');fs.writeFileSync(f,a+'\n');
  assert.deepEqual(toggleAltRoot(f,path.join(a,'sub')),{alt:true,inherited:a});
  assert.deepEqual(readAltRoots(f),[a]);
});

test('so bằng realpath như `pwd -P` của wrapper',()=>{
  const d=tmp();const f=path.join(d,'roots');const link=path.join(d,'link');fs.symlinkSync(path.join(d,'game/b'),link);
  toggleAltRoot(f,link);assert.equal(altRootFor(f,path.join(d,'game/b')),path.join(d,'game/b'));
});

test('file chưa có: tạo khi bật, đọc rỗng khi chưa bật',()=>{
  const d=tmp();const f=path.join(d,'new/dir/roots');
  assert.deepEqual(readAltRoots(f),[]);assert.deepEqual(toggleAltRoot(f,path.join(d,'game/b')),{alt:true});
});

function countingRunner(){
  const spawns:string[]=[];
  return {spawns,runner:{isAvailable:async()=>true,spawnDuplex(o:any){spawns.push(o.cwd);
    const lines:string[]=[];let wake:any;let done=false;const push=(v:any)=>{lines.push(JSON.stringify(v));wake?.();};
    return {alive:()=>!done,pid:spawns.length,
      write(line:string){if(JSON.parse(line).type!=='user')return true;
        push({type:'system',subtype:'init',session_id:'acct-1',slash_commands:[]});push({type:'result',subtype:'success'});return true;},
      stdoutLines:(async function*(){while(!done){if(lines.length)yield lines.shift();else await new Promise(r=>wake=r);}})(),
      stderrLines:(async function*(){})(),cancel:async()=>{done=true;wake?.();}};}}};
}

test('đổi acc: process đang sống được spawn lại ở lượt kế, project khác không bị đụng',async()=>{
  const d=tmp();const c=countingRunner();const p=new ClaudeProvider(c.runner,'claude',10,undefined,undefined,undefined,0);
  const cwd=path.join(d,'game/b');const drain=async(h:any)=>{for await(const _ of h.events){}await new Promise(r=>setTimeout(r,10));};   // chờ rekey `pending` → id thật
  try{
    const h=await p.start({cwd,prompt:'1'});await drain(h);
    const session:any={provider:'claude',nativeSessionId:h.getNativeSessionId(),cwd};
    await drain(await p.resume({session,prompt:'2'}));assert.equal(c.spawns.length,1,'không đổi gì thì giữ process');
    assert.equal(p.retireUnder(path.join(d,'work')),0,'root khác không đánh dấu ai');
    assert.equal(p.retireUnder(cwd),1);
    await drain(await p.resume({session,prompt:'3'}));assert.equal(c.spawns.length,2,'lượt kế phải spawn lại qua wrapper');
    await drain(await p.resume({session,prompt:'4'}));assert.equal(c.spawns.length,2,'chỉ spawn lại một lần');
  }finally{p.dispose();}
});
