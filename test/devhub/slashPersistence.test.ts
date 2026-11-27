const test=require('node:test');const assert=require('node:assert/strict');
import { ClaudeProvider } from '../../src/devhub/providers/claude/claudeProvider';
import { ProcessRunner } from '../../src/devhub/providers/processRunner';

/** After Reload Window `sessions` is empty — caching only in RAM leaves `/` dead until the next turn. */
test('the slash list survives a reload by falling back to the store',()=>{
  const p=new ClaudeProvider(new ProcessRunner(),'claude',10);
  let saved:string[]=[];
  p.setSlashStore(()=>['commit','review','usage'],v=>{saved=v});
  assert.deepEqual(p.slashCommands(),['commit','review','usage'],'with no live session there must still be a list');
  assert.deepEqual(p.slashCommands('does-not-exist'),['commit','review','usage']);
  assert.deepEqual(saved,[],'nothing new seen means the store is not overwritten');
  p.dispose();
});

test('a live session overwrites the stored list and writes it back once',()=>{
  const p=new ClaudeProvider(new ProcessRunner(),'claude',10);
  const writes:string[][]=[];
  p.setSlashStore(()=>['old'],v=>writes.push(v));
  (p as any).sessions.set('s1',{slashCommands:['a','b'],alive:()=>true,close:async()=>{}});
  assert.deepEqual(p.slashCommands('s1'),['a','b']);
  assert.deepEqual(writes,[['a','b']],'written exactly once');
  p.slashCommands('s1');p.slashCommands();
  assert.equal(writes.length,1,'an unchanged value is not written again');
  p.dispose();
});

test('an empty store is harmless',()=>{
  const p=new ClaudeProvider(new ProcessRunner(),'claude',10);
  p.setSlashStore(()=>undefined as any,()=>{});
  assert.deepEqual(p.slashCommands(),[]);
  p.dispose();
});
