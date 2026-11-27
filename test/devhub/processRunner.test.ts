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
      "const b=Buffer.from('Việt 😀');for(const s of [process.stdout,process.stderr])s.write(b.subarray(0,3));setTimeout(()=>{for(const s of [process.stdout,process.stderr])s.write(b.subarray(3));},80)"]});
    const collect=async(lines:AsyncIterable<string>)=>{const out=[];for await(const line of lines)out.push(line);return out};
    const [out,err]=await Promise.all([collect(h.stdoutLines),collect(h.stderrLines)]);
    await h.exit;assert.deepEqual(out,['Việt 😀']);assert.deepEqual(err,['Việt 😀']);
  });
}

test('spawnLines survives a CLI that exits before draining a big stdin',async()=>{
  // Ngưỡng là buffer pipe (64KB): dưới đó kernel nhận hết và không có EPIPE nào cả, nên
  // test phải ghi hẳn vượt qua nó mới chạm được đường làm sập host.
  const h=new ProcessRunner().spawnLines({command:process.execPath,args:['-e','process.exit(3)'],
    cwd:process.cwd(),stdinText:'x'.repeat(256*1024)});
  const r=await h.exit;
  assert.equal(r.code,3,'EPIPE trên stdin phải bị nuốt, lượt chỉ kết thúc theo exit code của CLI');
});

for(const method of ['spawnLines','spawnDuplex'] as const){
  test(`${method} cancel giết cả cháu, không để lệnh nền sống mồ côi`,async()=>{
    // Cháu đặt ở process group riêng (`setsid` của sh: `sh -mc`) đúng như Claude CLI chạy Bash —
    // kill theo pgid không với tới nó, chỉ duyệt ppid mới thấy.
    const h=new ProcessRunner()[method]({command:'/bin/sh',cwd:process.cwd(),
      args:['-mc','sleep 30 & echo $!; sleep 30']});
    let grandchild=0;
    for await(const line of h.stdoutLines){grandchild=Number(line.trim());break;}
    assert.ok(grandchild>0,'phải đọc được pid của lệnh nền');
    assert.doesNotThrow(()=>process.kill(grandchild,0),'cháu phải đang sống trước khi dừng');
    await h.cancel();
    assert.throws(()=>process.kill(grandchild,0),'cháu phải chết theo, nếu không nó chạy tiếp sau khi tab đã dừng');
  });
}

test('isAvailable: chậm quá hạn vẫn là có; chỉ spawn lỗi hoặc exit≠0 mới là không có', async () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'devhub-avail-'));
  const mk=(name:string,body:string)=>{const p=path.join(dir,name);fs.writeFileSync(p,'#!/bin/sh\n'+body+'\n');fs.chmodSync(p,0o755);return p;};
  const runner=new ProcessRunner();
  try{
    assert.equal(await runner.isAvailable(mk('slow','sleep 2; echo 1.0'),100),true,'máy tải cao không được thành "executable not found"');
    assert.equal(await runner.isAvailable(mk('fail','exit 1'),2000),false);
    assert.equal(await runner.isAvailable(path.join(dir,'missing'),2000),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
