const test=require('node:test');const assert=require('node:assert/strict');
import { ClaudeProvider } from '../../src/devhub/providers/claude/claudeProvider';
import { ProcessRunner } from '../../src/devhub/providers/processRunner';

/** Sau Reload Window, `sessions` rỗng — nếu chỉ cache trong RAM thì `/` chết cho tới lượt kế. */
test('the slash list survives a reload by falling back to the store',()=>{
  const p=new ClaudeProvider(new ProcessRunner(),'claude',10);
  let saved:string[]=[];
  p.setSlashStore(()=>['commit','review','usage'],v=>{saved=v});
  assert.deepEqual(p.slashCommands(),['commit','review','usage'],'không có session sống vẫn phải có danh sách');
  assert.deepEqual(p.slashCommands('không-tồn-tại'),['commit','review','usage']);
  assert.deepEqual(saved,[],'chưa thấy gì mới thì không ghi đè store');
  p.dispose();
});

test('a live session overwrites the stored list and writes it back once',()=>{
  const p=new ClaudeProvider(new ProcessRunner(),'claude',10);
  const writes:string[][]=[];
  p.setSlashStore(()=>['cũ'],v=>writes.push(v));
  (p as any).sessions.set('s1',{slashCommands:['a','b'],alive:()=>true,close:async()=>{}});
  assert.deepEqual(p.slashCommands('s1'),['a','b']);
  assert.deepEqual(writes,[['a','b']],'ghi đúng một lần');
  p.slashCommands('s1');p.slashCommands();
  assert.equal(writes.length,1,'giá trị không đổi thì không ghi lại');
  p.dispose();
});

test('an empty store is harmless',()=>{
  const p=new ClaudeProvider(new ProcessRunner(),'claude',10);
  p.setSlashStore(()=>undefined as any,()=>{});
  assert.deepEqual(p.slashCommands(),[]);
  p.dispose();
});
