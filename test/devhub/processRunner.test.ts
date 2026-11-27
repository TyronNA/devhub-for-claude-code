const test = require('node:test');
const assert = require('node:assert/strict');
import { ProcessRunner } from '../../src/devhub/providers/processRunner';

test('process runner streams complete stdout lines and exit status', async () => {
  const runner = new ProcessRunner();
  const handle = runner.spawnLines({ command: process.execPath, args:['-e', "process.stdout.write('a\\npar');setTimeout(()=>process.stdout.write('tial\\n'),20)"], cwd:process.cwd() });
  const lines:string[]=[];
  for await (const line of handle.stdoutLines) lines.push(line);
  const result = await handle.exit;
  assert.deepEqual(lines, ['a','partial']);
  assert.equal(result.code, 0);
});

test('process runner cancel terminates child', async () => {
  const runner = new ProcessRunner();
  const handle = runner.spawnLines({ command: process.execPath, args:['-e', "setInterval(()=>{},1000)"], cwd:process.cwd() });
  await handle.cancel();
  const result = await handle.exit;
  assert.notEqual(result.signal, null);
});

for(const method of ['spawnLines','spawnDuplex'] as const){
  test(`${method} preserves UTF-8 split across chunks on both streams`,async()=>{
    const h=new ProcessRunner()[method]({command:process.execPath,cwd:process.cwd(),args:['-e',
      "const b=Buffer.from('ab😀');for(const s of [process.stdout,process.stderr])s.write(b.subarray(0,3));setTimeout(()=>{for(const s of [process.stdout,process.stderr])s.write(b.subarray(3));},80)"]});
    const collect=async(lines:AsyncIterable<string>)=>{const out=[];for await(const line of lines)out.push(line);return out};
    const [out,err]=await Promise.all([collect(h.stdoutLines),collect(h.stderrLines)]);
    await h.exit;assert.deepEqual(out,['ab😀']);assert.deepEqual(err,['ab😀']);
  });
}

test('spawnLines survives a CLI that exits before draining a big stdin',async()=>{
  // The threshold is the pipe buffer (64KB): below it the kernel takes everything and there is no EPIPE, so
  // the test must write well past it to reach the path that crashes the host.
  const h=new ProcessRunner().spawnLines({command:process.execPath,args:['-e','process.exit(3)'],
    cwd:process.cwd(),stdinText:'x'.repeat(256*1024)});
  const r=await h.exit;
  assert.equal(r.code,3,'EPIPE on stdin must be swallowed, the turn ends only by the CLI exit code');
});

for(const method of ['spawnLines','spawnDuplex'] as const){
  test(`${method} cancel kills the grandchild too, no orphaned background command left running`,async()=>{
    // The grandchild sits in its own process group (sh's `setsid`: `sh -mc`) exactly as Claude CLI runs Bash —
    // killing by pgid can't reach it, only walking ppid finds it.
    const h=new ProcessRunner()[method]({command:'/bin/sh',cwd:process.cwd(),
      args:['-mc','sleep 30 & echo $!; sleep 30']});
    let grandchild=0;
    for await(const line of h.stdoutLines){grandchild=Number(line.trim());break;}
    assert.ok(grandchild>0,'must read the background command\'s pid');
    assert.doesNotThrow(()=>process.kill(grandchild,0),'the grandchild must be alive before stopping');
    await h.cancel();
    assert.throws(()=>process.kill(grandchild,0),'the grandchild must die too, or it keeps running after the tab stopped');
  });
}

test('isAvailable: slower than the deadline still means present; only a spawn error or exit≠0 means missing', async () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'devhub-avail-'));
  const mk=(name:string,body:string)=>{const p=path.join(dir,name);fs.writeFileSync(p,'#!/bin/sh\n'+body+'\n');fs.chmodSync(p,0o755);return p;};
  const runner=new ProcessRunner();
  try{
    assert.equal(await runner.isAvailable(mk('slow','sleep 2; echo 1.0'),100),true,'a heavily loaded machine must not turn into "executable not found"');
    assert.equal(await runner.isAvailable(mk('fail','exit 1'),2000),false);
    assert.equal(await runner.isAvailable(path.join(dir,'missing'),2000),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
